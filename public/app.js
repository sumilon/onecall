// app.js — client-side WebRTC logic.
// No data is ever written to localStorage, cookies, or any server.
// Everything here lives only in memory for the duration of the call.

(() => {
  const screens = {
    landing: document.getElementById("landing"),
    preview: document.getElementById("preview"),
    waiting: document.getElementById("waiting"),
    call: document.getElementById("call"),
    ended: document.getElementById("ended"),
  };

  // ---- Dynamic title-bar icon ----
  // The favicon reflects call state: idle, waiting for a peer (pulsing
  // amber), connected (pulsing green), or ended (grey). Lets you glance
  // at the tab and know what's happening without switching to it.
  const favicon = (() => {
    const link = document.getElementById("favicon");
    if (!link) return { set() {} };

    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    // Environments without a Canvas2D implementation (headless DOM, very
    // old browsers) return null — the dynamic favicon simply no-ops there.
    const ctx = canvas.getContext && canvas.getContext("2d");

    const COLORS = { idle: "#007AFF", waiting: "#FF9500", connected: "#34C759", ended: "#6E6E73" };

    function draw(state, pulse) {
      if (!ctx) return;
      ctx.clearRect(0, 0, 64, 64);

      // Rounded-square background
      const r = 16;
      ctx.fillStyle = COLORS[state] || COLORS.idle;
      ctx.beginPath();
      ctx.moveTo(r, 0);
      ctx.arcTo(64, 0, 64, 64, r);
      ctx.arcTo(64, 64, 0, 64, r);
      ctx.arcTo(0, 64, 0, 0, r);
      ctx.arcTo(0, 0, 64, 0, r);
      ctx.closePath();
      ctx.fill();

      // "Onecall" mark: one dot (the call) inside one open ring (the
      // ring/connection) — deliberately a single ring, not stacked
      // circles, to echo "One call." The ring pulses outward on
      // waiting/connected states like an active ring signal.
      const cx = 32, cy = 32;
      const isActive = state === "waiting" || state === "connected";
      const radius = isActive ? 18 + (pulse ? 4 : 0) : 18;
      const alpha = isActive ? (pulse ? 0.5 : 1) : 1;
      const gapDeg = 100;
      const startAngle = ((gapDeg / 2) * Math.PI) / 180;
      const endAngle = ((360 - gapDeg / 2) * Math.PI) / 180;

      ctx.beginPath();
      ctx.arc(cx, cy, radius, startAngle, endAngle);
      ctx.strokeStyle = "#FFFFFF";
      ctx.lineWidth = 5.5;
      ctx.lineCap = "round";
      ctx.globalAlpha = alpha;
      ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.beginPath();
      ctx.arc(cx, cy, 8, 0, Math.PI * 2);
      ctx.fillStyle = "#FFFFFF";
      ctx.fill();

      link.href = canvas.toDataURL("image/png");
    }

    let timer = null;
    let pulseOn = false;

    return {
      set(state) {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        pulseOn = false;
        draw(state, pulseOn);
        if (state === "waiting" || state === "connected") {
          timer = setInterval(() => {
            pulseOn = !pulseOn;
            draw(state, pulseOn);
          }, 700);
        }
      },
    };
  })();

  const FAVICON_STATE_BY_SCREEN = {
    landing: "idle",
    preview: "idle",
    waiting: "waiting",
    call: "connected",
    ended: "ended",
  };

  // The browser tab itself becomes a status light: the title tells someone
  // in another tab what's happening without them switching over.
  const TITLE_BY_SCREEN = {
    landing: "Onecall",
    preview: "Onecall",
    waiting: "Onecall — connecting…",
    call: "Onecall — call in progress",
    ended: "Onecall — call ended",
  };

  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove("active"));
    screens[name].classList.add("active");
    favicon.set(FAVICON_STATE_BY_SCREEN[name] || "idle");
    document.title = TITLE_BY_SCREEN[name] || "Onecall";
  }

  // ---- Toasts (replaces alert()) ----
  const toastContainer = document.getElementById("toastContainer");
  function showToast(message, type = "info", duration = 5000) {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <span class="toast-dot"></span>
      <span class="toast-text"></span>
      <button class="toast-close" aria-label="Dismiss">&times;</button>
    `;
    toast.querySelector(".toast-text").textContent = message;
    const remove = () => {
      toast.classList.add("leaving");
      setTimeout(() => toast.remove(), 160);
    };
    toast.querySelector(".toast-close").addEventListener("click", remove);
    toastContainer.appendChild(toast);
    if (duration) setTimeout(remove, duration);
  }

  // ---- STUN/TURN config ----
  // The server's /_ice-config endpoint is the single source of truth: it
  // serves STUN (and TURN, if configured via TURN_URL etc. in the server's
  // environment) so relay credentials live server-side instead of being
  // shipped inside this JS bundle. The STUN list below is only a fallback
  // for the unlikely case the endpoint can't be reached — STUN alone still
  // allows direct peer-to-peer calls on most networks. See README.md for
  // how to run a TURN server (self-hosted coturn or a managed service).
  let ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  let iceConfigLoaded = false;
  async function loadIceConfig() {
    if (iceConfigLoaded || typeof fetch !== "function") return;
    iceConfigLoaded = true; // fetch at most once per page load, even on failure
    try {
      const res = await fetch(`${APP_BASE}_ice-config`, { cache: "no-store" });
      if (!res.ok) return; // non-200 — keep the STUN fallback
      const cfg = await res.json();
      const served = cfg && Array.isArray(cfg.iceServers)
        ? cfg.iceServers.filter((s) => s && s.urls)
        : null;
      if (served && served.length > 0) {
        ICE_SERVERS = served; // never adopt an empty list — STUN fallback stays intact
      }
    } catch {
      /* endpoint unreachable — STUN fallback above still works for direct calls */
    }
  }

  let ws = null;
  let pc = null;
  let localStream = null;
  let roomCode = null;
  let isInitiator = false;
  let micOn = true;
  let camOn = true;
  let reconnectAttempted = false;
  let pendingMode = null; // "start" | "join" — what to do after preview confirms
  let qualityInterval = null;
  let reconnectTimer = null; // pending signaling-socket reconnect attempt
  let reconnectAttempts = 0; // attempts since the socket dropped
  let peerReturnTimer = null; // grace window for the peer's socket to come back
  let resumeWatchdog = null; // gives up if a rejoin never completes
  const RECONNECT_DELAYS_MS = [250, 1000, 2500, 5000, 8000];
  const PEER_RETURN_GRACE_MS = 20000;
  const RESUME_WATCHDOG_MS = 15000;

  const el = {
    startCallBtn: document.getElementById("startCallBtn"),
    joinCallBtn: document.getElementById("joinCallBtn"),
    joinCodeInput: document.getElementById("joinCodeInput"),
    roomCodeDisplay: document.getElementById("roomCodeDisplay"),
    copyLinkBtn: document.getElementById("copyLinkBtn"),
    cancelWaitBtn: document.getElementById("cancelWaitBtn"),
    localVideo: document.getElementById("localVideo"),
    remoteVideo: document.getElementById("remoteVideo"),
    connectionStatus: document.getElementById("connectionStatus"),
    statusDot: document.getElementById("statusDot"),
    qualityLabel: document.getElementById("qualityLabel"),
    toggleMicBtn: document.getElementById("toggleMicBtn"),
    toggleCamBtn: document.getElementById("toggleCamBtn"),
    hangupBtn: document.getElementById("hangupBtn"),
    endedMessage: document.getElementById("endedMessage"),
    backHomeBtn: document.getElementById("backHomeBtn"),
    previewVideo: document.getElementById("previewVideo"),
    previewPlaceholder: document.getElementById("previewPlaceholder"),
    previewPlaceholderText: document.getElementById("previewPlaceholderText"),
    previewTitle: document.getElementById("previewTitle"),
    previewMicBtn: document.getElementById("previewMicBtn"),
    previewCamBtn: document.getElementById("previewCamBtn"),
    cameraSelect: document.getElementById("cameraSelect"),
    micSelect: document.getElementById("micSelect"),
    previewContinueBtn: document.getElementById("previewContinueBtn"),
    previewCancelBtn: document.getElementById("previewCancelBtn"),
    localCamOff: document.getElementById("localCamOff"),
    previewCamOff: document.getElementById("previewCamOff"),
    remoteCamOff: document.getElementById("remoteCamOff"),
    previewRetryBtn: document.getElementById("previewRetryBtn"),
    restartCallBtn: document.getElementById("restartCallBtn"),
    verifyChip: document.getElementById("verifyChip"),
    verifySheet: document.getElementById("verifySheet"),
    verifyCodeText: document.getElementById("verifyCodeText"),
    verifyCloseBtn: document.getElementById("verifyCloseBtn"),
  };

  function generateRoomCode() {
    // Generated from the browser's CSPRNG (crypto.getRandomValues), not
    // Math.random(), so codes can't be predicted or replayed. The 31-symbol
    // alphabet skips look-alikes (I/L, O/0, 1) so a code stays unambiguous
    // when read aloud. Rejection sampling keeps every code equally likely
    // (256 % 31 != 0, so a plain modulo would slightly favor early letters).
    const ROOM_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let bytes = crypto.getRandomValues(new Uint8Array(16));
    let i = 0;
    let code = "";
    while (code.length < 6) {
      if (i >= bytes.length) {
        bytes = crypto.getRandomValues(new Uint8Array(16));
        i = 0;
      }
      const b = bytes[i++];
      if (b < 248) code += ROOM_ALPHABET[b % 31]; // 248 = 31 * 8; drop biased tail
    }
    return code;
  }

  // App base path: the current page's directory. Lets the app live under a
  // URL prefix (e.g. https://sumilon.in/onecall/) behind a reverse proxy that
  // strips the prefix — every app-relative URL (WebSocket and /_ice-config)
  // must carry it. Root-hosted pages resolve this to "/" as before.
  const APP_BASE = (() => {
    const dir = String(location.pathname || "/").replace(/index\.html$/, "");
    return dir.endsWith("/") ? dir : dir + "/";
  })();

  function wsUrl() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}${APP_BASE}`;
  }

  function setStatus(text, dotClass) {
    el.connectionStatus.textContent = text;
    el.statusDot.className = dotClass || "";
  }

  function friendlyMediaError(err) {
    switch (err.name) {
      case "NotAllowedError":
      case "PermissionDeniedError":
        return "Camera/mic access was blocked. Allow access in your browser's site settings, then try again.";
      case "NotFoundError":
      case "DevicesNotFoundError":
        return "No camera or microphone was found. Connect one and try again.";
      case "NotReadableError":
      case "TrackStartError":
        return "Your camera or mic is already in use by another app or browser tab. Close it and try again.";
      case "OverconstrainedError":
        return "The selected camera/mic doesn't support the requested settings. Try a different device.";
      default:
        return "Couldn't access your camera or microphone. Please check your device and try again.";
    }
  }

  async function getLocalStream(constraints) {
    localStream = await navigator.mediaDevices.getUserMedia(
      constraints || {
        video: { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 24 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      }
    );
    el.localVideo.srcObject = localStream;
  }

  async function populateDeviceSelects() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === "videoinput");
    const mics = devices.filter((d) => d.kind === "audioinput");

    const fill = (select, list, kind) => {
      select.innerHTML = "";
      if (list.length === 0) {
        const opt = document.createElement("option");
        opt.textContent = `No ${kind} found`;
        select.appendChild(opt);
        select.disabled = true;
        return;
      }
      select.disabled = false;
      list.forEach((d, i) => {
        const opt = document.createElement("option");
        opt.value = d.deviceId;
        opt.textContent = d.label || `${kind} ${i + 1}`;
        select.appendChild(opt);
      });
    };
    fill(el.cameraSelect, cams, "camera");
    fill(el.micSelect, mics, "microphone");

    // Reflect whichever device is actually active in the current stream.
    if (localStream) {
      const vTrack = localStream.getVideoTracks()[0];
      const aTrack = localStream.getAudioTracks()[0];
      if (vTrack) {
        const id = vTrack.getSettings().deviceId;
        if (id) el.cameraSelect.value = id;
      }
      if (aTrack) {
        const id = aTrack.getSettings().deviceId;
        if (id) el.micSelect.value = id;
      }
    }
  }

  async function switchDevice() {
    const videoId = el.cameraSelect.value;
    const audioId = el.micSelect.value;
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: el.cameraSelect.disabled ? false : { deviceId: { exact: videoId } },
        audio: el.micSelect.disabled ? false : { deviceId: { exact: audioId } },
      });
      if (localStream) localStream.getTracks().forEach((t) => t.stop());
      localStream = newStream;
      el.previewVideo.srcObject = localStream;
      el.localVideo.srcObject = localStream;
      // If we're already mid-call, swap the live tracks on the peer connection too.
      if (pc) {
        const newVideoTrack = localStream.getVideoTracks()[0];
        const newAudioTrack = localStream.getAudioTracks()[0];
        pc.getSenders().forEach((sender) => {
          if (sender.track && sender.track.kind === "video" && newVideoTrack) {
            sender.replaceTrack(newVideoTrack);
          }
          if (sender.track && sender.track.kind === "audio" && newAudioTrack) {
            sender.replaceTrack(newAudioTrack);
          }
        });
      }
      applyMicCamState();
    } catch (err) {
      showToast(friendlyMediaError(err), "error");
    }
  }

  function applyMicCamState() {
    if (!localStream) return;
    localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
    localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
    el.toggleMicBtn.classList.toggle("active-off", !micOn);
    el.toggleCamBtn.classList.toggle("active-off", !camOn);
    el.previewMicBtn.classList.toggle("active-off", !micOn);
    el.previewCamBtn.classList.toggle("active-off", !camOn);
    // A disabled camera track renders as a plain black rectangle, which
    // looks broken — show an explicit "camera off" placeholder instead.
    el.localCamOff.classList.toggle("hidden", camOn);
    el.previewCamOff.classList.toggle("hidden", camOn);
  }

  function createPeerConnection() {
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    reconnectAttempted = false;
    remoteCamTrack = null;

    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    pc.ontrack = (event) => {
      el.remoteVideo.srcObject = event.streams[0];
      // Track whether the remote camera is muted so we can show an
      // explicit "Camera is off" placeholder instead of a black video.
      // (Browsers fire mute/unmute on the remote track when the sender
      // flips track.enabled; on some browsers this is best-effort, in
      // which case the placeholder just never shows — no harm done.)
      const stream = event.streams && event.streams[0];
      const track = stream && typeof stream.getVideoTracks === "function"
        ? stream.getVideoTracks()[0]
        : null;
      if (track && typeof track.addEventListener === "function") {
        remoteCamTrack = track;
        track.addEventListener("mute", updateRemoteCamPlaceholder);
        track.addEventListener("unmute", updateRemoteCamPlaceholder);
        updateRemoteCamPlaceholder();
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        send({ type: "ice-candidate", candidate: event.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      switch (pc.connectionState) {
        case "connected":
          setStatus("Connected · end-to-end encrypted", "connected");
          showScreen("call");
          reconnectAttempted = false;
          startQualityMonitor();
          updateRemoteCamPlaceholder();
          computeVerifyCode();
          break;
        case "disconnected":
          // Often transient (brief wifi blip, network switch). Give it a
          // moment to self-recover before treating it as a real failure.
          setStatus("Connection unstable…", "lost");
          stopQualityMonitor();
          break;
        case "failed":
          setStatus("Reconnecting…", "lost");
          stopQualityMonitor();
          attemptIceRestart();
          break;
        case "closed":
          stopQualityMonitor();
          break;
      }
    };
  }

  // ---- Connection quality indicator ----
  // Polls getStats() for the active candidate pair's round-trip time and
  // shows a simple good/fair/poor label, so people can tell a rough call
  // from an app problem.
  function startQualityMonitor() {
    stopQualityMonitor();
    qualityInterval = setInterval(async () => {
      if (!pc) return;
      try {
        const stats = await pc.getStats();
        let rttMs = null;
        stats.forEach((report) => {
          if (report.type === "candidate-pair" && report.state === "succeeded" && report.currentRoundTripTime != null) {
            rttMs = report.currentRoundTripTime * 1000;
          }
        });
        if (rttMs == null) {
          el.qualityLabel.textContent = "";
          return;
        }
        let label, cls;
        if (rttMs < 150) { label = "Good"; cls = "good"; }
        else if (rttMs < 350) { label = "Fair"; cls = "fair"; }
        else { label = "Poor"; cls = "poor"; }
        el.qualityLabel.textContent = `· ${label} (${Math.round(rttMs)}ms)`;
        el.qualityLabel.className = cls;
      } catch {
        /* getStats can fail transiently mid-negotiation; ignore */
      }
    }, 3000);
  }

  function stopQualityMonitor() {
    if (qualityInterval) {
      clearInterval(qualityInterval);
      qualityInterval = null;
    }
    el.qualityLabel.textContent = "";
    el.qualityLabel.className = "";
  }

  // ---- Remote camera-off placeholder ----
  // remoteCamTrack is set in ontrack; muted + a live connection means the
  // other person has deliberately turned their camera off (before the media
  // flows, remote tracks are also muted — hence the connectionState guard,
  // so we never claim "camera off" while it's really just still connecting).
  let remoteCamTrack = null;
  function updateRemoteCamPlaceholder() {
    const off = !!(remoteCamTrack && remoteCamTrack.muted && pc && pc.connectionState === "connected");
    el.remoteCamOff.classList.toggle("hidden", !off);
  }

  // ---- End-to-end verification (safety number) ----
  // DTLS keys are bound to the certificate fingerprints inside the SDP that
  // both browsers already exchange through the signaling server. Each side
  // hashes the PAIR of fingerprints into a short numeric code; identical
  // codes on both screens prove no man-in-the-middle swapped the keys in
  // transit. Comparison is up to the humans — reading the code aloud over
  // the (already encrypted) call or any other side channel. Best-effort:
  // if anything is unavailable (no WebCrypto, no fingerprints), the chip
  // simply stays hidden.
  function dtlsFingerprintOf(sdp) {
    const m = sdp && typeof sdp === "string" ? sdp.match(/a=fingerprint:sha-256\s+([0-9A-Fa-f:]+)/i) : null;
    return m ? m[1].toLowerCase() : null;
  }

  async function computeVerifyCode() {
    el.verifyChip.classList.add("hidden");
    el.verifyCodeText.textContent = "· · · ·";
    try {
      const local = pc && pc.localDescription ? dtlsFingerprintOf(pc.localDescription.sdp) : null;
      const remote = pc && pc.remoteDescription ? dtlsFingerprintOf(pc.remoteDescription.sdp) : null;
      if (!local || !remote) return;
      if (typeof crypto === "undefined" || !crypto.subtle || typeof crypto.subtle.digest !== "function") return;
      // Sort so both sides hash the fingerprints in the same order.
      const pair = local < remote ? `${local}|${remote}` : `${remote}|${local}`;
      const bytes = new Uint8Array(pair.length);
      for (let i = 0; i < pair.length; i++) bytes[i] = pair.charCodeAt(i) & 0xff;
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const groups = [];
      for (let g = 0; g < 4; g++) {
        groups.push(String(((digest[g * 2] << 8) | digest[g * 2 + 1]) % 1000).padStart(3, "0"));
      }
      // Each 3-digit group is its own span so the CSS can align the groups
      // on a flex row with even spacing (letter-spacing on plain text makes
      // the groups drift out of alignment).
      el.verifyCodeText.innerHTML = groups.map((g) => `<span>${g}</span>`).join(" ");
      el.verifyChip.classList.remove("hidden");
    } catch {
      /* verification is cosmetic — never break a live call over it */
    }
  }

  function attemptIceRestart() {
    if (!pc || reconnectAttempted) return;
    reconnectAttempted = true;
    // Only the original initiator re-offers, so both sides don't race
    // to restart at once.
    if (isInitiator) {
      pc.restartIce();
      makeOffer();
    }
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  // ---- Signaling resilience ----
  // The P2P media path (DTLS/SRTP packets between the two browsers) can
  // survive a short signaling outage — only control messages need the
  // socket. So a socket drop mid-call is retried with backoff instead of
  // instantly ending a working call; a drop before the media is up ends
  // the call as before.
  function mediaPathAlive() {
    return !!pc && (pc.connectionState === "connected" || pc.connectionState === "disconnected");
  }

  function clearReconnectState() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (peerReturnTimer) { clearTimeout(peerReturnTimer); peerReturnTimer = null; }
    if (resumeWatchdog) { clearTimeout(resumeWatchdog); resumeWatchdog = null; }
    reconnectAttempts = 0;
  }

  function scheduleSignalingReconnect() {
    if (!screens.call.classList.contains("active")) return;
    if (reconnectAttempts >= RECONNECT_DELAYS_MS.length) {
      clearReconnectState();
      endCall("Couldn't reconnect on either side. Please start a new call.");
      return;
    }
    setStatus("Reconnecting…", "lost");
    const delay = RECONNECT_DELAYS_MS[reconnectAttempts];
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!pc || pc.connectionState === "closed") {
        endCall("The call ended.");
        return;
      }
      // Rejoin the same room; the resume path in "peer-joined" restores
      // the call without renegotiating. The watchdog covers the case where
      // the room has expired and the other person can never rejoin.
      connectSignaling(roomCode);
      resumeWatchdog = setTimeout(() => {
        resumeWatchdog = null;
        endCall("Couldn't reach the other person. Please start a new call.");
      }, RESUME_WATCHDOG_MS);
    }, delay);
  }

  async function makeOffer() {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: "offer", offer });
  }

  function connectSignaling(code) {
    ws = new WebSocket(wsUrl());

    ws.onopen = () => {
      send({ type: "join", room: code });
    };

    ws.onmessage = async (event) => {
      // The server only ever sends JSON — anything else is noise.
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      try {
        switch (msg.type) {
          case "joined":
            isInitiator = msg.initiator;
            break;

          case "room-full":
            endCall("That call code is already in use. Start a new call instead.");
            break;

          case "room-expired":
            endCall("No one joined in time. Start a new call and share the link again.");
            break;

          case "rate-limited":
            endCall("Too many attempts in a short time. Please wait a minute and try again.");
            break;

          case "peer-joined":
            if (resumeWatchdog) { clearTimeout(resumeWatchdog); resumeWatchdog = null; }
            if (peerReturnTimer) { clearTimeout(peerReturnTimer); peerReturnTimer = null; }
            if (mediaPathAlive()) {
              // Signaling recovered after a drop while the media kept
              // flowing — skip renegotiation and restore the call UI.
              reconnectAttempts = 0;
              setStatus("Connected · end-to-end encrypted", "connected");
              startQualityMonitor();
              updateRemoteCamPlaceholder();
              break;
            }
            setStatus("Peer found, connecting…", "");
            if (isInitiator) await makeOffer();
            break;

          case "offer":
            if (!pc) break; // message raced a hangup — nothing to negotiate with
            await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            send({ type: "answer", answer });
            break;

          case "answer":
            if (!pc) break;
            await pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
            break;

          case "ice-candidate":
            if (!pc) break;
            try {
              await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
            } catch (e) {
              /* benign if it arrives after connection settles */
            }
            break;

          case "bye":
            // Explicit fast-path hangup notice from the peer; the trailing
            // peer-left (after their socket closes) is the slower fallback.
            endCall("The other person ended the call.");
            break;

          case "peer-left":
            if (mediaPathAlive()) {
              // The peer's socket dropped but our media path is fine —
              // give them a grace window to reconnect (their rejoin lands
              // here as "peer-joined") before giving up.
              setStatus("Connection to the other person dropped — waiting for them to return…", "lost");
              stopQualityMonitor();
              if (!peerReturnTimer) {
                peerReturnTimer = setTimeout(() => {
                  peerReturnTimer = null;
                  endCall("Lost connection to the other person.");
                }, PEER_RETURN_GRACE_MS);
              }
            } else {
              endCall("The other person left the call.");
            }
            break;
        }
      } catch {
        /* anything in here (e.g. SDP racing a closed peer connection) must
           never surface as an unhandled rejection — the sockets' close
           paths above already handle the user-visible side. */
      }
    };

    ws.onclose = () => {
      const onCallScreen = screens.call.classList.contains("active");
      if (onCallScreen && mediaPathAlive()) {
        // Media may still be flowing P2P — rebuild the control socket
        // instead of killing a live call.
        if (!reconnectTimer) {
          reconnectAttempts = 0;
          scheduleSignalingReconnect();
        }
        return;
      }
      // While a call is actually being set up (waiting, or connecting after
      // the peer joined), a socket drop is fatal as before. Once the user
      // has already left/resumed elsewhere, ignore stale events entirely.
      if (!onCallScreen && !screens.waiting.classList.contains("active")) return;
      if (mediaPathAlive()) return;
      endCall("Connection to the signaling server was lost.");
    };
  }

  async function startFlow(code) {
    roomCode = code;
    if (!localStream) {
      // Safety net — shouldn't normally happen since preview acquires it first.
      try {
        await getLocalStream();
      } catch (err) {
        showToast(friendlyMediaError(err), "error");
        showScreen("landing");
        return;
      }
    }
    await loadIceConfig(); // fetch STUN/TURN (incl. TURN credentials) before creating the peer connection
    clearReconnectState();
    createPeerConnection();
    connectSignaling(code);
  }

  function endCall(message) {
    if (pc) { pc.close(); pc = null; }
    if (ws) {
      ws.onmessage = null; // ignore stragglers racing our own teardown
      ws.onclose = null; // ...including our own close() firing close events
      send({ type: "bye" });
      ws.close();
      ws = null;
    }
    clearReconnectState();
    remoteCamTrack = null;
    el.remoteCamOff.classList.add("hidden");
    el.verifyChip.classList.add("hidden");
    el.verifySheet.classList.add("hidden");
    stopQualityMonitor();
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    el.endedMessage.textContent = message || "Call ended";
    showScreen("ended");
    // Clean the URL so a refresh doesn't try to rejoin a dead room
    history.replaceState({}, "", location.pathname);
  }

  // ---- Preview screen (check camera/mic before joining) ----

  async function openPreview(mode, code) {
    pendingMode = mode;
    roomCode = code || null;
    el.previewTitle.textContent = mode === "start" ? "Check your camera & mic" : "Ready to join?";
    el.previewContinueBtn.textContent = mode === "start" ? "Continue" : "Join call";
    el.previewContinueBtn.disabled = true;
    el.previewRetryBtn.classList.add("hidden");
    el.previewPlaceholder.classList.remove("hidden");
    el.previewPlaceholderText.textContent = "Requesting camera access…";
    showScreen("preview");

    try {
      await getLocalStream();
      el.previewVideo.srcObject = localStream;
      el.previewPlaceholder.classList.add("hidden");
      el.previewContinueBtn.disabled = false;
      applyMicCamState();
      await populateDeviceSelects();
    } catch (err) {
      el.previewPlaceholderText.textContent = "Camera unavailable";
      showToast(friendlyMediaError(err), "error", 7000);
      // Let them retry device selection rather than dead-ending on the screen.
      el.previewRetryBtn.classList.remove("hidden");
      try {
        await populateDeviceSelects();
      } catch {
        /* enumerateDevices can also fail without any permission at all */
      }
    }
  }

  function closePreview() {
    if (localStream && pendingMode !== "confirmed") {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    pendingMode = null;
    el.previewVideo.srcObject = null;
  }

  // ---- UI wiring ----

  el.startCallBtn.addEventListener("click", () => {
    openPreview("start");
  });

  el.joinCallBtn.addEventListener("click", () => {
    const code = el.joinCodeInput.value.trim().toUpperCase();
    if (!code) {
      showToast("Enter a call code to join.", "info", 3000);
      return;
    }
    openPreview("join", code);
  });

  // Enter in the code field is the same as pressing Join.
  el.joinCodeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") el.joinCallBtn.click();
  });

  el.previewRetryBtn.addEventListener("click", () => {
    // Re-run the whole preview for whatever mode was pending — retry
    // re-requests permission and repopulates the device pickers.
    openPreview(pendingMode, roomCode);
  });

  el.previewCancelBtn.addEventListener("click", () => {
    closePreview();
    showScreen("landing");
  });

  el.previewContinueBtn.addEventListener("click", async () => {
    if (!localStream) return; // no camera acquired — Continue is disabled in this case anyway
    const mode = pendingMode;
    const code = mode === "start" ? generateRoomCode() : roomCode;
    pendingMode = "confirmed"; // stop closePreview() from stopping the stream we're about to reuse

    if (mode === "start") {
      el.roomCodeDisplay.textContent = code;
      const link = `${location.origin}${location.pathname}?room=${code}`;
      history.replaceState({}, "", `?room=${code}`);
      el.copyLinkBtn.style.display = "";
      el.copyLinkBtn.onclick = async () => {
        try {
          // clipboard requires a secure context (HTTPS); on plain HTTP
          // (wrong deploy) it's undefined and this throws — caught below.
          await navigator.clipboard.writeText(link);
          el.copyLinkBtn.textContent = "Link copied ✓";
          setTimeout(() => (el.copyLinkBtn.textContent = "Copy link"), 1500);
        } catch {
          showToast("Couldn't copy the link automatically — copy it from the browser's address bar.", "info", 7000);
        }
      };
      document.querySelector("#waiting h2").textContent = "Share this to start the call";
      document.querySelector("#waiting .footnote").textContent = "Waiting for the other person to join…";
      showScreen("waiting");
    } else {
      document.querySelector("#waiting h2").textContent = "Joining call…";
      document.querySelector("#waiting .footnote").textContent = "Connecting you now…";
      el.copyLinkBtn.style.display = "none";
      showScreen("waiting");
    }

    await startFlow(code);
  });

  el.cameraSelect.addEventListener("change", switchDevice);
  el.micSelect.addEventListener("change", switchDevice);

  el.previewMicBtn.addEventListener("click", () => {
    micOn = !micOn;
    applyMicCamState();
  });
  el.previewCamBtn.addEventListener("click", () => {
    camOn = !camOn;
    applyMicCamState();
  });

  el.cancelWaitBtn.addEventListener("click", () => {
    endCall("Call cancelled.");
    showScreen("landing");
  });

  el.backHomeBtn.addEventListener("click", () => {
    showScreen("landing");
    el.joinCodeInput.value = "";
  });

  // Straight from "call ended" into a brand-new call.
  el.restartCallBtn.addEventListener("click", () => openPreview("start"));

  el.verifyChip.addEventListener("click", () => {
    el.verifySheet.classList.remove("hidden");
  });
  el.verifyCloseBtn.addEventListener("click", () => {
    el.verifySheet.classList.add("hidden");
  });
  el.verifySheet.addEventListener("click", (e) => {
    if (e.target === el.verifySheet) el.verifySheet.classList.add("hidden");
  });

  // The big code itself is tappable — copies just the code, for texting it
  // or reading it out, separate from the full link under it.
  el.roomCodeDisplay.addEventListener("click", async () => {
    if (!roomCode) return;
    try {
      await navigator.clipboard.writeText(roomCode);
      showToast("Code copied ✓", "success", 2000);
    } catch {
      showToast("Couldn't copy the code automatically — read it off the screen instead.", "info", 7000);
    }
  });

  el.toggleMicBtn.addEventListener("click", () => {
    if (!localStream) return;
    micOn = !micOn;
    applyMicCamState();
  });

  el.toggleCamBtn.addEventListener("click", () => {
    if (!localStream) return;
    camOn = !camOn;
    applyMicCamState();
  });

  el.hangupBtn.addEventListener("click", () => {
    endCall("You ended the call.");
  });

  window.addEventListener("beforeunload", (e) => {
    if (ws) send({ type: "bye" });
    // Mid-call, a stray tab close / reload shouldn't silently kill the
    // call with no warning — the browser shows its native confirmation.
    if (ws && screens.call.classList.contains("active")) {
      e.preventDefault(); // required for Chrome to show the dialog
      e.returnValue = ""; // required for Chrome (and expected historically)
    }
  });

  // ---- Auto-join if the page was opened via a shared link ----
  const params = new URLSearchParams(location.search);
  const roomFromLink = params.get("room");
  if (roomFromLink) {
    openPreview("join", roomFromLink.toUpperCase());
  }
})();
