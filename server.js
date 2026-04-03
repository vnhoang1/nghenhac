const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.disable('x-powered-by');

const server = http.createServer(app);

const PORT = Number(process.env.PORT) || 3000;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const CLOUDINARY_ENABLED = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);
const CORS_ORIGIN = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((item) => item.trim()).filter(Boolean)
  : true;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

function extractVideoId(input) {
  if (!input) return '';
  const raw = String(input).trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw;

  try {
    const url = new URL(raw);
    if (url.hostname.includes('youtu.be')) {
      return url.pathname.replace(/^\//, '').slice(0, 11);
    }
    const v = url.searchParams.get('v');
    if (v) return v.slice(0, 11);
    const shorts = url.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
    if (shorts) return shorts[1];
    const embed = url.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
    if (embed) return embed[1];
  } catch (_) {}

  return '';
}

async function fetchVideoTitle(videoId) {
  const urls = [
    `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
    `https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'listen-together-app' }
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data && typeof data.title === 'string' && data.title.trim()) {
        return data.title.trim();
      }
    } catch (_) {}
  }

  return `YouTube ${videoId}`;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function createRoom(roomId) {
  return {
    roomId,
    queue: [],
    currentIndex: -1,
    playback: {
      videoId: '',
      isPlaying: false,
      startedAt: null,
      pausedAt: 0,
      updatedAt: nowSec()
    },
    chat: [],
    users: {},
    ownerSocketId: null,
    createdAt: Date.now(),
    lastActiveAt: Date.now()
  };
}

const rooms = new Map();

function touchRoom(room) {
  room.lastActiveAt = Date.now();
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    const room = createRoom(roomId);

    room.queue.push({
      id: Math.random().toString(36).slice(2, 10),
      videoId: 'jfKfPfyJRdk',
      title: 'Lofi hip hop radio',
      addedBy: 'System'
    });

    room.currentIndex = 0;
    room.playback = {
      videoId: 'jfKfPfyJRdk',
      isPlaying: false,
      startedAt: null,
      pausedAt: 0,
      updatedAt: nowSec()
    };

    rooms.set(roomId, room);
  }

  const room = rooms.get(roomId);
  touchRoom(room);
  return room;
}

function getPlaybackPosition(playback) {
  if (!playback.videoId) return 0;

  if (playback.isPlaying && playback.startedAt != null) {
    return Math.max(0, nowSec() - playback.startedAt);
  }

  return Math.max(0, playback.pausedAt || 0);
}

function syncState(room, viewerSocketId = '') {
  return {
    roomId: room.roomId,
    queue: room.queue,
    currentIndex: room.currentIndex,
    playback: {
      ...room.playback,
      position: getPlaybackPosition(room.playback)
    },
    chat: room.chat.slice(-100),
    users: Object.values(room.users),
    ownerSocketId: room.ownerSocketId,
    ownerName: room.users[room.ownerSocketId]?.name || '',
    meId: viewerSocketId || ''
  };
}

function broadcastRoom(roomId) {
  const room = getRoom(roomId);
  io.to(roomId).emit('room:state', syncState(room));
}

function isOwner(room, socketId) {
  return room.ownerSocketId === socketId;
}

function normalizeRoles(room) {
  Object.values(room.users).forEach((user) => {
    user.role = user.id === room.ownerSocketId ? 'owner' : 'member';
  });
}

function moveToTrack(room, index, autoplay = true) {
  if (index < 0 || index >= room.queue.length) return;

  room.currentIndex = index;
  const item = room.queue[index];

  room.playback.videoId = item.videoId;
  room.playback.updatedAt = nowSec();

  if (autoplay) {
    room.playback.isPlaying = true;
    room.playback.startedAt = nowSec();
    room.playback.pausedAt = 0;
  } else {
    room.playback.isPlaying = false;
    room.playback.startedAt = null;
    room.playback.pausedAt = 0;
  }
}

function swapQueue(room, fromIndex, toIndex) {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= room.queue.length ||
    toIndex >= room.queue.length ||
    fromIndex === toIndex
  ) {
    return false;
  }

  const [moved] = room.queue.splice(fromIndex, 1);
  room.queue.splice(toIndex, 0, moved);

  if (room.currentIndex === fromIndex) {
    room.currentIndex = toIndex;
  } else if (fromIndex < room.currentIndex && toIndex >= room.currentIndex) {
    room.currentIndex -= 1;
  } else if (fromIndex > room.currentIndex && toIndex <= room.currentIndex) {
    room.currentIndex += 1;
  }

  return true;
}

function removeFromQueue(room, index) {
  if (index < 0 || index >= room.queue.length) return null;

  const [removed] = room.queue.splice(index, 1);

  if (room.queue.length === 0) {
    room.currentIndex = -1;
    room.playback = {
      videoId: '',
      isPlaying: false,
      startedAt: null,
      pausedAt: 0,
      updatedAt: nowSec()
    };
    return removed;
  }

  if (index < room.currentIndex) {
    room.currentIndex -= 1;
  } else if (index === room.currentIndex) {
    const nextIndex = Math.min(index, room.queue.length - 1);
    moveToTrack(room, nextIndex, true);
  }

  return removed;
}

function cleanupRoomIfEmpty(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (Object.keys(room.users).length === 0) {
    rooms.delete(roomId);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    const idleFor = now - (room.lastActiveAt || room.createdAt || now);
    if (Object.keys(room.users).length === 0 && idleFor > 1000 * 60 * 60 * 4) {
      rooms.delete(roomId);
    }
  }
}, 1000 * 60 * 10);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), rooms: rooms.size });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

app.post('/api/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Không có file' });
  if (!CLOUDINARY_ENABLED) {
    return res.status(503).json({ error: 'Image upload chưa được bật trên server' });
  }

  try {
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: 'listen-together', transformation: [{ width: 800, crop: 'limit' }] },
        (err, uploadResult) => err ? reject(err) : resolve(uploadResult)
      ).end(req.file.buffer);
    });

    res.json({ url: result.secure_url });
  } catch (err) {
    console.error('Cloudinary upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/youtube/search', async (req, res) => {
  const q = String(req.query.q || '').trim();

  if (!q) {
    return res.json({ items: [] });
  }

  if (!YOUTUBE_API_KEY) {
    return res.status(503).json({ items: [], error: 'Thiếu YOUTUBE_API_KEY trên server' });
  }

  try {
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('type', 'video');
    url.searchParams.set('maxResults', '10');
    url.searchParams.set('q', q);
    url.searchParams.set('key', YOUTUBE_API_KEY);

    const response = await fetch(url.toString(), {
      headers: { 'User-Agent': 'listen-together-app' }
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('YouTube API error:', response.status, text);
      return res.status(500).json({ items: [] });
    }

    const data = await response.json();
    const items = (data.items || [])
      .map((item) => ({
        videoId: item?.id?.videoId || '',
        title: item?.snippet?.title || 'Không có tiêu đề',
        channelTitle: item?.snippet?.channelTitle || '',
        thumbnail:
          item?.snippet?.thumbnails?.medium?.url ||
          item?.snippet?.thumbnails?.default?.url ||
          ''
      }))
      .filter((item) => item.videoId);

    return res.json({ items });
  } catch (err) {
    console.error('YouTube search failed:', err);
    return res.status(500).json({ items: [] });
  }
});

io.on('connection', (socket) => {
  socket.on('room:join', ({ roomId, name, authUser }) => {
    const safeRoomId = String(roomId || 'main-room').trim() || 'main-room';
    const safeName = String(name || authUser?.name || 'Khách').trim() || 'Khách';

    if (socket.data.roomId && socket.data.roomId !== safeRoomId) {
      socket.leave(socket.data.roomId);
    }

    socket.data.roomId = safeRoomId;
    socket.data.name = safeName;
    socket.data.authUser = authUser || null;

    socket.join(safeRoomId);

    const room = getRoom(safeRoomId);
    const isFirstUser = Object.keys(room.users).length === 0;
    if (!room.ownerSocketId || isFirstUser) room.ownerSocketId = socket.id;
    room.users[socket.id] = {
      id: socket.id,
      name: safeName,
      email: authUser?.email || '',
      role: room.ownerSocketId === socket.id ? 'owner' : 'member'
    };

    socket.emit('room:state', syncState(room, socket.id));

    room.chat.push({
      id: Math.random().toString(36).slice(2, 10),
      user: 'System',
      text: `${safeName} đã vào phòng`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });

    normalizeRoles(room);
    touchRoom(room);
    broadcastRoom(safeRoomId);
  });

  socket.on('queue:add', async ({ url, title }) => {
    const roomId = socket.data.roomId;
    if (!roomId) {
      socket.emit('toast', { type: 'error', message: 'Bạn phải vào phòng trước' });
      return;
    }

    const room = getRoom(roomId);
    const videoId = extractVideoId(url);

    if (!videoId) {
      socket.emit('toast', { type: 'error', message: 'Link YouTube không hợp lệ' });
      return;
    }

    const resolvedTitle = String(title || '').trim() || (await fetchVideoTitle(videoId));

    const item = {
      id: Math.random().toString(36).slice(2, 10),
      videoId,
      title: resolvedTitle,
      addedBy: socket.data.name || 'Khách'
    };

    room.queue.push(item);

    if (room.currentIndex === -1) {
      moveToTrack(room, 0, false);
    }

    room.chat.push({
      id: Math.random().toString(36).slice(2, 10),
      user: 'System',
      text: `${socket.data.name} đã thêm: ${resolvedTitle}`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });

    touchRoom(room);
    broadcastRoom(roomId);
  });

  socket.on('queue:move', ({ fromIndex, toIndex }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = getRoom(roomId);
    const ok = swapQueue(room, Number(fromIndex), Number(toIndex));
    if (!ok) return;

    touchRoom(room);
    broadcastRoom(roomId);
  });

  socket.on('queue:remove', ({ index }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = getRoom(roomId);
    const removed = removeFromQueue(room, Number(index));
    if (!removed) return;

    room.chat.push({
      id: Math.random().toString(36).slice(2, 10),
      user: 'System',
      text: `${socket.data.name} đã xóa: ${removed.title}`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });

    io.to(roomId).emit('playback:update', {
      action: room.playback.videoId ? 'load' : 'pause',
      videoId: room.playback.videoId,
      position: getPlaybackPosition(room.playback),
      updatedAt: room.playback.updatedAt
    });

    touchRoom(room);
    broadcastRoom(roomId);
  });

  socket.on('track:select', ({ index }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = getRoom(roomId);
    moveToTrack(room, Number(index), true);

    io.to(roomId).emit('playback:update', {
      action: 'load',
      videoId: room.playback.videoId,
      position: 0,
      updatedAt: room.playback.updatedAt
    });

    touchRoom(room);
    broadcastRoom(roomId);
  });

  socket.on('playback:play', ({ position }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = getRoom(roomId);
    const pos = Math.max(0, Number(position || 0));

    room.playback.isPlaying = true;
    room.playback.startedAt = nowSec() - pos;
    room.playback.pausedAt = 0;
    room.playback.updatedAt = nowSec();

    io.to(roomId).emit('playback:update', {
      action: 'play',
      videoId: room.playback.videoId,
      position: pos,
      updatedAt: room.playback.updatedAt
    });

    touchRoom(room);
    broadcastRoom(roomId);
  });

  socket.on('playback:pause', ({ position }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = getRoom(roomId);
    const pos = Math.max(0, Number(position || 0));

    room.playback.isPlaying = false;
    room.playback.pausedAt = pos;
    room.playback.startedAt = null;
    room.playback.updatedAt = nowSec();

    io.to(roomId).emit('playback:update', {
      action: 'pause',
      videoId: room.playback.videoId,
      position: pos,
      updatedAt: room.playback.updatedAt
    });

    touchRoom(room);
    broadcastRoom(roomId);
  });

  socket.on('playback:seek', ({ position }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = getRoom(roomId);
    const pos = Math.max(0, Number(position || 0));

    if (room.playback.isPlaying) {
      room.playback.startedAt = nowSec() - pos;
      room.playback.pausedAt = 0;
    } else {
      room.playback.pausedAt = pos;
    }

    room.playback.updatedAt = nowSec();

    io.to(roomId).emit('playback:update', {
      action: 'seek',
      videoId: room.playback.videoId,
      position: pos,
      updatedAt: room.playback.updatedAt
    });

    touchRoom(room);
    broadcastRoom(roomId);
  });

  socket.on('track:next', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room.queue.length) return;

    const nextIndex = room.currentIndex < room.queue.length - 1 ? room.currentIndex + 1 : 0;

    moveToTrack(room, nextIndex, true);

    io.to(roomId).emit('playback:update', {
      action: 'load',
      videoId: room.playback.videoId,
      position: 0,
      updatedAt: room.playback.updatedAt
    });

    touchRoom(room);
    broadcastRoom(roomId);
  });

  socket.on('chat:send', ({ text }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = getRoom(roomId);
    const safeText = String(text || '').trim();
    if (!safeText) return;

    const msg = {
      id: Math.random().toString(36).slice(2, 10),
      user: socket.data.name || 'Khách',
      text: safeText,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    room.chat.push(msg);
    io.to(roomId).emit('chat:new', msg);
    touchRoom(room);
    broadcastRoom(roomId);
  });

  socket.on('chat:image', ({ url }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = getRoom(roomId);
    const safeUrl = String(url || '').trim();
    if (!safeUrl.startsWith('https://res.cloudinary.com/')) return;

    const msg = {
      id: Math.random().toString(36).slice(2, 10),
      user: socket.data.name || 'Khách',
      image: safeUrl,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    room.chat.push(msg);
    io.to(roomId).emit('chat:new', msg);
    touchRoom(room);
  });

  socket.on('reaction:send', ({ emoji }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    io.to(roomId).emit('reaction:new', {
      id: Math.random().toString(36).slice(2, 10),
      emoji: String(emoji || '❤️').slice(0, 4)
    });
  });

  socket.on('member:kick', ({ targetId }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!isOwner(room, socket.id)) {
      socket.emit('toast', { type: 'error', message: 'Chỉ chủ phòng mới được kick thành viên' });
      return;
    }
    if (!targetId || targetId === socket.id || !room.users[targetId]) return;

    const targetName = room.users[targetId].name;
    delete room.users[targetId];
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
      targetSocket.leave(roomId);
      targetSocket.data.roomId = null;
      targetSocket.emit('room:kicked', { roomId, message: 'Bạn đã bị chủ phòng kick khỏi phòng.' });
    }
    room.chat.push({
      id: Math.random().toString(36).slice(2, 10),
      user: 'System',
      text: `${targetName} đã bị kick khỏi phòng`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
    normalizeRoles(room);
    touchRoom(room);
    broadcastRoom(roomId);
    cleanupRoomIfEmpty(roomId);
  });

  socket.on('member:transfer-owner', ({ targetId }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!isOwner(room, socket.id)) {
      socket.emit('toast', { type: 'error', message: 'Chỉ chủ phòng mới được trao quyền quản lý' });
      return;
    }
    if (!targetId || targetId === socket.id || !room.users[targetId]) return;

    room.ownerSocketId = targetId;
    normalizeRoles(room);
    room.chat.push({
      id: Math.random().toString(36).slice(2, 10),
      user: 'System',
      text: `${socket.data.name} đã trao quyền chủ phòng cho ${room.users[targetId].name}`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
    touchRoom(room);
    broadcastRoom(roomId);
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = getRoom(roomId);
    const name = socket.data.name || 'Khách';

    const wasOwner = room.ownerSocketId === socket.id;
    delete room.users[socket.id];

    if (wasOwner) {
      const nextOwner = Object.keys(room.users)[0] || null;
      room.ownerSocketId = nextOwner;
      normalizeRoles(room);
      if (nextOwner && room.users[nextOwner]) {
        room.chat.push({
          id: Math.random().toString(36).slice(2, 10),
          user: 'System',
          text: `${room.users[nextOwner].name} trở thành chủ phòng mới`,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
      }
    }

    room.chat.push({
      id: Math.random().toString(36).slice(2, 10),
      user: 'System',
      text: `${name} đã rời phòng`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });

    touchRoom(room);
    broadcastRoom(roomId);
    cleanupRoomIfEmpty(roomId);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Cloudinary upload: ${CLOUDINARY_ENABLED ? 'enabled' : 'disabled'}`);
  console.log(`YouTube search: ${YOUTUBE_API_KEY ? 'enabled' : 'disabled'}`);
});
