// server.js
// ---------------------------------------------------------
// Minimal signaling server for a 1:1 WebRTC video call app.
//
// What this server does:
//   - Serves the static frontend (public/)
//   - Relays WebRTC signaling messages (SDP offer/answer, ICE candidates)
//     between exactly 2 peers who join the same "room" code.
//
// What this server deliberately does NOT do:
//   - No database, no disk writes, no logs of call content
//   - No accounts, no contacts list, no call history
//   - Never sees or touches actual audio/video (that's peer-to-peer,
//     encrypted with DTLS-SRTP by WebRTC itself)
//
// Rooms live only in memory (a JS Map) and are deleted the moment
// both participants leave or the process restarts. Nothing persists.
// ---------------------------------------------------------

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
// Bind to loopback only by default — this app is meant to sit behind nginx
// (like your other services), never exposed directly on the instance's
// public IP even if the security group is ever misconfigured. Only widen
// this if you have a specific reason to (e.g. a container network).
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "public");

// ---- Origin allowlist ----
// Comma-separated list of origins allowed to open a signaling connection,
// e.g. ALLOWED_ORIGINS="https://call.yourdomain.com,https://staging.yourdomain.com"
// Defaults to permissive localhost origins for local development only.
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function isOriginAllowed(origin) {
  // No Origin header at all (e.g. some non-browser clients) — reject by default.
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin);
}

// ---- STUN/TURN (ICE) config ----
// The browser needs to know which STUN/TURN servers to use. Serving this
// from an HTTP endpoint keeps TURN credentials in server env vars only —
// they are never baked into the JS bundle. (Note: the browser must receive
// credentials to use a TURN relay, so anyone can fetch this endpoint;
// consider short-lived HMAC credentials via coturn's "use-auth-secret" if
// that matters for your threat model. See README.)
const STUN_URLS = (process.env.STUN_URLS || "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TURN_URL = (process.env.TURN_URL || "").trim();
const TURN_USERNAME = process.env.TURN_USERNAME || "";
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || "";

function iceConfig() {
  const iceServers = [];
  if (STUN_URLS.length > 0) iceServers.push({ urls: STUN_URLS });
  if (TURN_URL) {
    const turn = { urls: TURN_URL.split(",").map((s) => s.trim()).filter(Boolean) };
    if (turn.urls.length > 0) {
      if (TURN_USERNAME) turn.username = TURN_USERNAME;
      if (TURN_CREDENTIAL) turn.credential = TURN_CREDENTIAL;
      iceServers.push(turn);
    }
  }
  return { iceServers };
}

// Room TTL: how long a room can sit with only 1 peer before it's cleaned up.
const ROOM_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Heartbeat interval: how often to ping clients to detect dead connections.
const HEARTBEAT_MS = 30 * 1000; // 30 seconds

// Simple per-IP rate limit for room joins/creates.
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_JOINS = 20; // generous, but stops flooding

// Behind a reverse proxy (nginx/Caddy) every TCP connection shares the
// proxy's address, so per-IP rate limiting would clamp ALL users into one
// shared bucket. If your proxy sends x-forwarded-for, set TRUST_PROXY=1 to
// key the limiter on the real client address instead. Only do this for a
// proxy you control — the header is trivially spoofed otherwise.
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress;
}

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

// ---- Security headers ----
// Sent by the app itself so a bare `npm start` deploy (no reverse proxy)
// is still reasonably hardened. A TLS-terminating proxy may add more.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:", // favicon is a canvas data URL
  "media-src 'self' blob:", // WebRTC media streams
  "connect-src 'self' ws: wss:", // signaling WebSocket
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function applySecurityHeaders(req, res) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self)");
  // HSTS is only meaningful over HTTPS. When TLS is terminated at a proxy,
  // x-forwarded-proto tells us the client-facing scheme.
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  if (forwardedProto === "https" || req.socket.encrypted) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

// ---- Static file server ----
const server = http.createServer((req, res) => {
  applySecurityHeaders(req, res);
  let filePath = req.url.split("?")[0]; // strip query string first

  // Browser fetches STUN/TURN server list before creating its peer
  // connection (see loadIceConfig() in public/app.js).
  if (filePath === "/_ice-config") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(iceConfig()));
  }

  if (filePath === "/") filePath = "/index.html";
  const fullPath = path.normalize(path.join(PUBLIC_DIR, filePath));

  // Prevent directory traversal (normalize first, then verify the result
  // is still inside public/ — a plain startsWith(PUBLIC_DIR) would also
  // match sibling directories like "public-extra").
  if (!fullPath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      // The app ships a handful of small files with no versioned URLs, so
      // everything is revalidated on each load. Long-lived caching of
      // app.js vs a stale cached copy silently hiding new features is a
      // trade made entirely in favor of freshness here — total payload is
      // roughly 40 KB.
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
});

// ---- Signaling over WebSocket ----
const wss = new WebSocketServer({
  server,
  // Signaling payloads (SDP offers/answers, ICE candidates) are a few KiB
  // at most. Anything larger is abusive memory pressure, not a real
  // message — this would default to 100 MB otherwise.
  maxPayload: 64 * 1024,
  // Reject the upgrade at the handshake if the Origin isn't allowlisted.
  // This is what actually stops cross-site pages from opening a socket
  // to this server (cross-site WebSocket hijacking).
  verifyClient: (info) => isOriginAllowed(info.origin),
});

// In-memory only. room code -> array of up to 2 socket connections.
const rooms = new Map();
// room code -> pending TTL timer (cleared once a 2nd peer joins).
const roomTimers = new Map();

// Per-IP join/create counters for basic rate limiting.
const joinCounts = new Map(); // ip -> { count, windowStart }

function roomSize(code) {
  return rooms.has(code) ? rooms.get(code).length : 0;
}

function clearRoomTimer(code) {
  const t = roomTimers.get(code);
  if (t) {
    clearTimeout(t);
    roomTimers.delete(code);
  }
}

function scheduleRoomExpiry(code) {
  clearRoomTimer(code);
  const timer = setTimeout(() => {
    const peers = rooms.get(code);
    if (peers && peers.length < 2) {
      // Nobody ever joined as the second peer — clean it up so it doesn't
      // sit in memory forever, and let the waiting caller know.
      peers.forEach((p) => {
        if (p.readyState === p.OPEN) {
          p.send(JSON.stringify({ type: "room-expired" }));
        }
      });
      rooms.delete(code);
    }
    roomTimers.delete(code);
  }, ROOM_TTL_MS);
  roomTimers.set(code, timer);
}

function isRateLimited(ip) {
  const now = Date.now();
  const entry = joinCounts.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    joinCounts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX_JOINS;
}

wss.on("connection", (ws, req) => {
  let currentRoom = null;
  const ip = clientIp(req);

  // Heartbeat bookkeeping for this connection.
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed messages
    }

    if (msg.type === "join") {
      if (isRateLimited(ip)) {
        ws.send(JSON.stringify({ type: "rate-limited" }));
        return;
      }

      const code = String(msg.room || "").trim();
      // Valid codes are 6 chars; anything longer is junk padding a Map key
      // with garbage up to the message-size limit — just ignore it.
      if (!code || code.length > 64) return;

      if (!rooms.has(code)) rooms.set(code, []);
      const peers = rooms.get(code);

      if (peers.length >= 2) {
        ws.send(JSON.stringify({ type: "room-full" }));
        return;
      }

      peers.push(ws);
      currentRoom = code;

      // Tell this client whether they're first (caller) or second (callee)
      ws.send(JSON.stringify({ type: "joined", initiator: peers.length === 1 }));

      if (peers.length === 2) {
        // Both peers present — no need to expire this room anymore.
        clearRoomTimer(code);
        peers.forEach((p) => p.send(JSON.stringify({ type: "peer-joined" })));
      } else {
        // Only one peer so far — start (or restart) the expiry countdown.
        scheduleRoomExpiry(code);
      }
      return;
    }

    // Relay signaling payloads (offer/answer/ice) to the other peer in the room
    if (["offer", "answer", "ice-candidate", "bye"].includes(msg.type)) {
      if (!currentRoom || !rooms.has(currentRoom)) return;
      const peers = rooms.get(currentRoom);
      peers.forEach((p) => {
        if (p !== ws && p.readyState === p.OPEN) {
          p.send(JSON.stringify(msg));
        }
      });
    }
  });

  ws.on("close", () => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const peers = rooms.get(currentRoom).filter((p) => p !== ws);

    if (peers.length === 0) {
      rooms.delete(currentRoom); // room fully gone, nothing left in memory
      clearRoomTimer(currentRoom);
    } else {
      rooms.set(currentRoom, peers);
      peers.forEach((p) => p.send(JSON.stringify({ type: "peer-left" })));
      // Back down to 1 peer — give the remaining person a fresh TTL window
      // in case someone else joins, instead of the room lingering forever.
      scheduleRoomExpiry(currentRoom);
    }
  });
});

// ---- Heartbeat sweep ----
// Detects connections that died without a clean close (sleep, wifi drop,
// crashed tab) so the remaining peer isn't left waiting on a ghost.
const heartbeatInterval = setInterval(() => {
  // Prune expired rate-limit buckets while we're here — otherwise a
  // long-running server accumulates one Map entry per client IP forever.
  const now = Date.now();
  for (const [ip, entry] of joinCounts) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) joinCounts.delete(ip);
  }
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate(); // triggers the "close" handler above
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_MS);

wss.on("close", () => clearInterval(heartbeatInterval));

server.listen(PORT, HOST, () => {
  // Report the actual bound port — PORT=0 (OS-assigned) is used by tests.
  // Keep the "running on port N" phrase intact (not just cosmetic — the
  // regression suite's server-spawn test greps stdout for exactly this
  // pattern to learn which ephemeral port got assigned).
  const addr = server.address();
  const boundPort = addr && addr.port;
  console.log(`Onecall server running on port ${boundPort} (bound to ${addr && addr.address})`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
});
