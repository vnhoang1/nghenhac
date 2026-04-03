const socket = io();

const MAX_QUEUE_SIZE = 200;
const NEXT_EMIT_LOCK_MS = 2500;
const SEARCH_DEBOUNCE_MS = 400;
const SEARCH_LIMIT = 8;

let player = null;
let playerReady = false;
let playerCreated = false;
let latestState = null;
let joinedRoom = false;
let localUserUnlocked = false;
let suppressPlayerEventsUntil = 0;
let syncingFromServer = false;
let hiddenPauseGuardUntil = 0;
let nextTrackEmitLockedUntil = 0;
let lastLoadedVideoId = '';
let recentTrackSwitchUntil = 0;
let searchDebounceTimer = null;
let currentSearchToken = 0;

// ── Volume state ────────────────────────────────────────────────
let isMuted = false;
let lastVolume = 80;

const els = {
  nameInput: document.getElementById('nameInput'),
  roomInput: document.getElementById('roomInput'),
  joinBtn: document.getElementById('joinBtn'),
  urlInput: document.getElementById('urlInput'),
  addBtn: document.getElementById('addBtn'),
  searchInput: document.getElementById('searchInput'),
  searchBtn: document.getElementById('searchBtn'),
  searchResults: document.getElementById('searchResults'),
  queueList: document.getElementById('queueList'),
  chatList: document.getElementById('chatList'),
  memberList: document.getElementById('memberList'),
  chatInput: document.getElementById('chatInput'),
  sendBtn: document.getElementById('sendBtn'),
  playBtn: document.getElementById('playBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  nextBtn: document.getElementById('nextBtn'),
  trackMeta: document.getElementById('trackMeta'),
  roomSummary: document.getElementById('roomSummary'),
  statusBadge: document.getElementById('statusBadge'),
  reactions: document.getElementById('reactions'),
  volumeSlider: document.getElementById('volumeSlider'),
  muteBtn: document.getElementById('muteBtn'),
  volumeLabel: document.getElementById('volumeLabel'),
  currentArtwork: document.getElementById('currentArtwork'),
  currentTitle: document.getElementById('currentTitle'),
  myRoleLabel: document.getElementById('myRoleLabel'),
  ownerLabel: document.getElementById('ownerLabel'),
};

function toast(message) {
  alert(message);
}


function youtubeThumb(videoId, quality = 'hqdefault') {
  if (!videoId) return '';
  return `https://i.ytimg.com/vi/${videoId}/${quality}.jpg`;
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() || '').join('') || '?';
}

function currentViewerName() {
  return (els.nameInput?.value || '').trim();
}

function currentAuthUser() {
  try { return JSON.parse(localStorage.getItem('munote_auth_user') || 'null'); } catch (_) { return null; }
}

function getMeUser(users = []) {
  return users.find((u) => u.id === socket.id) || users.find((u) => u.name === currentViewerName()) || null;
}


function nowSec() {
  return Date.now() / 1000;
}

function escapeHtml(str) {
  return String(str || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getExpectedPosition(playback) {
  if (!playback || !playback.videoId) return 0;

  if (playback.isPlaying && playback.startedAt != null) {
    return Math.max(0, nowSec() - playback.startedAt);
  }

  return Math.max(0, playback.pausedAt || playback.position || 0);
}

function getCurrentVideoId() {
  try {
    return player?.getVideoData?.().video_id || '';
  } catch {
    return '';
  }
}

function getCurrentTimeSafe() {
  try {
    return Number(player?.getCurrentTime?.() || 0);
  } catch {
    return 0;
  }
}

function setSuppress(ms = 1200) {
  suppressPlayerEventsUntil = Date.now() + ms;
}

function isSuppressed() {
  return Date.now() < suppressPlayerEventsUntil;
}

function canEmitNextTrack() {
  return Date.now() >= nextTrackEmitLockedUntil;
}

function lockEmitNextTrack(ms = NEXT_EMIT_LOCK_MS) {
  nextTrackEmitLockedUntil = Date.now() + ms;
}

function requestNextTrack(reason = 'ended') {
  if (!joinedRoom) return;
  if (!canEmitNextTrack()) return;

  // Khi phát hết playlist → tự động quay lại đầu danh sách
  if (reason === 'ended') {
    const queue = latestState?.queue || [];
    if (queue.length > 0) {
      lockEmitNextTrack();
      console.log('[loop] restarting queue from index 0');
      socket.emit('track:select', { index: 0 });
      return;
    }
  }

  lockEmitNextTrack();
  console.log('[next track]', reason);
  socket.emit('track:next');
}

function updateHeader(playback, currentItem, usersCount) {
  const expected = Math.floor(getExpectedPosition(playback));

  if (!playback?.videoId) {
    els.currentTitle.textContent = 'Chưa có bài nào';
    els.trackMeta.textContent = 'Tham gia một room để bắt đầu nghe.';
    els.statusBadge.textContent = 'Chưa phát';
    els.roomSummary.textContent = `${usersCount} người · Chưa có video`;
    if (els.currentArtwork) {
      els.currentArtwork.style.backgroundImage = "linear-gradient(135deg, rgba(255, 122, 69, 0.22), rgba(255,255,255,0.04)), url('/munote-images/bg4.jpg')";
    }
    return;
  }

  const title = currentItem?.title || `Video ${playback.videoId}`;
  const addedBy = currentItem?.addedBy || 'Phòng nghe';
  els.currentTitle.textContent = title;
  els.trackMeta.textContent = `Thêm bởi ${addedBy} · khoảng ${expected}s · ${playback.isPlaying ? 'đang phát' : 'tạm dừng'}`;
  els.statusBadge.textContent = playback.isPlaying ? 'Đang phát' : 'Tạm dừng';
  els.roomSummary.textContent = `${usersCount} người · ${playback.isPlaying ? 'Đang phát' : 'Đang tạm dừng'} · ~${expected}s`;

  if (els.currentArtwork) {
    const thumb = youtubeThumb(playback.videoId, 'maxresdefault');
    els.currentArtwork.style.backgroundImage = `linear-gradient(135deg, rgba(255, 122, 69, 0.22), rgba(255,255,255,0.04)), url('${thumb}')`;
  }
}

function renderMembers(users = []) {
  const me = getMeUser(users);
  const isOwnerMe = me?.role === 'owner';
  const owner = users.find((u) => u.role === 'owner');

  if (els.myRoleLabel) {
    els.myRoleLabel.textContent = me ? (me.role === 'owner' ? 'Chủ phòng' : 'Thành viên') : 'Chưa vào phòng';
  }
  if (els.ownerLabel) {
    els.ownerLabel.textContent = owner?.name || 'Chưa có';
  }

  els.memberList.innerHTML = users
    .map((u) => {
      const isSelf = u.id === socket.id;
      const canManage = isOwnerMe && !isSelf;
      return `
        <div class="member-card ${u.role === 'owner' ? 'is-owner' : ''}">
          <div class="member-main">
            <span class="member-avatar">${escapeHtml(initials(u.name))}</span>
            <div>
              <strong>${escapeHtml(u.name)}</strong>
              <div class="member-role-row">
                <span class="member-chip ${u.role === 'owner' ? 'owner' : ''}">${u.role === 'owner' ? 'Chủ phòng' : 'Thành viên'}</span>
                ${isSelf ? '<span class="member-chip subtle">Bạn</span>' : ''}
              </div>
            </div>
          </div>
          ${canManage ? `
            <div class="member-actions-inline">
              <button class="ghost small-chip" data-transfer-owner="${u.id}" type="button">Trao quyền</button>
              <button class="ghost small-chip danger-chip" data-kick-member="${u.id}" type="button">Kick</button>
            </div>` : ''}
        </div>
      `;
    })
    .join('');

  els.memberList.querySelectorAll('[data-kick-member]').forEach((node) => {
    node.onclick = () => socket.emit('member:kick', { targetId: node.dataset.kickMember });
  });
  els.memberList.querySelectorAll('[data-transfer-owner]').forEach((node) => {
    node.onclick = () => socket.emit('member:transfer-owner', { targetId: node.dataset.transferOwner });
  });
}

function renderChat(chat = []) {
  const me = currentViewerName();

  els.chatList.innerHTML = chat
    .map((msg) => {
      const isSystem = String(msg.user || '').toLowerCase() === 'system';
      const isSelf = !isSystem && me && msg.user === me;
      return `
        <div class="chat-item ${isSystem ? 'is-system' : ''} ${isSelf ? 'is-self' : ''}">
          <div class="chat-head">
            <div class="chat-name-wrap">
              <span class="chat-avatar">${escapeHtml(initials(msg.user))}</span>
              <strong class="chat-name">${escapeHtml(msg.user)}</strong>
            </div>
            <span class="chat-time">${escapeHtml(msg.time)}</span>
          </div>
          <div class="chat-body ${isSystem ? 'system' : ''}">
            ${msg.image
              ? `<img src="${escapeHtml(msg.image)}" alt="image" style="cursor:pointer" onclick="window.open(this.src)">`
              : escapeHtml(msg.text)
            }
          </div>
        </div>
      `;
    })
    .join('');

  els.chatList.scrollTop = els.chatList.scrollHeight;
}

function bindQueueActions() {
  els.queueList.querySelectorAll('[data-select-index]').forEach((node) => {
    node.onclick = () => {
      socket.emit('track:select', { index: Number(node.dataset.selectIndex) });
    };
  });

  els.queueList.querySelectorAll('[data-move-up]').forEach((node) => {
    node.onclick = (e) => {
      e.stopPropagation();
      const index = Number(node.dataset.moveUp);
      socket.emit('queue:move', { fromIndex: index, toIndex: index - 1 });
    };
  });

  els.queueList.querySelectorAll('[data-move-down]').forEach((node) => {
    node.onclick = (e) => {
      e.stopPropagation();
      const index = Number(node.dataset.moveDown);
      socket.emit('queue:move', { fromIndex: index, toIndex: index + 1 });
    };
  });

  els.queueList.querySelectorAll('[data-remove]').forEach((node) => {
    node.onclick = (e) => {
      e.stopPropagation();
      socket.emit('queue:remove', { index: Number(node.dataset.remove) });
    };
  });
}

function renderQueue(queue = [], currentIndex = -1) {
  els.queueList.innerHTML = queue
    .map((item, index) => `
      <div class="queue-item ${index === currentIndex ? 'active' : ''}">
        <span class="queue-index">${index + 1}</span>
        <div class="queue-main" data-select-index="${index}">
          <img class="queue-thumb" src="${escapeHtml(youtubeThumb(item.videoId))}" alt="${escapeHtml(item.title)}" />
          <div class="queue-summary">
            <div class="queue-title">${escapeHtml(item.title)}</div>
            <div class="queue-meta-row">
              <span class="queue-meta">${escapeHtml(item.videoId)}</span>
              <span class="search-badge">${index === currentIndex ? 'Now' : 'Queued'}</span>
            </div>
            <div class="queue-meta">thêm bởi ${escapeHtml(item.addedBy)}</div>
          </div>
        </div>
        <div class="queue-actions">
          <button class="ghost" data-move-up="${index}" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button class="ghost" data-move-down="${index}" ${index === queue.length - 1 ? 'disabled' : ''}>↓</button>
          <button data-remove="${index}">Xóa</button>
        </div>
      </div>
    `)
    .join('');

  bindQueueActions();
}

function showReaction(emoji) {
  const node = document.createElement('div');
  node.className = 'reaction-float';
  node.textContent = emoji;
  node.style.left = `${10 + Math.random() * 75}%`;
  els.reactions.appendChild(node);
  setTimeout(() => node.remove(), 1600);
}

function appendChatMessage(msg) {
  if (!latestState) return;
  latestState.chat = [...(latestState.chat || []), msg].slice(-100);

  const me = currentViewerName();
  const isSystem = String(msg.user || '').toLowerCase() === 'system';
  const isSelf = !isSystem && me && msg.user === me;

  const div = document.createElement('div');
  div.className = `chat-item ${isSystem ? 'is-system' : ''} ${isSelf ? 'is-self' : ''}`.trim();
  div.innerHTML = `
    <div class="chat-head">
      <div class="chat-name-wrap">
        <span class="chat-avatar">${escapeHtml(initials(msg.user))}</span>
        <strong class="chat-name">${escapeHtml(msg.user)}</strong>
      </div>
      <span class="chat-time">${escapeHtml(msg.time)}</span>
    </div>
    <div class="chat-body ${isSystem ? 'system' : ''}">${msg.image
      ? `<img src="${escapeHtml(msg.image)}" alt="image" style="cursor:pointer" onclick="window.open(this.src)">`
      : escapeHtml(msg.text)
    }</div>
  `;
  els.chatList.appendChild(div);

  while (els.chatList.children.length > 100) {
    els.chatList.removeChild(els.chatList.firstChild);
  }

  els.chatList.scrollTop = els.chatList.scrollHeight;
}

function lockPlayerInteraction() {
  const playerWrap = document.getElementById('playerWrap');
  if (!playerWrap) return;

  let blocker = document.getElementById('playerBlocker');
  if (!blocker) {
    blocker = document.createElement('div');
    blocker.id = 'playerBlocker';
    blocker.style.position = 'absolute';
    blocker.style.inset = '0';
    blocker.style.zIndex = '5';
    blocker.style.background = 'transparent';
    blocker.style.cursor = 'default';
    blocker.style.pointerEvents = 'auto';
    playerWrap.style.position = 'relative';
    playerWrap.appendChild(blocker);
  }
}

function tryResumeAfterLoad(shouldPlay = false, retries = 8) {
  if (!playerReady || !player) return;

  const run = (left) => {
    try {
      if (shouldPlay) {
        player.playVideo();
      } else {
        player.pauseVideo();
        return;
      }

      const state =
        typeof player.getPlayerState === 'function'
          ? player.getPlayerState()
          : -1;

      if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING) {
        return;
      }
    } catch (_) {
      // ignore
    }

    if (left > 0) {
      setTimeout(() => run(left - 1), 350);
    }
  };

  run(retries);
}

function renderSearchResults(items = []) {
  if (!els.searchResults) return;

  if (!items.length) {
    els.searchResults.innerHTML = '';
    return;
  }

  els.searchResults.innerHTML = items
    .map((item) => `
      <div class="search-item" data-add-video="${escapeHtml(item.videoId)}" data-add-title="${escapeHtml(item.title)}">
        <img class="search-thumb" src="${escapeHtml(item.thumbnail || youtubeThumb(item.videoId))}" alt="${escapeHtml(item.title)}" />
        <div class="search-info">
          <div class="search-title">${escapeHtml(item.title)}</div>
          <div class="search-channel">${escapeHtml(item.channelTitle || '')}</div>
        </div>
        <span class="search-badge">Thêm</span>
      </div>
    `)
    .join('');

  els.searchResults.querySelectorAll('[data-add-video]').forEach((node) => {
    node.onclick = () => {
      if (!joinedRoom) {
        toast('Bạn phải vào phòng trước');
        return;
      }

      if ((latestState?.queue || []).length >= MAX_QUEUE_SIZE) {
        toast(`Hàng chờ tối đa ${MAX_QUEUE_SIZE} bài`);
        return;
      }

      const videoId = node.dataset.addVideo;
      const title = node.dataset.addTitle || '';

      socket.emit('queue:add', {
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title
      });

      if (els.searchInput) {
        els.searchInput.value = '';
      }
      els.searchResults.innerHTML = '';
    };
  });
}

async function searchYoutubeVideos(query) {
  const res = await fetch(`/api/youtube/search?q=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT}`);
  const data = await res.json().catch(() => ({ items: [] }));

  if (!res.ok) {
    throw new Error(data.error || `Search failed: ${res.status}`);
  }

  return Array.isArray(data.items) ? data.items : [];
}

async function performSearch(query) {
  const q = String(query || '').trim();

  if (!els.searchResults) return;
  if (!q) {
    els.searchResults.innerHTML = '';
    return;
  }

  const token = ++currentSearchToken;
  els.searchResults.innerHTML = '<div class="search-empty">Đang tìm...</div>';

  try {
    const items = await searchYoutubeVideos(q);
    if (token !== currentSearchToken) return;

    if (!items.length) {
      els.searchResults.innerHTML = '<div class="search-empty">Không tìm thấy kết quả</div>';
      return;
    }

    renderSearchResults(items);
  } catch (err) {
    console.error(err);
    if (token !== currentSearchToken) return;
    els.searchResults.innerHTML = `<div class="search-empty">${escapeHtml(err.message || 'Không tìm được video')}</div>`;
  }
}

function scheduleSearch() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    performSearch(els.searchInput?.value || '');
  }, SEARCH_DEBOUNCE_MS);
}

function loadRoomVideo(playback, forcePlay = false) {
  if (!playerReady || !playback?.videoId) return;

  const expected = getExpectedPosition(playback);
  const currentVideoId = getCurrentVideoId();

  syncingFromServer = true;
  setSuppress(2200);

  try {
    if (currentVideoId !== playback.videoId) {
      player.loadVideoById({
        videoId: playback.videoId,
        startSeconds: expected
      });
      lastLoadedVideoId = playback.videoId;
      recentTrackSwitchUntil = Date.now() + 10000;
    } else {
      player.seekTo(expected, true);
    }
  } catch (_) {
    syncingFromServer = false;
    return;
  }

  const shouldPlay = forcePlay || (playback.isPlaying && localUserUnlocked);

  setTimeout(() => {
    try {
      tryResumeAfterLoad(shouldPlay, 8);
    } finally {
      setTimeout(() => {
        syncingFromServer = false;
      }, 400);
    }
  }, 300);
}

function tryPlayCurrentSynced() {
  if (!playerReady) {
    toast('Player chưa sẵn sàng, thử lại sau 1 giây');
    return;
  }

  if (!latestState?.playback?.videoId) {
    toast('Phòng chưa có video');
    return;
  }

  localUserUnlocked = true;

  const playback = latestState.playback;
  const expected = getExpectedPosition(playback);
  const currentVideoId = getCurrentVideoId();

  syncingFromServer = true;
  setSuppress(1800);

  if (currentVideoId !== playback.videoId) {
    try {
      player.loadVideoById({
        videoId: playback.videoId,
        startSeconds: expected
      });
      lastLoadedVideoId = playback.videoId;
      recentTrackSwitchUntil = Date.now() + 10000;
    } catch (_) {
      syncingFromServer = false;
      return;
    }

    setTimeout(() => {
      try {
        tryResumeAfterLoad(true, 8);
      } finally {
        setTimeout(() => {
          syncingFromServer = false;
        }, 400);
      }
    }, 350);
  } else {
    try {
      player.seekTo(expected, true);
      player.playVideo();
    } catch (_) {
      // ignore
    } finally {
      setTimeout(() => {
        syncingFromServer = false;
      }, 300);
    }
  }

  socket.emit('playback:play', { position: expected });
}

function pauseCurrentSynced() {
  if (!playerReady || !latestState?.playback?.videoId) return;

  const position = getCurrentTimeSafe();

  syncingFromServer = true;
  setSuppress(1000);

  try {
    player.pauseVideo();
  } catch (_) {
    // ignore
  }

  setTimeout(() => {
    syncingFromServer = false;
  }, 250);

  socket.emit('playback:pause', { position });
}

function renderState(state) {
  latestState = state;

  const playback = state.playback || {};
  const queue = state.queue || [];
  const users = state.users || [];
  const currentItem = queue[state.currentIndex];

  renderQueue(queue, state.currentIndex);
  renderMembers(users);
  renderChat(state.chat || []);
  updateHeader(playback, currentItem, users.length);

  if (playerReady && playback.videoId) {
    const currentVideoId = getCurrentVideoId();
    if (currentVideoId !== playback.videoId) {
      loadRoomVideo(playback, false);
    }
  }
}

function applyVolumeToPlayer() {
  try {
    if (playerReady && player?.setVolume) {
      player.setVolume(isMuted ? 0 : lastVolume);
    }
  } catch (_) {}
}

function createYoutubePlayer() {
  if (playerCreated) return;
  if (!window.YT || !window.YT.Player) return;

  const playerEl = document.getElementById('player');
  if (!playerEl) return;

  playerCreated = true;

  player = new YT.Player('player', {
    width: '100%',
    height: '100%',
    videoId: '',
    playerVars: {
      autoplay: 0,
      controls: 0,
      disablekb: 1,
      fs: 0,
      rel: 0,
      modestbranding: 1,
      playsinline: 1,
      iv_load_policy: 3
    },
    events: {
      onReady: () => {
        playerReady = true;
        els.roomSummary.textContent = 'Player sẵn sàng';
        lockPlayerInteraction();
        applyVolumeToPlayer();

        if (latestState?.playback?.videoId) {
          loadRoomVideo(latestState.playback, false);
        }
      },

      onStateChange: (event) => {
        if (isSuppressed()) return;
        if (!latestState?.playback?.videoId) return;

        const state = event.data;

        if (state === YT.PlayerState.ENDED) {
          requestNextTrack('ended');
          return;
        }

        if (syncingFromServer) return;

        if (state === YT.PlayerState.PLAYING) {
          return;
        }

        if (state === YT.PlayerState.PAUSED) {
          const hiddenRecently =
            document.hidden || Date.now() < hiddenPauseGuardUntil;

          if (hiddenRecently) {
            return;
          }

          return;
        }
      },

      onError: (event) => {
        console.error('YouTube error', event.data);

        const skippableErrors = [2, 5, 100, 101, 150];
        if (skippableErrors.includes(event.data)) {
          toast('Video này không phát được ở chế độ nhúng, đang chuyển bài tiếp theo.');
          requestNextTrack('error');
          return;
        }

        toast('Video này có thể không phát được ở chế độ nhúng.');
      }
    }
  });
}

window.onYouTubeIframeAPIReady = function () {
  createYoutubePlayer();
};

if (window.YT && window.YT.Player) {
  createYoutubePlayer();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenPauseGuardUntil = Date.now() + 3000;
    setSuppress(1500);
  }
});

// ── Socket events ────────────────────────────────────────────────

socket.on('connect', () => {
  console.log('[socket] connected', socket.id);
});

socket.on('disconnect', () => {
  els.roomSummary.textContent = 'Mất kết nối';
});

socket.on('toast', (payload) => {
  toast(payload?.message || 'Có lỗi xảy ra');
});

socket.on('room:state', (state) => {
  joinedRoom = true;
  renderState(state);
});

socket.on('chat:new', (msg) => {
  appendChatMessage(msg);
});

socket.on('reaction:new', (payload) => {
  showReaction(payload?.emoji || '❤️');
});

socket.on('playback:update', (payload) => {
  if (!playerReady) return;
  if (!payload) return;

  const position = Math.max(0, Number(payload.position || 0));

  if (payload.action === 'load') {
    if (!payload.videoId) return;

    syncingFromServer = true;
    setSuppress(2200);
    lockEmitNextTrack();

    try {
      player.loadVideoById({
        videoId: payload.videoId,
        startSeconds: position
      });
      lastLoadedVideoId = payload.videoId;
      recentTrackSwitchUntil = Date.now() + 10000;
    } catch (_) {
      syncingFromServer = false;
      return;
    }

    setTimeout(() => {
      try {
        tryResumeAfterLoad(localUserUnlocked, 10);
      } finally {
        setTimeout(() => {
          syncingFromServer = false;
        }, 500);
      }
    }, 450);

    return;
  }

  if (!payload.videoId) return;

  if (payload.action === 'play') {
    syncingFromServer = true;
    setSuppress(1500);

    const currentVideoId = getCurrentVideoId();

    if (currentVideoId !== payload.videoId) {
      try {
        player.loadVideoById({
          videoId: payload.videoId,
          startSeconds: position
        });
        lastLoadedVideoId = payload.videoId;
        recentTrackSwitchUntil = Date.now() + 10000;
      } catch (_) {
        syncingFromServer = false;
        return;
      }

      setTimeout(() => {
        try {
          tryResumeAfterLoad(localUserUnlocked, 8);
        } finally {
          setTimeout(() => {
            syncingFromServer = false;
          }, 400);
        }
      }, 350);
    } else {
      try {
        player.seekTo(position, true);
        if (localUserUnlocked) {
          player.playVideo();
        }
      } catch (_) {
        // ignore
      } finally {
        setTimeout(() => {
          syncingFromServer = false;
        }, 250);
      }
    }

    return;
  }

  if (payload.action === 'pause') {
    syncingFromServer = true;
    setSuppress(1200);

    const currentVideoId = getCurrentVideoId();

    if (currentVideoId !== payload.videoId) {
      try {
        player.loadVideoById({
          videoId: payload.videoId,
          startSeconds: position
        });
        lastLoadedVideoId = payload.videoId;
        recentTrackSwitchUntil = Date.now() + 10000;
      } catch (_) {
        syncingFromServer = false;
        return;
      }
    } else {
      try {
        player.seekTo(position, true);
      } catch (_) {
        // ignore
      }
    }

    setTimeout(() => {
      try {
        player.pauseVideo();
      } catch (_) {
        // ignore
      } finally {
        syncingFromServer = false;
      }
    }, 200);

    return;
  }

  if (payload.action === 'seek') {
    syncingFromServer = true;
    setSuppress(1000);

    const currentVideoId = getCurrentVideoId();

    if (currentVideoId !== payload.videoId) {
      try {
        player.loadVideoById({
          videoId: payload.videoId,
          startSeconds: position
        });
        lastLoadedVideoId = payload.videoId;
        recentTrackSwitchUntil = Date.now() + 10000;
      } catch (_) {
        syncingFromServer = false;
        return;
      }

      setTimeout(() => {
        try {
          if (!latestState?.playback?.isPlaying || !localUserUnlocked) {
            player.pauseVideo();
          }
        } catch (_) {
          // ignore
        } finally {
          syncingFromServer = false;
        }
      }, 250);
    } else {
      try {
        player.seekTo(position, true);
      } catch (_) {
        // ignore
      } finally {
        setTimeout(() => {
          syncingFromServer = false;
        }, 200);
      }
    }
  }
});

// ── Button handlers ──────────────────────────────────────────────

els.joinBtn.onclick = () => {
  const roomId = (els.roomInput.value || 'main-room').trim() || 'main-room';
  const name = (els.nameInput.value || 'Khách').trim() || 'Khách';

  if (!socket.connected) {
    toast('Chưa kết nối tới server');
    return;
  }

  socket.emit('room:join', { roomId, name, authUser: currentAuthUser() });
  els.roomSummary.textContent = 'Đang vào phòng...';
};

els.addBtn.onclick = () => {
  if (!joinedRoom) {
    toast('Bạn phải vào phòng trước');
    return;
  }

  if ((latestState?.queue || []).length >= MAX_QUEUE_SIZE) {
    toast(`Hàng chờ tối đa ${MAX_QUEUE_SIZE} bài`);
    return;
  }

  const url = (els.urlInput.value || '').trim();

  if (!url) {
    toast('Bạn chưa nhập link YouTube');
    return;
  }

  socket.emit('queue:add', { url, title: '' });
  els.urlInput.value = '';
};

els.sendBtn.onclick = () => {
  if (!joinedRoom) {
    toast('Bạn phải vào phòng trước');
    return;
  }

  const text = (els.chatInput.value || '').trim();
  if (!text) return;

  socket.emit('chat:send', { text });
  els.chatInput.value = '';
};

els.chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    els.sendBtn.click();
  }
});

els.urlInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    els.addBtn.click();
  }
});

els.searchInput?.addEventListener('input', () => {
  scheduleSearch();
});

els.searchInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(searchDebounceTimer);
    performSearch(els.searchInput.value || '');
  }
});

els.searchBtn?.addEventListener('click', () => {
  clearTimeout(searchDebounceTimer);
  performSearch(els.searchInput?.value || '');
});

els.playBtn.onclick = () => {
  if (!joinedRoom) {
    toast('Bạn phải vào phòng trước');
    return;
  }

  tryPlayCurrentSynced();
};

els.pauseBtn.onclick = () => {
  if (!joinedRoom) {
    toast('Bạn phải vào phòng trước');
    return;
  }

  pauseCurrentSynced();
};

els.nextBtn.onclick = () => {
  if (!joinedRoom) {
    toast('Bạn phải vào phòng trước');
    return;
  }

  requestNextTrack('manual');
};

// ── Volume controls ──────────────────────────────────────────────

els.volumeSlider?.addEventListener('input', () => {
  const vol = Number(els.volumeSlider.value);
  els.volumeLabel.textContent = vol + '%';
  lastVolume = vol > 0 ? vol : lastVolume;
  isMuted = vol === 0;
  els.muteBtn.textContent = isMuted ? '🔇' : '🔊';
  try { player?.setVolume?.(vol); } catch (_) {}
});

els.muteBtn?.addEventListener('click', () => {
  if (!playerReady) return;
  isMuted = !isMuted;
  if (isMuted) {
    try { player?.setVolume?.(0); } catch (_) {}
    els.volumeSlider.value = 0;
    els.volumeLabel.textContent = '0%';
    els.muteBtn.textContent = '🔇';
  } else {
    const vol = lastVolume || 80;
    try { player?.setVolume?.(vol); } catch (_) {}
    els.volumeSlider.value = vol;
    els.volumeLabel.textContent = vol + '%';
    els.muteBtn.textContent = '🔊';
  }
});


// ── Reactions ────────────────────────────────────────────────────

document.querySelectorAll('[data-reaction]').forEach((node) => {
  node.onclick = () => {
    if (!joinedRoom) {
      toast('Bạn phải vào phòng trước');
      return;
    }

    socket.emit('reaction:send', { emoji: node.dataset.reaction });
  };
});

// ── Drift correction loop ────────────────────────────────────────

setInterval(() => {
  if (!playerReady || !latestState?.playback?.videoId) return;
  if (document.hidden) return;
  if (Date.now() < recentTrackSwitchUntil) return;

  const playback = latestState.playback;
  const expected = getExpectedPosition(playback);
  const actual = getCurrentTimeSafe();
  const drift = Math.abs(expected - actual);

  const currentItem = latestState.queue?.[latestState.currentIndex];
  updateHeader(playback, currentItem, (latestState.users || []).length);

  if (playback.isPlaying && localUserUnlocked && drift > 4) {
    try {
      const duration = player.getDuration?.() || Infinity;
      if (expected < duration - 3) {
        setSuppress(1000);
        player.seekTo(expected, true);
      }
    } catch (_) {
      // ignore
    }
  }
}, 3000);

// ── Volume sync interval (phòng YouTube tự reset volume) ─────────

setInterval(() => {
  if (playerReady) applyVolumeToPlayer();
}, 5000);

// ── Image upload ─────────────────────────────────────────────────

async function uploadImage(file) {
  const formData = new FormData();
  formData.append('image', file);

  const res = await fetch('/api/upload', { method: 'POST', body: formData });
  const data = await res.json().catch(() => ({ error: 'Upload thất bại' }));
  if (!res.ok) throw new Error(data.error || 'Upload thất bại');
  return data.url;
}

async function sendImageToChat(file) {
  if (!joinedRoom) { toast('Bạn phải vào phòng trước'); return; }
  if (!file || !file.type.startsWith('image/')) return;

  try {
    const url = await uploadImage(file);
    socket.emit('chat:image', { url });
  } catch (err) {
    toast(err.message || 'Upload ảnh thất bại');
  }
}

els.chatInput.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items || [];
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      sendImageToChat(item.getAsFile());
      return;
    }
  }
});

const imageInput = document.getElementById('imageInput');
const imageBtn = document.getElementById('imageBtn');

imageBtn.onclick = () => {
  if (!joinedRoom) { toast('Bạn phải vào phòng trước'); return; }
  imageInput.click();
};

imageInput.addEventListener('change', () => {
  const file = imageInput.files?.[0];
  if (file) {
    sendImageToChat(file);
    imageInput.value = '';
  }
});
