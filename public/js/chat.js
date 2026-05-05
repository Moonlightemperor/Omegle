/* ============================================================
   Connect — Chat Page Script
   Handles: Socket.IO, WebRTC, messaging, typing, toasts, UI
   ============================================================ */

const socket = io();

// ── DOM refs ───────────────────────────────────────────────────────────────
const chatform = document.querySelector("#chatform");
const messagebox = document.querySelector("#messagebox");
const messagecontainer = document.querySelector("#message-container");
const connectionStatus = document.querySelector("#connection-status");
const connectionStatusText = connectionStatus.querySelector("span:last-child");
const toastContainer = document.querySelector("#toast-container");
const cameraButton = document.querySelector("#cameraButton");
const micButton = document.querySelector("#micButton");
const screenshareButton = document.querySelector("#screenshare-btn");
const hangupButton = document.querySelector("#hangup");
const nextButton = document.querySelector("#next-btn");
const disconnectButton = document.querySelector("#disconnect-btn");
const typingIndicator = document.querySelector("#typing-indicator");
const emojiToggle = document.querySelector("#emoji-toggle");
const emojiPicker = document.querySelector("#emoji-picker");
const permDenied = document.querySelector("#perm-denied");
const permRetry = document.querySelector("#perm-retry");

// ── State ──────────────────────────────────────────────────────────────────
let room;
let isTyping = false;
let typingTimeoutId = null;
let localStream;
let remoteStream;
let peerConnection;
let inCall = false;
let cameraEnabled = true;
let micEnabled = true;
let screenSharing = false;
let origVideoTrack = null;

const rtcSettings = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

// ── Load interests from sessionStorage ─────────────────────────────────────
const interests = JSON.parse(sessionStorage.getItem("connect_interests") || "[]");

// ── Join room on connect ───────────────────────────────────────────────────
socket.emit("joinroom", { interests });

// ── Status helpers ─────────────────────────────────────────────────────────
function setStatus(label, stateClass) {
  connectionStatus.classList.remove("status-connected", "status-offline", "status-busy");
  if (stateClass) connectionStatus.classList.add(stateClass);
  connectionStatusText.textContent = label;
}

// ── Toast ──────────────────────────────────────────────────────────────────
function showToast(message, type = "info", timeout = 2800) {
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.setAttribute("role", "alert");

  const icon = { success: "fa-circle-check", warning: "fa-triangle-exclamation", error: "fa-circle-xmark", info: "fa-circle-info" }[type] || "fa-circle-info";
  toast.innerHTML = `<i class="fas ${icon}"></i><span>${message}</span>`;
  toastContainer.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 250);
  }, timeout);
}

// ── System message ─────────────────────────────────────────────────────────
function insertSystemMessage(text) {
  const el = document.createElement("div");
  el.className = "system-msg";
  el.innerHTML = `<span>${text}</span>`;
  messagecontainer.appendChild(el);
  messagecontainer.scrollTo({ top: messagecontainer.scrollHeight, behavior: "smooth" });
}

// ── Message bubble builders ────────────────────────────────────────────────
function attachMessage(message) {
  const bubble = document.createElement("article");
  bubble.className = "message-row mine message-bubble";

  const body = document.createElement("div");
  body.className = "message";

  const text = document.createElement("p");
  text.className = "message-text";
  text.textContent = message;

  const meta = document.createElement("div");
  meta.className = "message-meta";

  const time = document.createElement("span");
  time.className = "message-time";
  time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const tick = document.createElement("span");
  tick.className = "message-tick";
  tick.innerHTML = '<i class="fas fa-check-double"></i>';
  tick.title = "Sent";

  meta.appendChild(time);
  meta.appendChild(tick);
  body.appendChild(text);
  body.appendChild(meta);
  bubble.appendChild(body);

  document.querySelector(".nobody")?.classList.add("hidden");
  messagecontainer.appendChild(bubble);
  messagecontainer.scrollTo({ top: messagecontainer.scrollHeight, behavior: "smooth" });
}

function receiveMessage(message) {
  const bubble = document.createElement("article");
  bubble.className = "message-row other message-bubble";

  const avatar = document.createElement("span");
  avatar.className = "avatar";
  avatar.innerHTML = '<i class="fas fa-user"></i>';

  const body = document.createElement("div");
  body.className = "message";

  const text = document.createElement("p");
  text.className = "message-text";
  text.textContent = message;

  const time = document.createElement("span");
  time.className = "message-time";
  time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  body.appendChild(text);
  body.appendChild(time);
  bubble.appendChild(avatar);
  bubble.appendChild(body);

  document.querySelector(".nobody")?.classList.add("hidden");
  messagecontainer.appendChild(bubble);
  messagecontainer.scrollTo({ top: messagecontainer.scrollHeight, behavior: "smooth" });
}

// ── Socket events ──────────────────────────────────────────────────────────
setStatus("Connecting...", "");
socket.on("connect", () => setStatus("Connected", "status-connected"));
socket.on("disconnect", () => {
  setStatus("Offline", "status-offline");
  showToast("Connection lost. Reconnecting...", "warning");
});

socket.on("joined", function (roomname) {
  room = roomname;
  document.querySelector(".nobody").classList.add("hidden");
  typingIndicator.classList.add("hidden");
  setStatus("Connected", "status-connected");
  insertSystemMessage("You are now chatting with a stranger ✨");
  showToast("Matched! Say hello 👋", "success");
});

socket.on("searching", function () {
  room = null;
  typingIndicator.classList.add("hidden");
  document.querySelector(".nobody").classList.remove("hidden");
  setStatus("Searching...", "");
  showToast("Searching for a new stranger...", "info");
});

socket.on("partnerLeft", function () {
  room = null;
  typingIndicator.classList.add("hidden");
  document.querySelector(".nobody").classList.remove("hidden");
  insertSystemMessage("Stranger has disconnected.");
  showToast("Stranger left. Finding next match...", "warning");
  setStatus("Searching...", "");
});

socket.on("message", function (message) {
  receiveMessage(message);
});

socket.on("rateLimited", function () {
  showToast("You're sending messages too fast. Slow down!", "warning");
});

// ── Typing indicators ──────────────────────────────────────────────────────
socket.on("typing", () => { if (room) typingIndicator.classList.remove("hidden"); });
socket.on("stopTyping", () => typingIndicator.classList.add("hidden"));

// ── Chat form submit ───────────────────────────────────────────────────────
chatform.addEventListener("submit", function (event) {
  event.preventDefault();
  const trimmedMessage = messagebox.value.trim();
  if (!trimmedMessage || !room) return;
  socket.emit("message", { room, message: trimmedMessage });
  socket.emit("stopTyping", { room });
  attachMessage(trimmedMessage);
  messagebox.value = "";
  messagebox.style.height = "auto";
  isTyping = false;
});

messagebox.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatform.requestSubmit();
  }
});

messagebox.addEventListener("input", () => {
  messagebox.style.height = "auto";
  messagebox.style.height = `${Math.min(messagebox.scrollHeight, 120)}px`;
  if (!room) return;
  const hasText = messagebox.value.trim().length > 0;
  if (hasText && !isTyping) { isTyping = true; socket.emit("typing", { room }); }
  if (typingTimeoutId) clearTimeout(typingTimeoutId);
  typingTimeoutId = setTimeout(() => {
    if (isTyping) { socket.emit("stopTyping", { room }); isTyping = false; }
  }, 800);
});

// ── Emoji picker ───────────────────────────────────────────────────────────
const EMOJI_LIST = ["😀","😂","😍","🥺","😭","😎","🤔","😅","🙏","❤️","🔥","✨","👍","👋","🎉","💯","😤","🤣","😊","🥰","😏","🤩","😴","🤯","🤗","😢","😁","😜","🤑","👀"];

function buildEmojiPicker() {
  emojiPicker.innerHTML = "";
  EMOJI_LIST.forEach(em => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "emoji-btn";
    btn.textContent = em;
    btn.addEventListener("click", () => {
      messagebox.value += em;
      messagebox.focus();
      emojiPicker.classList.add("hidden");
    });
    emojiPicker.appendChild(btn);
  });
}

buildEmojiPicker();

emojiToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  emojiPicker.classList.toggle("hidden");
});

document.addEventListener("click", (e) => {
  if (!emojiPicker.contains(e.target) && e.target !== emojiToggle) {
    emojiPicker.classList.add("hidden");
  }
});

// ── Nav button events ──────────────────────────────────────────────────────
document.querySelector("#video-call-btn").addEventListener("click", function () {
  if (!room) { showToast("Wait for a match before starting a call.", "warning"); return; }
  socket.emit("startVideoCall", { room });
  showToast("Calling stranger...", "info");
});

nextButton.addEventListener("click", function () {
  if (inCall) hangup();
  // Clear message area
  Array.from(messagecontainer.querySelectorAll(".message-bubble, .system-msg")).forEach(el => el.remove());
  socket.emit("skipStranger", { rematch: true });
});

disconnectButton.addEventListener("click", function () {
  if (inCall) hangup();
  Array.from(messagecontainer.querySelectorAll(".message-bubble, .system-msg")).forEach(el => el.remove());
  socket.emit("skipStranger", { rematch: false });
  room = null;
  typingIndicator.classList.add("hidden");
  document.querySelector(".nobody").classList.remove("hidden");
  setStatus("Disconnected", "status-offline");
  showToast("Disconnected from current stranger.", "info");
});

// ── Incoming call modal ────────────────────────────────────────────────────
socket.on("incomingCall", function () {
  document.querySelector("#incoming-call").classList.remove("hidden");
  showToast("Incoming video call request.", "info");
});

document.querySelector("#accept-call").addEventListener("click", function () {
  document.querySelector("#incoming-call").classList.add("hidden");
  initializeCall();
  document.querySelector(".videoblock").classList.remove("hidden");
  socket.emit("acceptCall", { room });
  showToast("Call accepted.", "success");
});

document.querySelector("#reject-call").addEventListener("click", function () {
  document.querySelector("#incoming-call").classList.add("hidden");
  socket.emit("rejectCall", { room });
  showToast("Call rejected.", "warning");
});

socket.on("callAccepted", function () {
  initializeCall();
  document.querySelector(".videoblock").classList.remove("hidden");
});

socket.on("callRejected", function () {
  showToast("Call rejected by the other user.", "warning");
});

// ── WebRTC ─────────────────────────────────────────────────────────────────
const initializeCall = async () => {
  socket.on("signalingMessage", handleSignalingMessage);
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    document.querySelector("#localVideo").srcObject = localStream;
    document.querySelector("#localVideo").style.display = "block";
    setMediaButtonState();
    initiateOffer();
    inCall = true;
    permDenied.classList.add("hidden");
  } catch (err) {
    console.error("Media device error:", err);
    document.querySelector(".videoblock").classList.add("hidden");
    permDenied.classList.remove("hidden");
    showToast("Camera/microphone permission denied.", "error");
  }
};

permRetry.addEventListener("click", () => {
  permDenied.classList.add("hidden");
  initializeCall();
});

function setMediaButtonState() {
  cameraButton.classList.toggle("video-btn-off", !cameraEnabled);
  micButton.classList.toggle("video-btn-off", !micEnabled);
  cameraButton.innerHTML = cameraEnabled ? '<i class="fas fa-video"></i>' : '<i class="fas fa-video-slash"></i>';
  micButton.innerHTML = micEnabled ? '<i class="fas fa-microphone"></i>' : '<i class="fas fa-microphone-slash"></i>';
  cameraButton.setAttribute("aria-pressed", String(!cameraEnabled));
  micButton.setAttribute("aria-pressed", String(!micEnabled));
}

const initiateOffer = async () => {
  await createPeerConnection();
  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit("signalingMessage", { room, message: JSON.stringify({ type: "offer", offer }) });
  } catch (err) {
    console.error("Error creating offer:", err);
  }
};

const createPeerConnection = () => {
  peerConnection = new RTCPeerConnection(rtcSettings);
  remoteStream = new MediaStream();
  document.querySelector("#remoteVideo").srcObject = remoteStream;
  document.querySelector("#remoteVideo").style.display = "block";
  document.querySelector("#localVideo").classList.add("smallFrame");

  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  peerConnection.ontrack = (event) => {
    event.streams[0].getTracks().forEach(track => remoteStream.addTrack(track));
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("signalingMessage", { room, message: JSON.stringify({ type: "candidate", candidate: event.candidate }) });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    if (state === "connected") {
      setStatus("In call", "status-busy");
      showToast("Video call connected.", "success");
    } else if (state === "failed" || state === "disconnected") {
      showToast("Call connection interrupted.", "warning");
    }
  };
};

const handleSignalingMessage = async (message) => {
  const { type, offer, answer, candidate } = JSON.parse(message);
  if (type === "offer") handleOffer(offer);
  if (type === "answer") handleAnswer(answer);
  if (type === "candidate" && peerConnection) {
    try { await peerConnection.addIceCandidate(candidate); }
    catch (e) { console.error(e); }
  }
  if (type === "hangup") hangup();
};

const handleOffer = async (offer) => {
  await createPeerConnection();
  try {
    await peerConnection.setRemoteDescription(offer);
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit("signalingMessage", { room, message: JSON.stringify({ type: "answer", answer }) });
    inCall = true;
  } catch (e) { console.error("Failed to handle offer:", e); }
};

const handleAnswer = async (answer) => {
  try { await peerConnection.setRemoteDescription(answer); }
  catch (e) { console.error("Failed to handle answer:", e); }
};

function hangup() {
  if (!peerConnection) return;
  peerConnection.close();
  peerConnection = null;
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  document.querySelector(".videoblock").classList.add("hidden");
  socket.emit("signalingMessage", { room, message: JSON.stringify({ type: "hangup" }) });
  inCall = false;
  screenSharing = false;
  screenshareButton.classList.remove("screen-active");
  screenshareButton.innerHTML = '<i class="fas fa-desktop"></i>';
  setStatus("Connected", "status-connected");
  showToast("Call ended.", "info");
}

// ── Camera toggle ──────────────────────────────────────────────────────────
cameraButton.addEventListener("click", () => {
  if (!localStream) return;
  cameraEnabled = !cameraEnabled;
  localStream.getVideoTracks().forEach(t => { t.enabled = cameraEnabled; });
  setMediaButtonState();
});

// ── Mic toggle ─────────────────────────────────────────────────────────────
micButton.addEventListener("click", () => {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(t => { t.enabled = micEnabled; });
  setMediaButtonState();
});

// ── Hangup button ──────────────────────────────────────────────────────────
hangupButton.addEventListener("click", hangup);

// ── Screen Share ───────────────────────────────────────────────────────────
screenshareButton.addEventListener("click", async () => {
  if (!inCall || !peerConnection) { showToast("Start a call before sharing screen.", "warning"); return; }
  if (!screenSharing) {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const screenTrack = screenStream.getVideoTracks()[0];
      origVideoTrack = localStream.getVideoTracks()[0];
      const sender = peerConnection.getSenders().find(s => s.track?.kind === "video");
      if (sender) sender.replaceTrack(screenTrack);
      document.querySelector("#localVideo").srcObject = screenStream;
      screenSharing = true;
      screenshareButton.classList.add("screen-active");
      screenshareButton.innerHTML = '<i class="fas fa-desktop-slash"></i>';
      showToast("Screen sharing started.", "info");
      screenTrack.onended = () => stopScreenShare(sender);
    } catch (e) { showToast("Screen share cancelled or denied.", "warning"); }
  } else {
    stopScreenShare(peerConnection.getSenders().find(s => s.track?.kind === "video"));
  }
});

function stopScreenShare(sender) {
  if (origVideoTrack && sender) sender.replaceTrack(origVideoTrack);
  if (localStream) document.querySelector("#localVideo").srcObject = localStream;
  screenSharing = false;
  screenshareButton.classList.remove("screen-active");
  screenshareButton.innerHTML = '<i class="fas fa-desktop"></i>';
  showToast("Screen sharing stopped.", "info");
}

// ── Keyboard shortcut: Escape ends call ────────────────────────────────────
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && inCall) hangup();
});
