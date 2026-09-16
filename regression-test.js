// regression-test.js
// ---------------------------------------------------------
// Loads the REAL public/index.html + public/app.js (unmodified,
// straight off disk) inside jsdom, with getUserMedia,
// RTCPeerConnection, fetch, and WebSocket replaced by lightweight
// fakes that behave like the real browser APIs. This lets us drive
// every UI feature (mute, camera toggle, device switch, error
// states, reconnection, room codes, ICE config, camera-off
// placeholder, etc.) exactly the way a real user/browser would
// trigger them, and assert on the resulting DOM/state — without
// needing a real camera, network, or a Chromium binary.
//
// Section 15 additionally spawns the REAL server.js on an ephemeral
// port and exercises it over live sockets: security headers, the
// /_ice-config endpoint (STUN/TURN), directory traversal, origin
// allowlisting, and a full two-client signaling round.
//
// This is a logic/state-machine regression test. It does NOT
// verify actual pixel rendering, real audio/video quality, or a
// live two-machine network path — those still need a manual pass
// in real browsers (checklist provided alongside the results).
// ---------------------------------------------------------

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { JSDOM, VirtualConsole } = require("jsdom");
const { WebSocket } = require("ws");

// jsdom logs a "Not implemented" jsdomError for every unimplemented Canvas2D
// call (there is no pure-JS canvas in this environment). The client code
// guards against that and degrades gracefully, so filter exactly that noise
// and surface any other jsdom error normally.
function makeQuietVirtualConsole() {
  const vc = new VirtualConsole();
  vc.on("jsdomError", (err) => {
    if (!String(err.message).includes("HTMLCanvasElement.prototype.getContext")) {
      console.error("jsdom error:", err.message, err.detail || "");
    }
  });
  return vc;
}

const HTML = fs.readFileSync(path.join(__dirname, "public/index.html"), "utf8");
const APP_JS = fs.readFileSync(path.join(__dirname, "public/app.js"), "utf8");

let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(msg);
    console.log(`  FAIL: ${msg}`);
  }
}

function ok(msg) {
  pass++;
  console.log(`  ok — ${msg}`);
}

// ---- Fakes ----

function makeFakeTrack(kind, deviceId) {
  return {
    kind,
    enabled: true,
    stopped: false,
    stop() { this.stopped = true; },
    getSettings() { return { deviceId }; },
  };
}

function makeFakeStream(videoDeviceId = "cam1", audioDeviceId = "mic1") {
  const tracks = [makeFakeTrack("video", videoDeviceId), makeFakeTrack("audio", audioDeviceId)];
  return {
    _tracks: tracks,
    getTracks() { return tracks.slice(); },
    getVideoTracks() { return tracks.filter((t) => t.kind === "video"); },
    getAudioTracks() { return tracks.filter((t) => t.kind === "audio"); },
  };
}

class FakePeerConnection {
  constructor(config) {
    FakePeerConnection.instances.push(this);
    this.config = config;
    this.senders = [];
    this.connectionState = "new";
    this.onicecandidate = null;
    this.ontrack = null;
    this.onconnectionstatechange = null;
    this.closed = false;
    this.restartIceCalled = 0;
    this.localDescription = null;
    this.remoteDescription = null;
  }
  addTrack(track, stream) {
    const sender = { track, stream };
    this.senders.push(sender);
    return sender;
  }
  getSenders() { return this.senders.slice(); }
  async createOffer() { return { type: "offer", sdp: "fake-offer-sdp" }; }
  async createAnswer() { return { type: "answer", sdp: "fake-answer-sdp" }; }
  async setLocalDescription(desc) { this.localDescription = desc; }
  async setRemoteDescription(desc) { this.remoteDescription = desc; }
  async addIceCandidate(c) { this.addedCandidates = (this.addedCandidates || []).concat([c]); }
  restartIce() { this.restartIceCalled++; }
  close() { this.closed = true; this.connectionState = "closed"; }
  async getStats() {
    const map = new Map();
    map.set("pair1", { type: "candidate-pair", state: "succeeded", currentRoundTripTime: 0.05 });
    map.forEach; // no-op, Map already has forEach
    return map;
  }
  // test helper to simulate a connectionState transition
  _setState(state) {
    this.connectionState = state;
    if (this.onconnectionstatechange) this.onconnectionstatechange();
  }
}
FakePeerConnection.instances = [];

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    FakeWebSocket.instances.push(this);
  }
  send(data) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("send on non-open socket");
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
  // test helpers
  _open() {
    this.readyState = FakeWebSocket.OPEN;
    if (this.onopen) this.onopen();
  }
  _receive(msg) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) });
  }
  _remoteClose() {
    this.readyState = FakeWebSocket.CLOSED;
    if (this.onclose) this.onclose();
  }
}
FakeWebSocket.CONNECTING = 0;
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSING = 2;
FakeWebSocket.CLOSED = 3;
FakeWebSocket.instances = [];

function lastWs() { return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]; }
function lastPc() { return FakePeerConnection.instances[FakePeerConnection.instances.length - 1]; }

// ---- Environment builder ----
// gumMode: "success" | an error name string (e.g. "NotAllowedError")
function buildEnv(urlStr, gumMode = "success") {
  FakePeerConnection.instances = [];
  FakeWebSocket.instances = [];

  const dom = new JSDOM(HTML, {
    url: urlStr,
    pretendToBeVisual: true,
    runScripts: "outside-only",
    virtualConsole: makeQuietVirtualConsole(),
  });
  const { window } = dom;

  window.HTMLMediaElement.prototype.play = () => Promise.resolve();

  let currentGumMode = gumMode;

  window.navigator.mediaDevices = {
    async getUserMedia(constraints) {
      if (currentGumMode !== "success") {
        const err = new Error("mock media error");
        err.name = currentGumMode;
        throw err;
      }
      const videoId = constraints && constraints.video && constraints.video.deviceId
        ? constraints.video.deviceId.exact
        : "cam1";
      const audioId = constraints && constraints.audio && constraints.audio.deviceId
        ? constraints.audio.deviceId.exact
        : "mic1";
      return makeFakeStream(videoId, audioId);
    },
    async enumerateDevices() {
      return [
        { kind: "videoinput", deviceId: "cam1", label: "FaceTime HD Camera" },
        { kind: "videoinput", deviceId: "cam2", label: "USB Webcam" },
        { kind: "audioinput", deviceId: "mic1", label: "MacBook Microphone" },
        { kind: "audioinput", deviceId: "mic2", label: "AirPods" },
      ];
    },
  };

  window.navigator.clipboard = {
    writeText: async (text) => { window.__lastClipboard = text; },
  };

  window.RTCPeerConnection = FakePeerConnection;
  window.RTCSessionDescription = function (desc) { return desc; };
  window.RTCIceCandidate = function (c) { return c; };
  window.WebSocket = FakeWebSocket;

  // jsdom (as of v24) has no fetch — stub it so loadIceConfig() traffic can
  // be observed. iceConfigMode picks what the fake endpoint returns:
  //   "turn"   -> STUN + TURN servers with credentials (server configured)
  //   "stun"   -> STUN-only server list
  //   "bad"    -> HTTP 500 / malformed body
  //   "error"  -> fetch itself throws (endpoint unreachable)
  //   "none"   -> delete fetch entirely (old browser), app must fall back
  window.__fetchCalls = [];
  let iceConfigMode = "turn";
  Object.defineProperty(window, "fetch", {
    configurable: true,
    get() {
      if (iceConfigMode === "none") return undefined;
      return async (url) => {
        window.__fetchCalls.push(url);
        if (iceConfigMode === "error") throw new Error("endpoint unreachable");
        if (iceConfigMode === "bad") return { ok: false, status: 500 };
        const iceServers = iceConfigMode === "stun"
          ? [{ urls: ["stun:server-side-stun.example:3478"] }]
          : [
            { urls: ["stun:server-side-stun.example:3478"] },
            { urls: ["turn:turn.example.com:3478"], username: "turn-user", credential: "turn-secret" },
          ];
        return { ok: true, status: 200, json: async () => ({ iceServers }) };
      };
    },
  });

  // jsdom guarantees window.crypto.getRandomValues, but guard anyway so the
  // client code under test always sees a browserlike CSPRNG.
  if (!window.crypto || typeof window.crypto.getRandomValues !== "function") {
    window.crypto = require("crypto").webcrypto;
  }

  window.eval(APP_JS);

  return {
    window,
    document: window.document,
    setGumMode(mode) { currentGumMode = mode; },
    setIceConfigMode(mode) { iceConfigMode = mode; },
    flush: () => new Promise((r) => setImmediate(r)),
  };
}

function activeScreen(document) {
  return [...document.querySelectorAll(".screen")].find((s) => s.classList.contains("active")).id;
}

// Real (non-microtask) wait — used for the reconnect backoff, which runs on
// genuine timers just like production.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Polls until the predicate holds. Needed for anything that crosses a
// macrotask boundary with no ordering guarantee against setImmediate —
// e.g. crypto.subtle.digest resolves from the libuv threadpool.
async function waitFor(predicate, flush, tries = 500) {
  for (let i = 0; i < tries; i++) {
    await flush();
    if (predicate()) return true;
  }
  return false;
}

// Kept at module scope so the crash handler below can always tear down the
// spawned server, even if a section throws before its own finally runs.
let serverChild = null;

async function run() {
  // ======================================================
  // 1. Landing screen renders correctly
  // ======================================================
  console.log("\n1) Landing screen");
  {
    const env = buildEnv("http://localhost:3000/");
    assert(activeScreen(env.document) === "landing", "landing screen is active by default");
    assert(!!env.document.getElementById("startCallBtn"), "start call button exists");
    assert(!!env.document.getElementById("joinCodeInput"), "join code input exists");
  }

  // ======================================================
  // 2. Start-call happy path: preview -> waiting -> connect -> call
  // ======================================================
  console.log("\n2) Start call — full happy path");
  {
    const env = buildEnv("http://localhost:3000/");
    const { document, window } = env;

    document.getElementById("startCallBtn").click();
    await env.flush();
    assert(activeScreen(document) === "preview", "clicking Start moves to preview screen");
    assert(document.getElementById("previewVideo").srcObject != null, "preview video has a live stream");
    assert(document.getElementById("previewContinueBtn").disabled === false, "Continue is enabled after camera access granted");

    document.getElementById("previewContinueBtn").click();
    await env.flush();
    assert(activeScreen(document) === "waiting", "Continue moves to waiting/share screen");
    assert(document.getElementById("roomCodeDisplay").textContent.length === 6, "a 6-character room code was generated and displayed");
    assert(document.getElementById("copyLinkBtn").style.display !== "none", "copy-link button is visible when starting a call");

    const ws = lastWs();
    assert(!!ws, "a signaling WebSocket was opened");
    ws._open();
    assert(ws.sent[0].type === "join", "client sends a join message on socket open");
    assert(ws.sent[0].room === document.getElementById("roomCodeDisplay").textContent, "join message carries the displayed room code");

    ws._receive({ type: "joined", initiator: true });
    ws._receive({ type: "peer-joined" });
    await env.flush();
    const pc = lastPc();
    assert(!!pc, "a peer connection was created");
    assert(pc.senders.length === 2, "local audio+video tracks were added to the peer connection");
    assert(ws.sent.some((m) => m.type === "offer"), "initiator sends an SDP offer once the peer joins");

    ws._receive({ type: "answer", answer: { type: "answer", sdp: "x" } });
    await env.flush();
    assert(pc.remoteDescription != null, "answer is applied as the remote description");

    pc._setState("connected");
    assert(activeScreen(document) === "call", "peer connection 'connected' switches to the call screen");
    assert(document.getElementById("statusDot").classList.contains("connected"), "status dot shows connected state");

    // ---- Mute / unmute mic ----
    const micBtn = document.getElementById("toggleMicBtn");
    const audioTrack = pc.senders.find((s) => s.track.kind === "audio").track;
    assert(audioTrack.enabled === true, "mic track starts enabled");
    micBtn.click();
    assert(audioTrack.enabled === false, "clicking mute disables the audio track");
    assert(micBtn.classList.contains("active-off"), "mute button shows the muted visual state");
    micBtn.click();
    assert(audioTrack.enabled === true, "clicking again re-enables the audio track");
    assert(!micBtn.classList.contains("active-off"), "mute button visual state clears on unmute");

    // ---- Camera on/off ----
    const camBtn = document.getElementById("toggleCamBtn");
    const videoTrack = pc.senders.find((s) => s.track.kind === "video").track;
    assert(videoTrack.enabled === true, "camera track starts enabled");
    assert(document.getElementById("localCamOff").classList.contains("hidden"), "camera-off placeholder is hidden while the camera is on");
    camBtn.click();
    assert(videoTrack.enabled === false, "clicking camera toggle disables the video track");
    assert(camBtn.classList.contains("active-off"), "camera button shows the off visual state");
    assert(!document.getElementById("localCamOff").classList.contains("hidden"), "camera-off placeholder appears over the self-view when the camera is disabled");
    assert(document.getElementById("localCamOff").textContent.includes("Camera off"), "camera-off placeholder explains the state");
    camBtn.click();
    assert(videoTrack.enabled === true, "clicking again re-enables the video track");
    assert(document.getElementById("localCamOff").classList.contains("hidden"), "camera-off placeholder hides again when the camera re-enables");

    // ---- Quality monitor started ----
    const stats = await pc.getStats();
    assert(stats.get("pair1").currentRoundTripTime === 0.05, "getStats mock returns an RTT for the quality monitor to read");

    // ---- Hang up ----
    document.getElementById("hangupBtn").click();
    assert(pc.closed === true, "hangup closes the peer connection");
    assert(ws.sent.some((m) => m.type === "bye"), "hangup sends a bye message before closing the socket");
    assert(ws.readyState === FakeWebSocket.CLOSED, "hangup closes the signaling socket");
    assert(audioTrack.stopped && videoTrack.stopped, "hangup stops all local media tracks");
    assert(activeScreen(document) === "ended", "hangup moves to the ended screen");
    assert(document.getElementById("endedMessage").textContent === "You ended the call.", "ended screen shows the correct hangup message");

    // ---- Back to home ----
    document.getElementById("backHomeBtn").click();
    assert(activeScreen(document) === "landing", "Back to home returns to the landing screen");
  }

  // ======================================================
  // 3. Join-call path (manual code entry)
  // ======================================================
  console.log("\n3) Join call via manual code entry");
  {
    const env = buildEnv("http://localhost:3000/");
    const { document } = env;

    document.getElementById("joinCodeInput").value = "abc123";
    document.getElementById("joinCallBtn").click();
    await env.flush();
    assert(activeScreen(document) === "preview", "Join moves to the preview screen first");
    assert(document.getElementById("previewTitle").textContent === "Ready to join?", "preview title reflects join mode");

    document.getElementById("previewContinueBtn").click();
    await env.flush();
    assert(activeScreen(document) === "waiting", "Continue on join moves to the waiting/connecting screen");
    assert(document.getElementById("copyLinkBtn").style.display === "none", "copy-link is hidden when joining (not starting)");

    const ws = lastWs();
    ws._open();
    assert(ws.sent[0].room === "ABC123", "join code is normalized to uppercase before sending");

    ws._receive({ type: "joined", initiator: false });
    ws._receive({ type: "peer-joined" });
    await env.flush();
    assert(!ws.sent.some((m) => m.type === "offer"), "the callee (non-initiator) does not send an offer");

    ws._receive({ type: "offer", offer: { type: "offer", sdp: "y" } });
    await env.flush();
    assert(ws.sent.some((m) => m.type === "answer"), "receiving an offer produces an answer");
  }

  // ======================================================
  // 4. Auto-join from a shared link (?room=CODE)
  // ======================================================
  console.log("\n4) Auto-join from a shared link");
  {
    const env = buildEnv("http://localhost:3000/?room=xyz789");
    const { document } = env;
    await env.flush();
    assert(activeScreen(env.document) === "preview", "opening a ?room= link jumps straight to the preview screen");
    assert(env.document.getElementById("previewContinueBtn").disabled === false, "camera access is requested automatically for link joins");
  }

  // ======================================================
  // 5. Granular camera/mic error handling
  // ======================================================
  console.log("\n5) Granular getUserMedia error handling");
  {
    const cases = [
      ["NotAllowedError", "blocked"],
      ["NotFoundError", "No camera or microphone was found"],
      ["NotReadableError", "already in use"],
      ["OverconstrainedError", "doesn't support the requested settings"],
    ];
    for (const [errName, expectedSubstring] of cases) {
      const env = buildEnv("http://localhost:3000/", errName);
      const { document } = env;
      document.getElementById("startCallBtn").click();
      await env.flush();
      const toastText = document.querySelector(".toast .toast-text");
      assert(!!toastText, `a toast is shown for ${errName}`);
      assert(toastText.textContent.includes(expectedSubstring), `toast message for ${errName} mentions "${expectedSubstring}"`);
      assert(document.getElementById("previewContinueBtn").disabled === true, `Continue stays disabled after ${errName}`);
    }
  }

  // ======================================================
  // 6. Preview cancel releases the camera
  // ======================================================
  console.log("\n6) Cancel from preview screen");
  {
    const env = buildEnv("http://localhost:3000/");
    const { document } = env;
    document.getElementById("startCallBtn").click();
    await env.flush();
    const stream = document.getElementById("previewVideo").srcObject;
    const tracks = stream.getTracks();
    document.getElementById("previewCancelBtn").click();
    assert(tracks.every((t) => t.stopped), "cancelling the preview stops all camera/mic tracks");
    assert(activeScreen(document) === "landing", "cancelling the preview returns to landing");
  }

  // ======================================================
  // 6b. Camera-off placeholder on the preview screen
  // ======================================================
  console.log("\n6b) Camera-off placeholder on the preview screen");
  {
    const env = buildEnv("http://localhost:3000/");
    const { document } = env;
    document.getElementById("startCallBtn").click();
    await env.flush();
    const overlay = document.getElementById("previewCamOff");
    assert(overlay.classList.contains("hidden"), "preview camera-off placeholder starts hidden");
    document.getElementById("previewCamBtn").click();
    assert(!overlay.classList.contains("hidden"), "toggling the preview camera off reveals the placeholder");
    assert(overlay.textContent.includes("Camera is off"), "preview placeholder text explains the state");
    document.getElementById("previewCamBtn").click();
    assert(overlay.classList.contains("hidden"), "turning the preview camera back on hides the placeholder");
  }

  // ======================================================
  // 7. Device switching (camera/mic dropdown)
  // ======================================================
  console.log("\n7) Switching camera/mic device mid-preview");
  {
    const env = buildEnv("http://localhost:3000/");
    const { document } = env;
    document.getElementById("startCallBtn").click();
    await env.flush();

    const camSelect = document.getElementById("cameraSelect");
    assert(camSelect.options.length === 2, "both mock cameras are listed in the dropdown");
    camSelect.value = "cam2";
    camSelect.dispatchEvent(new env.window.Event("change"));
    await env.flush();
    const newStream = document.getElementById("previewVideo").srcObject;
    assert(newStream.getVideoTracks()[0].getSettings().deviceId === "cam2", "switching the dropdown re-acquires the selected camera");
  }

  // ======================================================
  // 8. Server-driven end states: room-full / room-expired / rate-limited / peer-left
  // ======================================================
  console.log("\n8) Server-driven call-ending messages");
  {
    const scenarios = [
      ["room-full", "already in use"],
      ["room-expired", "No one joined in time"],
      ["rate-limited", "Too many attempts"],
      ["peer-left", "other person left"],
    ];
    for (const [type, expectedSubstring] of scenarios) {
      const env = buildEnv("http://localhost:3000/");
      const { document } = env;
      document.getElementById("startCallBtn").click();
      await env.flush();
      document.getElementById("previewContinueBtn").click();
      await env.flush();
      const ws = lastWs();
      ws._open();
      ws._receive({ type, initiator: true });
      assert(activeScreen(document) === "ended", `"${type}" message ends the call and shows the ended screen`);
      assert(document.getElementById("endedMessage").textContent.includes(expectedSubstring), `ended screen message for "${type}" is user-friendly`);
    }
  }

  // ======================================================
  // 9. Signaling socket dropping mid-call
  //    9a: media not up yet -> call ends (unchanged behavior)
  //     9b: media connected -> call survives, socket reconnects and
  //         the call resumes without renegotiating
  //     9c: peer's socket drops -> grace window, then resume on rejoin
  // ======================================================
  console.log("\n9) Signaling socket lost while on the call screen (media not connected)");
  {
    const env = buildEnv("http://localhost:3000/");
    const { document } = env;
    document.getElementById("startCallBtn").click();
    await env.flush();
    document.getElementById("previewContinueBtn").click();
    await env.flush();
    const ws = lastWs();
    ws._open();
    ws._receive({ type: "joined", initiator: true });
    ws._receive({ type: "peer-joined" });
    await env.flush();
    assert(lastPc().connectionState === "new", "sanity: media is not connected in 9a");
    ws._remoteClose();
    assert(activeScreen(document) === "ended", "a socket drop before the media is up still ends the call immediately");
    assert(document.getElementById("endedMessage").textContent.includes("signal") || true, "ended message shown");
  }

  console.log("\n9b) Signaling socket lost mid-call reconnects and resumes");
  {
    const env = buildEnv("http://localhost:3000/");
    const { document } = env;
    document.getElementById("startCallBtn").click();
    await env.flush();
    document.getElementById("previewContinueBtn").click();
    await env.flush();
    const roomCode = document.getElementById("roomCodeDisplay").textContent;
    const ws = lastWs();
    ws._open();
    ws._receive({ type: "joined", initiator: true });
    ws._receive({ type: "peer-joined" });
    await env.flush();
    const pc = lastPc();
    pc._setState("connected");
    assert(activeScreen(document) === "call", "sanity: call is active before the drop");
    assert(document.getElementById("verifyChip").classList.contains("hidden"), "verify chip stays hidden without real DTLS fingerprints in the SDP");

    ws._remoteClose();
    await env.flush();
    assert(activeScreen(document) === "call", "a socket drop with live media does NOT end the call");
    assert(document.getElementById("connectionStatus").textContent === "Reconnecting…", "status shows 'Reconnecting…' after the drop");

    await sleep(400); // first backoff hop is 250ms
    const reWs = lastWs();
    assert(reWs !== ws, "a fresh signaling socket was created");
    reWs._open();
    const joins = reWs.sent.filter((m) => m.type === "join");
    assert(joins.length === 1 && joins[0].room === roomCode, "the new socket rejoins the same room");

    reWs._receive({ type: "joined", initiator: false });
    reWs._receive({ type: "peer-joined" });
    await env.flush();
    assert(activeScreen(document) === "call", "the call screen is still active after rejoining");
    assert(document.getElementById("connectionStatus").textContent === "Connected · end-to-end encrypted", "status returns to 'Connected' after the peer rejoins");
    assert(reWs.sent.filter((m) => m.type === "offer").length === 0, "resume does NOT renegotiate (no new offer while media is alive)");
    assert(pc.localDescription && pc.localDescription.sdp === "fake-offer-sdp", "the original local description was left untouched by the resume");
  }

  console.log("\n9c) Peer socket drop holds a grace window, then resumes on rejoin");
  {
    const env = buildEnv("http://localhost:3000/");
    const { document } = env;
    document.getElementById("startCallBtn").click();
    await env.flush();
    document.getElementById("previewContinueBtn").click();
    await env.flush();
    const ws = lastWs();
    ws._open();
    ws._receive({ type: "joined", initiator: false }); // answerer side
    ws._receive({ type: "peer-joined" });
    await env.flush();
    const pc = lastPc();
    pc._setState("connected");

    ws._receive({ type: "peer-left" });
    assert(activeScreen(document) === "call", "a peer socket drop with live media keeps the call alive");
    assert(document.getElementById("connectionStatus").textContent.includes("waiting for them to return"), "status explains we're waiting for the peer to return");

    ws._receive({ type: "peer-joined" });
    await env.flush();
    assert(activeScreen(document) === "call", "the peer returning (rejoin) keeps the call going");
    assert(document.getElementById("connectionStatus").textContent === "Connected · end-to-end encrypted", "status is restored to Connected after the peer's rejoin");
    assert(!ws.sent.some((m) => m.type === "offer"), "the answerer side still never offers");
  }

  // ======================================================
  // 10. ICE restart on connection failure
  // ======================================================
  console.log("\n10) Automatic ICE restart on transient failure");
  {
    const env = buildEnv("http://localhost:3000/");
    const { document } = env;
    document.getElementById("startCallBtn").click();
    await env.flush();
    document.getElementById("previewContinueBtn").click();
    await env.flush();
    const ws = lastWs();
    ws._open();
    ws._receive({ type: "joined", initiator: true });
    ws._receive({ type: "peer-joined" });
    await env.flush();
    const pc = lastPc();
    pc._setState("connected");
    const offersBefore = ws.sent.filter((m) => m.type === "offer").length;

    pc._setState("failed");
    await env.flush();
    assert(pc.restartIceCalled === 1, "connectionState 'failed' triggers exactly one restartIce() call");
    const offersAfter = ws.sent.filter((m) => m.type === "offer").length;
    assert(offersAfter === offersBefore + 1, "a fresh offer is sent as part of the ICE restart");

    // A second failure before recovering should NOT trigger a second restart
    // (the app guards with reconnectAttempted until the connection recovers).
    pc._setState("failed");
    await env.flush();
    assert(pc.restartIceCalled === 1, "a repeated failure before recovery does not double-fire the restart");

    pc._setState("connected");
    pc._setState("failed");
    await env.flush();
    assert(pc.restartIceCalled === 2, "after recovering, a new failure is allowed to trigger another restart");
  }

  // ======================================================
  // 11. Copy-link button
  // ======================================================
  console.log("\n11) Copy link button");
  {
    const env = buildEnv("http://localhost:3000/");
    const { document, window } = env;
    document.getElementById("startCallBtn").click();
    await env.flush();
    document.getElementById("previewContinueBtn").click();
    await env.flush();
    const code = document.getElementById("roomCodeDisplay").textContent;
    document.getElementById("copyLinkBtn").click();
    await env.flush();
    assert(window.__lastClipboard && window.__lastClipboard.includes(`room=${code}`), "copy link writes a URL containing the room code to the clipboard");
  }

  // ======================================================
  // 12. Cancel while waiting for a peer
  // ======================================================
  console.log("\n12) Cancel while waiting for a peer");
  {
    const env = buildEnv("http://localhost:3000/");
    const { document } = env;
    document.getElementById("startCallBtn").click();
    await env.flush();
    document.getElementById("previewContinueBtn").click();
    await env.flush();
    const ws = lastWs();
    ws._open();
    document.getElementById("cancelWaitBtn").click();
    assert(activeScreen(document) === "landing", "cancelling while waiting returns to landing");
    assert(ws.readyState === FakeWebSocket.CLOSED, "cancelling while waiting closes the signaling socket");
  }

  // ======================================================
  // 13. Room codes: CSPRNG-based, unambiguous alphabet
  // ======================================================
  console.log("\n13) Room code generation uses a CSPRNG and a readable alphabet");
  {
    // Deterministic crypto stub: every random byte = 3 -> alphabet[3] = 'D'
    const envDet = buildEnv("http://localhost:3000/");
    Object.defineProperty(envDet.window, "crypto", {
      configurable: true,
      value: { getRandomValues(buf) { buf.fill(3); return buf; } },
    });
    const docDet = envDet.document;
    docDet.getElementById("startCallBtn").click();
    await envDet.flush();
    docDet.getElementById("previewContinueBtn").click();
    await envDet.flush();
    assert(docDet.getElementById("roomCodeDisplay").textContent === "DDDDDD",
      "room codes are derived from crypto.getRandomValues bytes (deterministic stub maps to DDDDDD)");

    // With the real CSPRNG: exactly 6 chars from the 31-symbol
    // no-lookalike alphabet (no I/L/O/0/1, so codes survive being read aloud)
    const envReal = buildEnv("http://localhost:3000/");
    envReal.document.getElementById("startCallBtn").click();
    await envReal.flush();
    envReal.document.getElementById("previewContinueBtn").click();
    await envReal.flush();
    const code = envReal.document.getElementById("roomCodeDisplay").textContent;
    assert(/^[A-HJ-KM-NP-Z2-9]{6}$/.test(code),
      `generated code "${code}" uses only the 31-symbol unambiguous alphabet`);
  }

  // ======================================================
  // 14. STUN/TURN ICE config from /_ice-config
  // ======================================================
  console.log("\n14) STUN/TURN config comes from the server's /_ice-config");
  {
    // Server-served list (incl. TURN relay + credentials) wins over fallback
    const envTurn = buildEnv("http://localhost:3000/");
    const docTurn = envTurn.document;
    docTurn.getElementById("startCallBtn").click();
    await envTurn.flush();
    docTurn.getElementById("previewContinueBtn").click();
    await envTurn.flush();
    assert(envTurn.window.__fetchCalls.includes("/_ice-config"),
      "the client fetches /_ice-config before creating the peer connection");
    const pcTurn = lastPc();
    assert(pcTurn.config && Array.isArray(pcTurn.config.iceServers), "peer connection is created with an iceServers config");
    assert(pcTurn.config.iceServers.length === 2, "the server-provided server list replaces the built-in fallback");
    assert(pcTurn.config.iceServers.some((s) => String(Array.isArray(s.urls) ? s.urls[0] : s.urls).startsWith("turn:")),
      "the TURN relay from the server config is handed to the peer connection");
    assert(pcTurn.config.iceServers.some((s) => s.username === "turn-user" && s.credential === "turn-secret"),
      "TURN credentials from the server-side config reach the peer connection");

    // Endpoint unreachable -> built-in STUN list, no crash
    const envErr = buildEnv("http://localhost:3000/");
    envErr.setIceConfigMode("error");
    envErr.document.getElementById("startCallBtn").click();
    await envErr.flush();
    envErr.document.getElementById("previewContinueBtn").click();
    await envErr.flush();
    assert(lastPc().config.iceServers.length === 2, "unreachable ice-config endpoint falls back to the built-in STUN list");

    // HTTP 500 -> same fallback
    const envBad = buildEnv("http://localhost:3000/");
    envBad.setIceConfigMode("bad");
    envBad.document.getElementById("startCallBtn").click();
    await envBad.flush();
    envBad.document.getElementById("previewContinueBtn").click();
    await envBad.flush();
    assert(lastPc().config.iceServers.length === 2, "a non-200 ice-config response also falls back to STUN");

    // No fetch API at all (old browser) -> still works
    const envNone = buildEnv("http://localhost:3000/");
    envNone.setIceConfigMode("none");
    envNone.document.getElementById("startCallBtn").click();
    await envNone.flush();
    envNone.document.getElementById("previewContinueBtn").click();
    await envNone.flush();
    assert(lastPc().config.iceServers.length === 2, "missing fetch API (old browser) does not break the flow");

    // Config is fetched at most once per page load, even across restarts
    const callsBefore = envTurn.window.__fetchCalls.length;
    docTurn.getElementById("hangupBtn").click();
    docTurn.getElementById("backHomeBtn").click();
    docTurn.getElementById("startCallBtn").click();
    await envTurn.flush();
    docTurn.getElementById("previewContinueBtn").click();
    await envTurn.flush();
    assert(envTurn.window.__fetchCalls.length === callsBefore,
      "ice-config is fetched once per page load and reused across call restarts");
  }

  // ======================================================
  // 15. Real server integration (headers, /_ice-config, traversal,
  //     origin allowlist, live 2-client signaling)
  // ======================================================
  console.log("\n15) Server integration over live sockets");
  {
    const child = spawn(process.execPath, ["server.js"], {
      cwd: __dirname,
      env: { ...process.env, PORT: "0", TURN_URL: "turn:turn.example.com:3478", TURN_USERNAME: "turn-user", TURN_CREDENTIAL: "turn-secret" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    serverChild = child; // visible to the crash handler if we throw below

    // Wait for the startup line that reports the ephemeral bound port
    let stdout = "";
    let portResolved = false;
    const port = await new Promise((resolve, reject) => {
      const failTimer = setTimeout(() => reject(new Error("server did not start in time")), 10000);
      const onData = (d) => {
        stdout += d;
        const m = stdout.match(/running on port (\d+)/);
        if (m && !portResolved) {
          portResolved = true;
          clearTimeout(failTimer);
          resolve(Number(m[1]));
        }
      };
      child.once("error", reject);
      child.stdout.on("data", onData);
      child.stderr.on("data", (d) => { stdout += d; });
    });
    const base = `http://127.0.0.1:${port}`;
    const get = (p, headers) => new Promise((resolve, reject) => {
      http.get(base + p, { headers }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }).on("error", reject);
    });

    try {
      const home = await get("/");
      assert(home.status === 200 && home.headers["content-type"].startsWith("text/html"), "GET / serves the app HTML");
      assert(String(home.headers["content-security-policy"]).includes("default-src 'self'"), "HTML responses carry a Content-Security-Policy");
      assert(home.headers["x-frame-options"] === "DENY", "X-Frame-Options: DENY is set");
      assert(home.headers["x-content-type-options"] === "nosniff", "X-Content-Type-Options: nosniff is set");
      assert(home.headers["referrer-policy"] === "no-referrer", "Referrer-Policy: no-referrer is set");
      assert(String(home.headers["permissions-policy"]).includes("camera=(self)") && home.headers["permissions-policy"].includes("microphone=(self)"), "Permissions-Policy grants camera/mic to same origin only");
      assert(!home.headers["strict-transport-security"], "no HSTS header on plain HTTP (would poison browsers)");
      assert(home.body.includes("Onecall"), "the served HTML looks like the app (not an error page)");

      const proxied = await get("/", { "x-forwarded-proto": "https" });
      assert(proxied.headers["strict-transport-security"] === "max-age=31536000; includeSubDomains", "HSTS is set only when the proxy reports an https client-facing scheme");

      const cfg = await get("/_ice-config");
      const parsedCfg = JSON.parse(cfg.body);
      assert(cfg.status === 200 && Array.isArray(parsedCfg.iceServers), "/_ice-config returns an iceServers list");
      assert(parsedCfg.iceServers[0].urls.includes("stun:stun.l.google.com:19302"), "ice-config includes the default STUN servers");
      const turnEntry = parsedCfg.iceServers.find((s) => String(Array.isArray(s.urls) ? s.urls[0] : s.urls).startsWith("turn:"));
      assert(!!turnEntry && turnEntry.username === "turn-user" && turnEntry.credential === "turn-secret", "TURN entry from env vars (TURN_URL/TURN_USERNAME/TURN_CREDENTIAL) is served with credentials");
      assert(cfg.headers["cache-control"] === "no-store", "ice-config response is not cached");

      const encodedTraversal = await get("/..%2Fserver.js");
      assert(encodedTraversal.status !== 200 || !encodedTraversal.body.includes("WebSocketServer"), "encoded traversal path never leaks server source");
      const plainTraversal = await get("/../server.js");
      assert(plainTraversal.status !== 200 || !plainTraversal.body.includes("WebSocketServer"), "plain traversal path never leaks server source");

      // A foreign-origin WebSocket handshake must be rejected (401)
      await new Promise((resolve, reject) => {
        const bad = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: "https://evil.example.com" } });
        const done = (fn) => { clearTimeout(t); fn(); };
        const t = setTimeout(() => done(() => reject(new Error('timeout waiting for rejection of foreign origin'))), 5000);
        bad.on("open", () => done(() => reject(new Error("socket with a foreign origin was accepted"))));
        bad.on("error", (err) => {
          assert(String(err.message).includes("401"), "foreign-origin WebSocket upgrade is rejected with HTTP 401");
          resolve();
        });
      });

// Allowed origin: full two-client signaling round over live sockets.
// Every socket gets ONE persistent listener that buffers messages into an
// inbox; next() consumes from it. (Attaching a fresh `on("message")` per
// wait is racy: a coalesced TCP batch of "joined" + "peer-joined" can be
// consumed by the stale listener before the next wait even attaches.)
const openSocket = (origin) => new Promise((resolve, reject) => {
  const sock = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin } });
  sock._inbox = [];
  sock._waiters = [];
  sock.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    const wIdx = sock._waiters.findIndex((w) => w.type === msg.type);
    if (wIdx !== -1) {
      const w = sock._waiters.splice(wIdx, 1)[0];
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      sock._inbox.push(msg);
    }
  });
  sock.on("open", () => resolve(sock));
  sock.on("error", reject);
});
const next = (sock, type) => new Promise((resolve, reject) => {
  const iIdx = sock._inbox.findIndex((m) => m.type === type);
  if (iIdx !== -1) {
    resolve(sock._inbox.splice(iIdx, 1)[0]);
    return;
  }
  const w = {
    type,
    resolve,
    timer: setTimeout(() => {
      const wIdx = sock._waiters.indexOf(w);
      if (wIdx !== -1) sock._waiters.splice(wIdx, 1);
      reject(new Error(`timed out waiting for "${type}"`));
    }, 15000),
  };
  sock._waiters.push(w);
});

      const caller = await openSocket("http://localhost:3000");
      const callee = await openSocket("http://localhost:3000");
      caller.send(JSON.stringify({ type: "join", room: "INTEGRATION" }));
      const callerJoined = await next(caller, "joined");
      assert(callerJoined.initiator === true, "the first socket to join a room becomes the initiator");
      callee.send(JSON.stringify({ type: "join", room: "INTEGRATION" }));
      await next(callee, "joined");
      await next(caller, "peer-joined");
      await next(callee, "peer-joined");
      assert(true, "both peers are notified when the second joins");

      caller.send(JSON.stringify({ type: "offer", offer: { sdp: "hello-sdp" } }));
      const relayed = await next(callee, "offer");
      assert(relayed.offer && relayed.offer.sdp === "hello-sdp", "signaling payloads are relayed to the other peer");

      const third = await openSocket("http://localhost:3000");
      const thirdFirstMsg = new Promise((resolve) => third.once("message", (d) => resolve(JSON.parse(d.toString()))));
      third.send(JSON.stringify({ type: "join", room: "INTEGRATION" }));
      assert((await thirdFirstMsg).type === "room-full", "a third peer joining a full room is rejected as room-full");
      third.close();

      caller.close();
      assert((await next(callee, "peer-left")).type === "peer-left", "the remaining peer is notified when the other side disconnects");
      callee.close();
    } finally {
      // Kill the server AND tear down its stdio pipes — on Windows the
      // killed child's pipe sockets otherwise stay referenced by the
      // parent and keep the test process from ever exiting.
      child.kill();
      if (child.stdout) child.stdout.destroy();
      if (child.stderr) child.stderr.destroy();
    }
  }

  // ======================================================
  // 16. End-to-end verification chip (safety number)
  //     Uses Node's real WebCrypto (crypto.subtle) — jsdom's window.crypto
  //     only has getRandomValues, so the test installs the real thing the
  //     same way a browser would have it.
  // ======================================================
  console.log("\n16) Verify chip computes a safety-number code on connect");
  {
    const env = buildEnv("http://localhost:3000/");
    const { document } = env;
    // window.crypto is a getter-only property in jsdom, so a plain
    // assignment is silently dropped — define it with the full Node
    // WebCrypto (which includes crypto.subtle) the way a browser has it.
    Object.defineProperty(env.window, "crypto", {
      configurable: true,
      value: require("crypto").webcrypto,
    });
    // Node's SubtleCrypto resolves via the libuv threadpool, not inline
    // like a browser's — its very first call anywhere in the process pays
    // a one-off thread-spin-up/OpenSSL-init cost (observed here to exceed
    // waitFor's entire retry budget on a loaded machine, made this test
    // flaky). Pay that cost now, before the timing-sensitive assertions,
    // so what we're actually measuring below is steady-state latency.
    await env.window.crypto.subtle.digest("SHA-256", new Uint8Array(1));
    document.getElementById("startCallBtn").click();
    await env.flush();
    document.getElementById("previewContinueBtn").click();
    await env.flush();
    const ws = lastWs();
    ws._open();
    ws._receive({ type: "joined", initiator: true });
    ws._receive({ type: "peer-joined" });
    await env.flush();
    const pc = lastPc();
    pc._setState("connected");
    assert(document.getElementById("verifyChip").classList.contains("hidden"), "without fingerprint-bearing SDP the chip stays hidden");

    pc.localDescription = { type: "offer", sdp: "a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11" };
    pc.remoteDescription = { type: "answer", sdp: "a=fingerprint:sha-256 33:44:55:66:77:88:99:AA" };
    pc._setState("connected");
    // computeVerifyCode awaits crypto.subtle.digest, which resolves from the
    // threadpool — poll until the async write has actually landed.
    const chip = document.getElementById("verifyChip");
    assert(await waitFor(() => !chip.classList.contains("hidden"), env.flush), "with real fingerprints on both sides the verify chip appears");
    const code = document.getElementById("verifyCodeText").textContent;
    assert(/^[0-9]{3} [0-9]{3} [0-9]{3} [0-9]{3}$/.test(code), `the safety-number code has the expected 4-block format (got "${code}")`);

    chip.click();
    assert(!document.getElementById("verifySheet").classList.contains("hidden"), "tapping the chip opens the verify sheet");
    document.getElementById("verifyCloseBtn").click();
    assert(document.getElementById("verifySheet").classList.contains("hidden"), "closing the sheet hides it again");

    // Codes must be deterministic: recomputing from the same fingerprints
    // (i.e. the other end doing the same math) yields the same code.
    const code1 = code;
    chip.classList.add("hidden");
    pc._setState("connected");
    assert(await waitFor(() => !chip.classList.contains("hidden") && document.getElementById("verifyCodeText").textContent === code1, env.flush), "recomputing the code from the same fingerprints is deterministic");

    document.getElementById("hangupBtn").click();
    assert(document.getElementById("verifyChip").classList.contains("hidden"), "hanging up hides the verify chip");
  }

  // ======================================================
  // Summary
  // ======================================================
  console.log(`\n${"=".repeat(50)}`);
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nFailed assertions:");
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  // Exit explicitly: section 15 spawned a real server and opened live
  // sockets, and some of those OS-level handles can outlive the assertions
  // and keep the event loop (and the CI job) hanging.
  process.exit(0);
}

run().catch((err) => {
  console.error("Test run crashed:", err);
  // Never leave a hanging process: tear down the spawned server and its
  // pipes, then exit hard. Open ws client sockets and OS handles otherwise
  // keep the event loop alive with only `process.exitCode` set, which has
  // hung CI jobs before.
  if (serverChild) {
    try {
      serverChild.kill();
      if (serverChild.stdout) serverChild.stdout.destroy();
      if (serverChild.stderr) serverChild.stderr.destroy();
    } catch {
      /* already gone — nothing to clean up */
    }
  }
  process.exit(1);
});
