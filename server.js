// SlingTiVo PWA server
// Runs on the same Windows PC as Slinger. No npm install needed (Node 18+).
// - Pulls the Slinger stream with FFmpeg and turns it into HLS (starts on demand, stops when idle)
// - Serves the phone app (PWA)
// - Relays remote-control buttons to Slinger's /Remote page

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const PUBLIC = path.join(__dirname, 'public');
const HLS = path.join(__dirname, 'hls');
const PLAYLIST = path.join(HLS, 'live.m3u8');

// ── Auto-update from GitHub on startup ──
const GITHUB_REPO = 'dgtl/slingtivo-app';
const GITHUB_BRANCH = 'main';
const UPDATE_FILES = ['index.html', 'style.css', 'app.js', 'sw.js'];

function fetchGitHub(filePath) {
  return new Promise((resolve, reject) => {
    const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${filePath}`;
    https.get(url, { headers: { 'User-Agent': 'SlingTiVoApp' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        https.get(res.headers.location, { headers: { 'User-Agent': 'SlingTiVoApp' } }, res2 => {
          let d = ''; res2.on('data', c => d += c); res2.on('end', () => resolve(d));
        }).on('error', reject);
        return;
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${filePath}`));
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

async function autoUpdate() {
  log('Checking GitHub for updates...');
  for (const file of UPDATE_FILES) {
    try {
      const content = await fetchGitHub(file);
      const dest = path.join(PUBLIC, file);
      const existing = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
      if (content !== existing) {
        fs.writeFileSync(dest, content, 'utf8');
        log(`  Updated: ${file}`);
      } else {
        log(`  Current: ${file}`);
      }
    } catch (e) {
      log(`  Skip ${file}: ${e.message}`);
    }
  }
  log('Update check done.');
}

let ffmpeg = null;
let lastViewerHit = 0;
let startedAt = 0;

function log(...a) { console.log(new Date().toLocaleTimeString(), ...a); }

function clearHls() {
  fs.mkdirSync(HLS, { recursive: true });
  for (const f of fs.readdirSync(HLS)) { try { fs.unlinkSync(path.join(HLS, f)); } catch {} }
}

function startStream() {
  if (ffmpeg) return;
  clearHls();
  const input = CFG.slingerStreamUrl;
  const video = CFG.transcode
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-b:v', CFG.videoBitrate || '3000k',
       '-g', '60', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '128k']
    : ['-c', 'copy'];
  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-fflags', '+genpts+discardcorrupt', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', input,
    ...video,
    '-f', 'hls',
    '-hls_time', String(CFG.segmentSeconds || 2),
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+omit_endlist+independent_segments',
    '-hls_segment_filename', path.join(HLS, 'seg%05d.ts'),
    PLAYLIST,
    // second output: audio-only stream the phone switches to in the background
    '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '96k',
    '-f', 'hls',
    '-hls_time', String(CFG.segmentSeconds || 2),
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+omit_endlist',
    '-hls_segment_filename', path.join(HLS, 'aud%05d.ts'),
    path.join(HLS, 'audio.m3u8'),
  ];
  log('Starting FFmpeg:', input);
  startedAt = Date.now();
  ffmpeg = spawn(CFG.ffmpegPath || 'ffmpeg', args, { windowsHide: true });
  ffmpeg.stderr.on('data', d => process.stdout.write('[ffmpeg] ' + d));
  ffmpeg.on('exit', code => {
    log('FFmpeg exited', code);
    ffmpeg = null;
    // auto-restart if someone is still watching
    if (Date.now() - lastViewerHit < 15000) setTimeout(startStream, 2000);
  });
}

function stopStream() {
  if (!ffmpeg) return;
  log('No viewers, stopping stream');
  const p = ffmpeg; ffmpeg = null;
  try { p.kill('SIGKILL'); } catch {}
}

// stop FFmpeg when nobody has asked for video in a while (frees the Slingbox for VLC)
setInterval(() => {
  if (ffmpeg && Date.now() - lastViewerHit > (CFG.idleStopSeconds || 60) * 1000) stopStream();
}, 5000);

// Send a key to Slinger exactly like its own remote page does (form POST, name=value)
// Uses raw http.request so header names keep their exact case: Slinger looks for "Host:" (capital H)
// and breaks on the lowercase headers that fetch() sends.
function sendKey(name, value, digits) {
  const form = new URLSearchParams();
  form.set(name, String(value));
  if (digits !== undefined) form.set('Digits', String(digits));
  const body = form.toString();
  const u = new URL(CFG.slingerRemoteUrl);
  const port = u.port || '80';
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname, port, path: u.pathname, method: 'POST', setHost: false,
      headers: {
        'Host': `${u.hostname}:${port}`,
        'User-Agent': 'Mozilla/5.0 SlingTiVoApp',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Connection': 'close',
      },
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.setTimeout(8000, () => req.destroy(new Error('Slinger remote timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml',
  '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t',
};

function sendFile(res, file, cache) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(data);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise(r => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => r(b)); });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);

  try {
    // Start / keep-alive. Responds once the first HLS playlist exists.
    if (p === '/api/start' && req.method === 'POST') {
      lastViewerHit = Date.now();
      startStream();
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        if (fs.existsSync(PLAYLIST)) return json(res, 200, { ok: true, url: '/hls/live.m3u8' });
        await new Promise(r => setTimeout(r, 300));
      }
      return json(res, 504, { ok: false, error: 'Stream did not start. Is Slinger running and the Slingbox free?' });
    }

    if (p === '/api/key' && req.method === 'POST') {
      const { name, value, digits } = JSON.parse(await readBody(req) || '{}');
      if (!name || value === undefined) return json(res, 400, { ok: false });
      const status = await sendKey(name, value, digits);
      log('Key', name, digits || '', '->', status);
      return json(res, 200, { ok: status < 400, status });
    }

    if (p === '/api/status') {
      return json(res, 200, { running: !!ffmpeg, uptime: ffmpeg ? Math.round((Date.now() - startedAt) / 1000) : 0 });
    }

    if (p.startsWith('/hls/')) {
      lastViewerHit = Date.now();
      const f = path.join(HLS, path.basename(p));
      return sendFile(res, f, 'no-store');
    }

    // App files
    let f = path.join(PUBLIC, path.normalize(p === '/' ? '/index.html' : p));
    if (!f.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    const cache = 'no-cache';   // always revalidate so updates show up right away (also stops Cloudflare edge caching)
    return sendFile(res, f, cache);
  } catch (e) {
    log('Error', e.message);
    json(res, 500, { ok: false, error: e.message });
  }
}).listen(CFG.port, async () => {
  log(`SlingTiVo app running on http://localhost:${CFG.port}`);
  await autoUpdate().catch(e => log('Auto-update failed:', e.message));
});
