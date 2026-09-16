# Onecall

A tiny, self-hosted 1:1 video calling web app. No accounts, no contacts list,
no database — just a link.

## How it meets your requirements

| Requirement | How |
|---|---|
| Low bandwidth, clean picture | WebRTC (the browser's built-in call engine) automatically adjusts video bitrate/resolution to the network in real time, using the Opus and VP8/H.264 codecs. |
| No data storage | The server never writes to disk. Signaling messages live only in memory for the seconds it takes two people to connect, then vanish. Video/audio never passes through the server at all — it flows directly between the two callers. |
| End-to-end encrypted | WebRTC media is always encrypted (DTLS-SRTP) as part of the protocol — this isn't optional or something the server can turn off or peek into. |
| Reliable | STUN + optional TURN handle NAT/firewall traversal (see below), and the server auto-reconnects a fresh session on refresh. |
| No contacts needed | Starting a call generates a random link. Send that link to whoever you want to call — that's the entire "directory." |

## Project layout

```
onecall/
├── server.js         # signaling server + static file server + /_ice-config (Node, no DB)
├── regression-test.js# headless regression suite (npm test)
├── package.json
└── public/
    ├── index.html
    ├── style.css
    └── app.js         # all WebRTC + signaling logic
```

## Run it locally

```bash
npm install
npm start
```

Open **http://localhost:3000** in two different browser tabs (or two devices
on the same network) to test a call with yourself.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port the server listens on. |
| `HOST` | `127.0.0.1` | Address the server binds to. Left at the loopback default, the app is only reachable through your reverse proxy — never directly on the instance's public IP, even if a security group rule is ever misconfigured. Only widen this if you have a specific reason to. |
| `ALLOWED_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Comma-separated list of origins allowed to open a signaling WebSocket. **Set this to your real deployed origin(s)** (e.g. `https://call.yourdomain.com`), or every connection will be rejected in production. This is what stops other websites from silently opening a signaling connection to your server (cross-site WebSocket hijacking). |
| `TRUST_PROXY` | _(off)_ | Set to `1` **only when behind a reverse proxy you control that passes `x-forwarded-for`** (nginx config below does this via `proxy_set_header X-Forwarded-For`). Otherwise per-IP rate limiting would key on the proxy's address and one bucket would be shared by every user. Never enable it on a direct internet-facing deployment — the header is trivially spoofed. |
| `STUN_URLS` | Google's two public STUN servers | Comma-separated STUN URLs served to browsers via `/_ice-config`. |
| `TURN_URL` | _(empty — TURN disabled)_ | Comma-separated TURN relay URLs (e.g. `turn:turn.yourdomain.com:3478`). When set, the relay entry is served to browsers with the credentials below. **This is the single highest-impact fix for real-world call reliability** — see the STUN vs TURN section. |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | _(empty)_ | Credentials served along with `TURN_URL`. These live only in the server's environment — they are never baked into the JS bundle (though note any browser still needs them to use the relay; prefer coturn's `use-auth-secret` + short-lived credentials for a hardened setup). |

Example for production with TURN:
```bash
PORT=3000 \
ALLOWED_ORIGINS="https://call.yourdomain.com" \
TURN_URL="turn:turn.yourdomain.com:3478" \
TURN_USERNAME="onecall" \
TURN_CREDENTIAL="strong-secret" \
npm start
```
Or, if using `pm2`:
```bash
ALLOWED_ORIGINS="https://call.yourdomain.com" pm2 start server.js --name onecall
```

## Reliability improvements included

- **Origin allowlist** — the signaling WebSocket rejects connections from any origin not in `ALLOWED_ORIGINS`.
- **Stale room cleanup** — a room with only one peer auto-expires after 5 minutes (`ROOM_TTL_MS` in `server.js`), notifying the waiting caller instead of leaking memory forever.
- **Heartbeat** — the server pings every client every 30s and terminates any that don't respond, so a dropped network (sleep, wifi loss) is detected quickly instead of leaving a "ghost" peer in the room.
- **Basic rate limiting** — a simple per-IP cap on room join/create attempts per minute, to blunt flooding/brute-force attempts against room codes.
- **ICE restart on failure** — if the peer connection reports `failed` (e.g. after a brief network blip), the app automatically attempts one `restartIce()` + fresh offer before giving up, instead of ending the call immediately.
- **TURN support, config included** — the server exposes `/_ice-config`, which serves the STUN/TURN list to the browser. Set `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` in the server's environment (no client code changes needed); if the endpoint is unreachable the client falls back to its built-in STUN-only list.
- **Unpredictable room codes** — codes are generated from `crypto.getRandomValues` (the browser's CSPRNG), not `Math.random()`, using a 31-symbol alphabet with no look-alike characters (no I/L/O/0/1) so codes survive being read aloud.
- **Signaling auto-reconnect** — if the signaling socket drops mid-call, the media path (which flows directly between the browsers) usually still works; the app retries the socket with exponential backoff and seamlessly resumes the call when the peer rejoins, instead of ending a working call. A drop before the media is connected still ends the call immediately.
- **Peer-return grace window** — when the *other* person's socket drops while the call is alive, the app waits up to 20 seconds for them to reconnect (their side does the same reconnect dance) before ending the call.
- **End-to-end verification (safety number)** — both browsers display a short code derived from the two DTLS certificate fingerprints. Reading the code aloud over the call and confirming the numbers match proves no signaling server or network path is sitting in the middle (the "Verify" chip on the call screen).

## UX improvements included

- Device preview screen (check camera/mic, pick a device) before joining or starting a call.
- An explicit "Try again" button when camera access fails, instead of a dead-end screen.
- An explicit "camera off" placeholder over the self-view whenever the camera is disabled, plus the same placeholder over the remote video when the other person turns their camera off — instead of a black rectangle.
- Enter submits the join code; the field auto-uppercases codes as you type.
- The room code on the waiting screen is tap-to-copy (separate from the copy link button).
- "Start another call" one click away from the ended screen.
- In-app toast notifications instead of blocking `alert()` popups.
- Specific error messages for permission-denied, no-device, and device-in-use-elsewhere cases.
- Live camera/mic switching, including mid-call.
- A live connection-quality indicator (Good/Fair/Poor + round-trip time) once connected.
- The browser tab title + favicon act as a status light (waiting / in call / ended) when you're in another tab, and the tab prompts before an accidental mid-call close.
- A "Verify" chip once connected — tap it to compare a short safety-number code with the other person and rule out a man-in-the-middle.
- If the connection blips mid-call, the status shows "Reconnecting…" and the call resumes by itself where possible, instead of dead-ending.
- Screen-reader friendly: connection status changes are announced (`role="status"`), and camera-off states are real text.
- Apple/iOS-style visual design: light "system" screens (start, join, waiting, ended) with San Francisco type and iOS system colors, and a true-black, translucent-control call screen matching FaceTime's in-call look.

## Security headers

The server sends baseline security headers itself, so even a bare `npm start` deploy with no reverse proxy is reasonably hardened:

- `Content-Security-Policy` — scripts/styles from same origin only; `ws:`/`wss:` (signaling), `blob:` (WebRTC media), and `data:` (canvas favicon) as needed; `frame-ancestors 'none'`.
- `X-Frame-Options: DENY` (clickjacking), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- `Permissions-Policy` granting `camera` / `microphone` to the same origin only.
- `Strict-Transport-Security` is added automatically when the request reaches the app over HTTPS (detected via `req.socket.encrypted` or a TLS-terminating proxy's `x-forwarded-proto` header).

## Automated regression tests

```bash
npm install
npm test
```

`regression-test.js` loads the real `public/index.html` and `public/app.js` in a headless DOM (jsdom) with `getUserMedia`, `RTCPeerConnection`, `fetch`, and `WebSocket` replaced by lightweight fakes, then drives every feature exactly the way a user/browser would: starting and joining calls, muting/unmuting, camera on/off (including the camera-off placeholder), device switching, hangup, server-driven end states (room full/expired, rate-limited, peer left), a dropped signaling socket (both the "media not up" and "call survives + reconnects + resumes" paths), the peer-return grace window, safety-number verification (via the real WebCrypto), automatic ICE restart on failure, CSPRNG room-code generation, and STUN/TURN config loading with all fallback paths. It additionally **spawns the real `server.js`** on an ephemeral port and asserts over live sockets: security headers (incl. proxy-aware HSTS), the `/_ice-config` response shape, directory-traversal resistance, origin-allowlist enforcement at the WebSocket handshake (401 for foreign origins), and a full two-client signaling round (join → peer-joined → offer relay → room-full rejection → peer-left notification). It currently passes 140/140 assertions.

**What this does and doesn't cover:** it verifies the app's logic and state transitions are correct — the same code path a real browser would run. It does **not** replace testing in real browsers, since it can't check actual video rendering, audio quality, or a live two-machine network path. Before shipping, also do a quick manual pass:
- Two real devices on different networks, full call, both directions of audio/video
- Deny camera permission, and unplug/disable a camera, to see the real browser's error UI
- Actually put a poor connection (throttle one side) and watch the quality indicator + ICE restart behavior
- Test on an actual mobile Safari/Chrome, since iOS Safari's autoplay/permission behavior differs from desktop

## Deploy it

This is a single small Node process — any of these work well and have a free
tier:

- **Render** – "New Web Service," point at your repo, build command
  `npm install`, start command `npm start`.
- **Fly.io** – `fly launch`, it auto-detects the Node app.
- **Railway** – connect the repo, it deploys automatically.
- **Your own VPS** – `npm install && npm start` behind nginx/Caddy with TLS.

**Important:** the app must be served over **HTTPS** in production. Browsers
block camera/microphone access on plain HTTP for any origin other than
`localhost`. All the platforms above give you HTTPS automatically.

On a VPS, either of these terminates TLS for you (remember to set
`ALLOWED_ORIGINS` to your real origin):

```
# Caddy (automatic Let's Encrypt certificates)
call.yourdomain.com {
    reverse_proxy localhost:3000
}
```

```nginx
# nginx (certbot provisions the certificate)
server {
    listen 443 ssl http2;
    server_name call.yourdomain.com;
    ssl_certificate     /etc/letsencrypt/live/call.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/call.yourdomain.com/privkey.pem;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # WebSocket signaling
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Forwarded-Proto https;    # lets the app send HSTS
        proxy_set_header X-Forwarded-For $remote_addr; # real client IP
    }
}
```

Run the app with `TRUST_PROXY=1` (see the environment table) so rate limiting
keys on the forwarded client IP. Caddy sets `X-Forwarded-For` automatically;
just add `TRUST_PROXY=1` to its environment.

## Scaling note (intentional ceiling)

The architecture is **single-process, in-memory by design**: rooms are a JS
`Map` in one Node process, and there is no shared state. That is what makes
it zero-storage and trivially deployable — but it also means you cannot
horizontally scale it behind multiple instances without adding shared
state (e.g. Redis) for room membership. For personal and small-group use
(a single small Node process easily carries thousands of concurrent
signaling connections) this is a non-issue; treat it as a known ceiling
that only matters if usage grows well beyond that. A WebRTC TURN relay
(see below) carries media load outside the app process, so media capacity
scales independently.

## About reliability: STUN vs TURN

This is the one part of "reliable" that needs a deliberate choice.

- **STUN** (already configured, using Google's free public servers) lets two
  devices find each other's public IP so they can connect directly. This
  works for the majority of home/mobile networks.
- **TURN** is a relay of last resort for networks that block direct
  peer-to-peer connections outright — this is common on corporate Wi-Fi and
  some mobile carriers. Without a TURN server, calls on those networks will
  fail to connect. With one, the call still works, just routed through the
  relay (still fully DTLS-SRTP encrypted end-to-end — the relay can't see the
  content, only that encrypted packets are passing through).

If you want maximum reliability, add a TURN server. Two straightforward
options:

1. **Self-host coturn** (free, ~$5/mo VPS): https://github.com/coturn/coturn
2. **Managed TURN**: Twilio's Network Traversal Service, Cloudflare Calls, or
   Metered.ca's TURN offering all have low-cost usage-based pricing.

Then point the app at it with environment variables — **no client code
changes needed**:

```bash
TURN_URL="turn:your-turn-server.com:3478" \
TURN_USERNAME="user" \
TURN_CREDENTIAL="pass" \
npm start
```

The browser picks this up automatically: before each call it fetches
`/_ice-config`, which serves your STUN servers plus the TURN entry with
credentials. If you use coturn, strongly consider its
[`use-auth-secret` short-lived credential mode](https://github.com/coturn/coturn/blob/master/README.turnserver)
so long-lived credentials aren't sitting in the server's environment.

Without TURN, the app still works fine for most calls — it just won't be
100% reliable on restrictive networks.

## Privacy details worth knowing

- No cookies, no localStorage, no analytics, no tracking scripts.
- No user accounts — a "room" is just a random 6-character code with no
  identity attached.
- The signaling server only ever sees connection setup metadata (SDP/ICE),
  never audio/video content.
- If you add a TURN server for reliability, be aware that in the (uncommon)
  case media is relayed through it, that server does see encrypted packet
  traffic between the two peers — not decrypted content, but it does confirm
  a call happened between two IPs at a point in time. Run your TURN server
  with logging disabled if this matters to you.

## Extending it later

- **Screen sharing**: swap a track using `getDisplayMedia()` — a small
  addition to `app.js`.
- **Mobile app wrapper**: the same signaling server works with
  `react-native-webrtc` if you want a native app later without rebuilding
  the backend.
- **Custom room codes**: currently random; you could let the caller type a
  memorable phrase instead.
