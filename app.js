// SlingTiVo phone app
(() => {
  // Slinger remote codes (from Slinger's /Remote/SlingTiVo page)
  const KEYS = {
    'OK': 42, 'Up': 38, 'Down': 39, 'Left': 40, 'Right': 41,
    'Guide': 35, 'Last': 56, 'Exit': 37, 'DVR': 23, 'Menu': 33, 'OnDemand': 34,
    'FF': 28, 'Rew': 27, 'Play': 24, 'Pause': 26, 'Rec': 29,
    'Ch+': 4, 'Ch-': 5, 'Pg-': 43, 'Pg+': 44, 'Day-': 59, 'Day+': 60,
    'Power': 1,
  };
  const LABEL = { 'Ch+': 'CH ▲', 'Ch-': 'CH ▼', 'Last': '↩ Last', 'DVR': 'TiVo', 'Rew': '◀◀ Rew', 'FF': 'FF ▶▶',
    'Play': '▶', 'Pause': '❚❚', 'Rec': '● Rec', 'Power': '⏻ Power' };

  const $ = s => document.querySelector(s);
  const app = $('#app'), stage = $('#stage'), video = $('#video');
  const splash = $('#splash'), splashMsg = $('#splashMsg'), spinner = $('#spinner');
  const toastEl = $('#toast'), digitsEl = $('#digits');

  let hls = null, watching = false, restarting = false;

  // ---------- helpers ----------
  let toastTimer;
  function toast(text, ms = 1100) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }
  const buzz = () => navigator.vibrate && navigator.vibrate(15);

  async function sendKey(name, digits) {
    buzz();
    const value = name === 'Channel' ? 'Channel' : KEYS[name];
    try {
      const r = await fetch('/api/key', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, value, digits }),
      });
      const j = await r.json();
      if (!j.ok) toast('Remote error', 1500);
    } catch { toast('No connection', 1500); }
  }

  // ---------- video ----------
  async function startStream() {
    if (restarting) return;
    restarting = true;
    spinner.hidden = false;
    splashMsg.textContent = 'Connecting to the Slingbox…';
    stopPlayer();
    try {
      const r = await fetch('/api/start', { method: 'POST' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'Could not start');
      attach(j.url + '?t=' + Date.now());
      splash.classList.add('gone');
      watching = true;
      showHint();
      // Start unlocked — lock kicks in after 60s
      gestureLocked = false;
      app.classList.remove('locked');
      setTimeout(() => {
        if (!gestureLocked) {
          lockGestures();
          toast('🔒 Locked', 800);
        }
      }, LOCK_INITIAL_MS);
    } catch (e) {
      spinner.hidden = true;
      splash.classList.remove('gone');
      splashMsg.textContent = e.message || 'Could not connect';
    } finally {
      restarting = false;
    }
  }

  function attach(url) {
    if (window.Hls && Hls.isSupported()) {            // Android / desktop Chrome
      hls = new Hls({
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 5,
        maxLiveSyncPlaybackRate: 1.15,
        backBufferLength: 10,
        manifestLoadingMaxRetry: 6,
        levelLoadingMaxRetry: 6,
      });
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else setTimeout(startStream, 2000);
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {   // iPhone / iPad
      video.src = url;
      video.play().catch(() => {});
    } else {
      splashMsg.textContent = 'This browser cannot play the stream.';
    }
  }

  function stopPlayer() {
    if (typeof stopAudio === 'function' && audioMode) stopAudio();
    if (hls) { hls.destroy(); hls = null; }
    video.removeAttribute('src');
    video.load();
  }

  video.addEventListener('playing', () => (spinner.hidden = true));
  video.addEventListener('waiting', () => (spinner.hidden = false));

  // stall watchdog: if the picture freezes for 12s, reconnect
  let lastT = 0, stuckFor = 0;
  setInterval(() => {
    if (!watching || video.paused) { stuckFor = 0; return; }
    if (video.currentTime === lastT) stuckFor += 3; else stuckFor = 0;
    lastT = video.currentTime;
    if (stuckFor >= 12) { stuckFor = 0; toast('Reconnecting…'); startStream(); }
  }, 3000);

  // ---------- background audio ----------
  const audio = new Audio();
  audio.preload = 'auto';
  let hlsA = null, audioMode = false, userPaused = false, pausedAt = 0;

  function startAudio() {
    if (audioMode || !watching) return;
    audioMode = true;
    const url = '/hls/audio.m3u8?t=' + Date.now();
    if (window.Hls && Hls.isSupported()) {
      hlsA = new Hls({ liveSyncDurationCount: 2, manifestLoadingMaxRetry: 6, levelLoadingMaxRetry: 6 });
      hlsA.on(Hls.Events.ERROR, (_, d) => { if (d.fatal && audioMode) { stopAudio(); setTimeout(startAudio, 2000); } });
      hlsA.loadSource(url);
      hlsA.attachMedia(audio);
    } else {
      audio.src = url;
    }
    audio.play().catch(() => {});
    setMediaState();
  }

  function stopAudio() {
    audioMode = false;
    if (hlsA) { hlsA.destroy(); hlsA = null; }
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }

  function backToVideo() {
    stopAudio();
    if (!watching || userPaused) return;
    if (hls && hls.liveSyncPosition) video.currentTime = hls.liveSyncPosition;
    video.play().catch(() => startStream());
  }

  video.addEventListener('pause', () => {
    if (document.hidden && watching && !userPaused && !document.pictureInPictureElement) startAudio();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      setTimeout(() => {
        if (document.hidden && watching && !userPaused && video.paused && !document.pictureInPictureElement) startAudio();
      }, 1500);
    } else if (watching) {
      backToVideo();
    }
  });

  // ---------- pause / resume ----------
  function pausePlayback() {
    userPaused = true; pausedAt = Date.now();
    video.pause(); audio.pause();
    setMediaState();
  }
  function resumePlayback() {
    userPaused = false;
    if (Date.now() - pausedAt > 30000) {
      stopAudio();
      startStream().then(() => { if (document.hidden) setTimeout(startAudio, 1500); });
      return;
    }
    if (audioMode) {
      if (hlsA && hlsA.liveSyncPosition) audio.currentTime = hlsA.liveSyncPosition;
      audio.play().catch(() => {});
    } else {
      if (hls && hls.liveSyncPosition) video.currentTime = hls.liveSyncPosition;
      video.play().catch(() => {});
    }
    setMediaState();
  }

  // ---------- lock screen / notification player ----------
  function setMediaState() {
    if (!('mediaSession' in navigator)) return;
    const el = audioMode ? audio : video;
    navigator.mediaSession.playbackState = el.paused ? 'paused' : 'playing';
  }
  audio.addEventListener('play', setMediaState);
  audio.addEventListener('pause', setMediaState);

  // ---------- floating (picture-in-picture) ----------
  async function floatVideo() {
    if (video.paused) video.play().catch(() => {});
    if (document.pictureInPictureEnabled && video.requestPictureInPicture) {
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await video.requestPictureInPicture();
        return;
      } catch {}
    }
    try {
      await video.requestFullscreen({ navigationUI: 'hide' });
      try { await screen.orientation.lock('landscape'); } catch {}
      toast('Now swipe up / press Home to float', 3000);
    } catch {
      if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
      else toast('Float not supported here', 1800);
    }
  }
  video.addEventListener('enterpictureinpicture', () => { if (audioMode) backToVideo(); });
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'SlingTiVo', artist: 'Live TV',
      artwork: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
    const last = () => { toast(LABEL['Last']); sendKey('Last'); };
    for (const a of ['nexttrack', 'previoustrack', 'seekforward', 'seekbackward']) {
      try { navigator.mediaSession.setActionHandler(a, last); } catch {}
    }
    for (const a of ['seekto', 'stop']) { try { navigator.mediaSession.setActionHandler(a, null); } catch {} }
    navigator.mediaSession.setActionHandler('play', resumePlayback);
    navigator.mediaSession.setActionHandler('pause', pausePlayback);
    try { navigator.mediaSession.setActionHandler('enterpictureinpicture', () => video.requestPictureInPicture().catch(() => {})); } catch {}
  }
  video.addEventListener('play', setMediaState);
  video.addEventListener('pause', setMediaState);

  $('#watchBtn').addEventListener('click', () => { video.muted = false; startStream(); });

  // ================================================================
  // GESTURE LOCK
  // ================================================================
  const LOCK_HOLD_MS = 2500;       // how long to hold to unlock
  const LOCK_IDLE_MS = 45000;      // 45 seconds idle → re-lock
  const LOCK_INITIAL_MS = 60000;   // lock kicks in 60s after launch
  const lockBtn = $('#lockBtn');
  const ringProgress = $('#ringProgress');
  const lockIcon = $('#lockIcon');
  let gestureLocked = true;
  let lockHoldTimer = null;
  let lockShowTimer = null;
  let idleTimer = null;

  // Start UNLOCKED — lock kicks in after LOCK_INITIAL_MS
  // (don't add 'locked' class on load)

  function lockGestures() {
    gestureLocked = true;
    app.classList.add('locked');
    lockBtn.classList.remove('visible', 'holding');
    ringProgress.style.strokeDashoffset = '376.99';
    lockIcon.textContent = '🔒';
    clearTimeout(idleTimer);
  }

  function unlockGestures() {
    gestureLocked = false;
    app.classList.remove('locked');
    lockBtn.classList.remove('visible', 'holding');
    lockIcon.textContent = '🔓';
    // briefly show the unlocked icon
    lockBtn.classList.add('visible');
    setTimeout(() => lockBtn.classList.remove('visible'), 800);
    toast('🔓 Unlocked', 800);
    buzz();
    resetIdleTimer();
  }

  function resetIdleTimer() {
    clearTimeout(idleTimer);
    if (!gestureLocked) {
      idleTimer = setTimeout(() => {
        lockGestures();
        toast('🔒 Locked', 800);
      }, LOCK_IDLE_MS);
    }
  }

  // Tap on lock overlay → show the faint lock icon
  // The overlay covers the stage only when locked
  $('#lockOverlay').addEventListener('pointerdown', e => {
    // If tapping the lock button itself, that's handled below
    if (e.target.closest('#lockBtn') && lockBtn.classList.contains('visible')) return;
    // Otherwise show the lock icon
    e.preventDefault();
    lockBtn.classList.add('visible');
    clearTimeout(lockShowTimer);
    lockShowTimer = setTimeout(() => {
      if (gestureLocked) lockBtn.classList.remove('visible');
    }, 3000);
  });

  // Hold-to-unlock on the lock button
  lockBtn.addEventListener('pointerdown', e => {
    if (!gestureLocked) return;
    e.preventDefault();
    e.stopPropagation();
    lockBtn.classList.add('holding');
    // The CSS transition draws the ring over LOCK_HOLD_MS
    // Force a reflow so the transition starts from the reset position
    ringProgress.style.strokeDashoffset = '376.99';
    ringProgress.offsetHeight;  // force reflow
    lockBtn.classList.remove('holding');
    requestAnimationFrame(() => {
      lockBtn.classList.add('holding');
    });
    buzz();
    lockHoldTimer = setTimeout(() => {
      unlockGestures();
    }, LOCK_HOLD_MS);
  });

  // Release before ring completes → cancel
  const cancelHold = () => {
    if (!lockHoldTimer) return;
    clearTimeout(lockHoldTimer);
    lockHoldTimer = null;
    lockBtn.classList.remove('holding');
    ringProgress.style.strokeDashoffset = '376.99';
  };
  lockBtn.addEventListener('pointerup', cancelHold);
  lockBtn.addEventListener('pointercancel', cancelHold);
  lockBtn.addEventListener('pointerleave', cancelHold);

  // ================================================================
  // GESTURES ON THE VIDEO (gated by lock)
  // ================================================================
  let sx = 0, sy = 0, st = 0, tracking = false;
  stage.addEventListener('pointerdown', e => {
    if (gestureLocked) return;        // ← locked: ignore
    if (e.target.closest('button')) return;
    tracking = true; sx = e.clientX; sy = e.clientY; st = Date.now();
    resetIdleTimer();
  });
  stage.addEventListener('pointerup', e => {
    if (!tracking) return;
    tracking = false;
    resetIdleTimer();
    const dx = e.clientX - sx, dy = e.clientY - sy, ax = Math.abs(dx), ay = Math.abs(dy);
    const min = Math.max(40, Math.min(stage.clientWidth, stage.clientHeight) * 0.12);

    if (ay > min && ay > ax * 1.2) {                 // vertical swipe → channel
      const key = dy < 0 ? 'Ch+' : 'Ch-';
      toast(LABEL[key]); sendKey(key);
    } else if (ax > min && ax > ay * 1.2) {          // horizontal swipe → last channel
      toast(LABEL['Last']); sendKey('Last');
    } else if (ax < 12 && ay < 12 && Date.now() - st < 400) {   // tap
      if (app.classList.contains('remote-open')) app.classList.remove('remote-open');
      else {
        toggleControls();
        // In portrait, also toggle the remote panel visibility
        if (window.matchMedia('(orientation: portrait)').matches) {
          app.classList.toggle('remote-hidden');
        }
      }
    }
  });
  stage.addEventListener('pointercancel', () => (tracking = false));

  let ctrlTimer;
  function toggleControls(force) {
    const on = force ?? !app.classList.contains('controls');
    app.classList.toggle('controls', on);
    clearTimeout(ctrlTimer);
    if (on) ctrlTimer = setTimeout(() => app.classList.remove('controls'), 4000);
    resetIdleTimer();
  }

  function showHint() {
    if (localStorageGet('hintSeen')) return;
    app.classList.add('hint');
    setTimeout(() => app.classList.remove('hint'), 5000);
    localStorageSet('hintSeen', '1');
  }

  // ---------- portrait remote toggle ----------
  const remoteHandle = $('#remoteHandle');
  if (remoteHandle) {
    remoteHandle.addEventListener('click', () => {
      app.classList.toggle('remote-hidden');
      resetIdleTimer();
    });
    // Swipe up on handle to show remote
    let handleY = 0;
    remoteHandle.addEventListener('touchstart', e => { handleY = e.touches[0].clientY; });
    remoteHandle.addEventListener('touchend', e => {
      const dy = handleY - e.changedTouches[0].clientY;
      if (dy > 30) app.classList.remove('remote-hidden');
      else if (dy < -30) app.classList.add('remote-hidden');
    });
  }

  // ---------- top bar ----------
  $('#topbar').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    toggleControls(true);
    resetIdleTimer();
    const act = b.dataset.act;
    if (act === 'mute') {
      video.muted = !video.muted;
      b.textContent = video.muted ? '🔇' : '🔊';
    } else if (act === 'float') {
      floatVideo();
    } else if (act === 'reload') {
      toast('Reconnecting…'); startStream();
    } else if (act === 'remote') {
      app.classList.add('remote-open'); app.classList.remove('controls');
    } else if (act === 'fullscreen') {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else {
          await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
          try { await screen.orientation.lock('landscape'); } catch {}
        }
      } catch {
        if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
      }
    }
  });
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) { try { screen.orientation.unlock(); } catch {} }
  });

  // ---------- remote buttons ----------
  const remote = $('#remote');
  remote.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    resetIdleTimer();
    if (b.dataset.key) {
      if (b.dataset.confirm && !confirm(b.dataset.confirm)) return;
      sendKey(b.dataset.key);
      if (LABEL[b.dataset.key]) toast(LABEL[b.dataset.key]);
    } else if (b.dataset.num) {
      addDigit(b.dataset.num);
    } else if (b.dataset.act === 'clear') {
      entry = ''; renderDigits(); clearTimeout(entryTimer);
    } else if (b.dataset.act === 'go') {
      goChannel();
    }
  });

  // ---------- direct channel entry ----------
  let entry = '', entryTimer;
  function addDigit(d) {
    buzz();
    if (entry.length >= 4) entry = '';
    entry += d;
    renderDigits();
    clearTimeout(entryTimer);
    entryTimer = setTimeout(goChannel, 2500);
  }
  function goChannel() {
    clearTimeout(entryTimer);
    if (!entry) return;
    toast('CH ' + entry, 1500);
    sendKey('Channel', entry);
    entry = '';
    setTimeout(renderDigits, 600);
  }
  function renderDigits() { digitsEl.textContent = entry || '– – –'; }

  // ---------- misc ----------
  function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
