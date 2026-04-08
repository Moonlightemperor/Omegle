const express = require("express");
const app = express();
const indexrouter = require("./routes/index");
const path = require("path");

const http = require("http");
const socketIO = require("socket.io");
const server = http.createServer(app);
const io = socketIO(server);

let waitingusers = [];

function removeFromWaiting(socketId) {
  waitingusers = waitingusers.filter((queuedSocket) => queuedSocket.id !== socketId);
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
    if (reasonForPartner) {
      partner.emit(reasonForPartner);
    }
  });

  socket.leave(room);
  socket.data.room = null;
  return partners;
}

function tryMatchUsers() {
  
  
  
  
  while (waitingusers.length > 1) {
    const first = waitingusers.shift();
    const second = waitingusers.shift();

    if (!first?.connected || !second?.connected || first.id === second.id) {
      if (first?.connected) enqueueForMatch(first);
      if (second?.connected) enqueueForMatch(second);
      continue;
    }

    const roomname = `${first.id}-${second.id}`;
    first.join(roomname);
    second.join(roomname);
    first.data.room = roomname;
    second.data.room = roomname;

    io.to(roomname).emit("joined", roomname);
  }
}

io.on("connection", function (socket) {
  socket.data.room = null;

  socket.on("joinroom", function () {
    if (socket.data.room) return;
    enqueueForMatch(socket);
    tryMatchUsers();
  });

  socket.on("signalingMessage", function (data){
    socket.broadcast.to(data.room).emit("signalingMessage",data.message);
  })

  socket.on("message", function (data) {
    socket.broadcast.to(data.room).emit("message", data.message);
  });

  socket.on("startVideoCall", function({room}){
    socket.broadcast.to(room).emit("incomingCall");
  })

  socket.on("acceptCall", function({room}){
    socket.broadcast.to(room).emit("callAccepted");
  });

  socket.on("rejectCall", function({room}){
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
    removeFromWaiting(socket.id);
    leaveCurrentRoom(socket, "partnerLeft");
  });
});
app.set("view engine", "ejs");
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.use("/", indexrouter);

server.listen(3000);
