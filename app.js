require("dotenv").config();
const express = require("express");
const app = express();
const indexrouter = require("./routes/index");
const path = require("path");

const http = require("http");
const socketIO = require("socket.io");
const server = http.createServer(app);
const io = socketIO(server);

// ─── State ────────────────────────────────────────────────────────────────────
let waitingusers = [];
let onlineCount = 0;

// ─── Rate limiter (max 15 messages per 5 seconds per socket) ─────────────────
const MESSAGE_LIMIT = 15;
const RATE_WINDOW_MS = 5000;
const MAX_MESSAGE_LENGTH = 2000;

function checkRateLimit(socket) {
  const now = Date.now();
  if (!socket.data.rateWindow) {
    socket.data.rateWindow = now;
    socket.data.msgCount = 0;
  }
  if (now - socket.data.rateWindow > RATE_WINDOW_MS) {
    socket.data.rateWindow = now;
    socket.data.msgCount = 0;
  }
  socket.data.msgCount++;
  return socket.data.msgCount <= MESSAGE_LIMIT;
}

// ─── Queue helpers ────────────────────────────────────────────────────────────
function removeFromWaiting(socketId) {
  waitingusers = waitingusers.filter((s) => s.id !== socketId);
}

function enqueueForMatch(socket) {
  if (!socket || !socket.connected) return;
  removeFromWaiting(socket.id);
  waitingusers.push(socket);
}

function leaveCurrentRoom(socket, reasonForPartner) {
  const room = socket.data.room;
  if (!room) return [];

  const roomMembers = io.sockets.adapter.rooms.get(room) || new Set();
  const partners = [];

  roomMembers.forEach((memberId) => {
    if (memberId === socket.id) return;
    const partner = io.sockets.sockets.get(memberId);
    if (!partner) return;
    partners.push(partner);
    partner.leave(room);
    partner.data.room = null;
    if (reasonForPartner) partner.emit(reasonForPartner);
  });

  socket.leave(room);
  socket.data.room = null;
  return partners;
}

// ─── Interest-aware matching ──────────────────────────────────────────────────
function scoreMatch(a, b) {
  const tagsA = a.data.interests || [];
  const tagsB = b.data.interests || [];
  if (!tagsA.length || !tagsB.length) return 0;
  const common = tagsA.filter((t) => tagsB.includes(t));
  return common.length;
}

function tryMatchUsers() {
  // First pass: try to match users with common interests
  for (let i = 0; i < waitingusers.length; i++) {
    const first = waitingusers[i];
    if (!first?.connected) { waitingusers.splice(i--, 1); continue; }

    let bestIdx = -1;
    let bestScore = -1;
    for (let j = i + 1; j < waitingusers.length; j++) {
      const second = waitingusers[j];
      if (!second?.connected) { waitingusers.splice(j--, 1); continue; }
      if (first.id === second.id) continue;
      const score = scoreMatch(first, second);
      if (score > bestScore) { bestScore = score; bestIdx = j; }
    }

    if (bestIdx !== -1) {
      const second = waitingusers[bestIdx];
      waitingusers.splice(bestIdx, 1);
      waitingusers.splice(i--, 1);
      pairUsers(first, second);
    }
  }

  // Second pass: pair any remaining users regardless of interests
  while (waitingusers.length >= 2) {
    const first = waitingusers.shift();
    const second = waitingusers.shift();
    if (!first?.connected || !second?.connected || first.id === second.id) {
      if (first?.connected) enqueueForMatch(first);
      if (second?.connected) enqueueForMatch(second);
      continue;
    }
    pairUsers(first, second);
  }
}

function pairUsers(first, second) {
  const roomname = `${first.id}-${second.id}`;
  first.join(roomname);
  second.join(roomname);
  first.data.room = roomname;
  second.data.room = roomname;
  io.to(roomname).emit("joined", roomname);
}

function broadcastUserCount() {
  io.emit("userCount", onlineCount);
}

// ─── Socket events ────────────────────────────────────────────────────────────
io.on("connection", function (socket) {
  socket.data.room = null;
  socket.data.interests = [];
  onlineCount++;
  broadcastUserCount();

  socket.on("joinroom", function ({ interests = [] } = {}) {
    if (socket.data.room) return;
    // Sanitize interests: lowercase, trim, max 10
    socket.data.interests = interests
      .map((t) => String(t).toLowerCase().trim().slice(0, 30))
      .filter(Boolean)
      .slice(0, 10);
    enqueueForMatch(socket);
    tryMatchUsers();
  });

  socket.on("signalingMessage", function (data) {
    socket.broadcast.to(data.room).emit("signalingMessage", data.message);
  });

  socket.on("message", function (data) {
    if (!data.room || !data.message) return;
    if (!checkRateLimit(socket)) {
      socket.emit("rateLimited");
      return;
    }
    const msg = String(data.message).slice(0, MAX_MESSAGE_LENGTH);
    socket.broadcast.to(data.room).emit("message", msg);
  });

  socket.on("startVideoCall", function ({ room }) {
    socket.broadcast.to(room).emit("incomingCall");
  });

  socket.on("acceptCall", function ({ room }) {
    socket.broadcast.to(room).emit("callAccepted");
  });

  socket.on("rejectCall", function ({ room }) {
    socket.broadcast.to(room).emit("callRejected");
  });

  socket.on("typing", function ({ room }) {
    if (!room) return;
    socket.broadcast.to(room).emit("typing");
  });

  socket.on("stopTyping", function ({ room }) {
    if (!room) return;
    socket.broadcast.to(room).emit("stopTyping");
  });

  socket.on("skipStranger", function ({ rematch = true }) {
    const partners = leaveCurrentRoom(socket, "partnerLeft");
    if (rematch) {
      enqueueForMatch(socket);
      socket.emit("searching");
    }
    partners.forEach((partner) => {
      enqueueForMatch(partner);
      partner.emit("searching");
    });
    tryMatchUsers();
  });

  socket.on("disconnect", function () {
    onlineCount = Math.max(0, onlineCount - 1);
    broadcastUserCount();
    removeFromWaiting(socket.id);
    leaveCurrentRoom(socket, "partnerLeft");
  });
});

// ─── Express setup ────────────────────────────────────────────────────────────
app.set("view engine", "ejs");
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/", indexrouter);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
