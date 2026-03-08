const http = require('http');
const fs   = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

process.on('uncaughtException', (err) => {
  console.error('[FATAL]', err.message);
  console.error(err.stack);
  process.exit(1);
});

const MIME = {
  '.mp4':  'video/mp4',
  '.mkv':  'video/x-matroska',
  '.webm': 'video/webm',
  '.avi':  'video/x-msvideo',
  '.mov':  'video/quicktime',
  '.html': 'text/html',
  '.json': 'application/json',
};

const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.webm', '.avi', '.mov']);

// BASE_DIR is always the working directory — when launched via launch.bat,
// that is the drive root (E:\) where startup.html and Videos\ live.
const BASE_DIR = process.cwd();

// Resolve ffprobe/ffmpeg: try next to server.exe, then ffmpeg\bin\ subdir, then PATH.
function findBinary(name) {
  if (process.pkg) {
    const dir = path.dirname(process.execPath);
    const candidates = [
      path.join(dir, name + '.exe'),
      path.join(dir, 'ffmpeg', 'bin', name + '.exe'),
      path.join(dir, 'bin', name + '.exe'),
    ];
    for (const c of candidates) {
      try { fs.accessSync(c); return c; } catch {}
    }
    console.warn(`[SV] ${name}.exe not found next to server.exe — falling back to PATH`);
    return name + '.exe';
  }
  return name;
}
const FFPROBE = findBinary('ffprobe');
const FFMPEG  = findBinary('ffmpeg');

const SETTINGS_FILE  = path.join(BASE_DIR, 'settings.json');
const USAGE_LOG_FILE = path.join(BASE_DIR, 'usage-log.json');

// ── helpers ───────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// ── directory scanner ─────────────────────────────────────────────────────────

// Returns a tree node for a directory. relPath uses forward slashes and is
// relative to BASE_DIR so that paths can be used directly as URL segments.
async function scanDir(absPath, relPath) {
  const node = { type: 'dir', name: path.basename(absPath) || '', path: relPath, children: [] };
  let entries;
  try {
    entries = await fs.promises.readdir(absPath, { withFileTypes: true });
  } catch {
    return node;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const entryRel = relPath ? relPath + '/' + entry.name : entry.name;
    const entryAbs = path.join(absPath, entry.name);
    if (entry.isDirectory()) {
      node.children.push(await scanDir(entryAbs, entryRel));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      let stat;
      try { stat = await fs.promises.stat(entryAbs); } catch { stat = { size: 0, mtimeMs: 0 }; }
      node.children.push({
        type: 'file',
        name: entry.name,
        path: entryRel,
        isVideo: VIDEO_EXTS.has(ext),
        ext,
        size: stat.size,
        lastModified: stat.mtimeMs,
      });
    }
  }
  return node;
}

// ── API routes ────────────────────────────────────────────────────────────────

// GET /api/scan — walks Videos/ under BASE_DIR and returns full library tree
async function apiScan(req, res) {
  const videosAbs = (() => {
    for (const name of ['Videos', 'videos']) {
      const p = path.join(BASE_DIR, name);
      try { if (fs.statSync(p).isDirectory()) return p; } catch {}
    }
    return null;
  })();

  if (!videosAbs) {
    return json(res, 200, { type: 'dir', name: '', path: '', children: [] });
  }

  const videosRel  = path.basename(videosAbs);
  const videosNode = await scanDir(videosAbs, videosRel);
  const root       = { type: 'dir', name: '', path: '', children: [videosNode] };
  json(res, 200, root);
}

// GET /api/tracks?path=... — run ffprobe on the file and return all stream info + duration
function apiTracks(req, res) {
  const urlObj = new URL('http://x' + req.url);
  const filePath = urlObj.searchParams.get('path');
  if (!filePath) return json(res, 200, { streams: [] });

  const absPath = path.join(BASE_DIR, filePath);
  if (!absPath.startsWith(BASE_DIR)) return json(res, 403, { error: 'forbidden' });

  const args = ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', absPath];
  console.log('[SV] ffprobe cmd:', FFPROBE, args.join(' '));

  const ffDir = path.dirname(FFPROBE);
  execFile(FFPROBE, args, { timeout: 15000, cwd: ffDir }, (err, stdout) => {
    if (err) {
      console.error('[SV] ffprobe error:', err.message);
      return json(res, 200, { streams: [], error: err.message });
    }
    try {
      const data = JSON.parse(stdout);
      const streams = (data.streams || []).map(s => ({
        index:      s.index,
        codec_type: s.codec_type,
        codec_name: s.codec_name,
        language:   s.tags?.language || null,
        title:      s.tags?.title    || null,
      }));
      const duration = parseFloat(data.format?.duration) || 0;
      json(res, 200, { streams, duration });
    } catch (e) {
      console.error('[SV] ffprobe parse error:', e.message);
      json(res, 200, { streams: [] });
    }
  });
}

// GET /api/video?path=...&audioIndex=... — remux video selecting a specific audio stream via ffmpeg
function apiVideo(req, res) {
  const urlObj   = new URL('http://x' + req.url);
  const filePath = urlObj.searchParams.get('path');
  const audioIdx = urlObj.searchParams.get('audioIndex');
  if (!filePath) return json(res, 400, { error: 'path required' });

  const absPath = path.join(BASE_DIR, filePath);
  if (!absPath.startsWith(BASE_DIR)) return json(res, 403, { error: 'forbidden' });

  if (audioIdx === null) return serveStatic(req, res);

  res.writeHead(200, { 'Content-Type': 'video/mp4' });
  const proc = spawn(FFMPEG, [
    '-v', 'quiet',
    '-i', absPath,
    '-map', '0:v:0',
    '-map', `0:${audioIdx}`,
    '-c', 'copy',
    '-movflags', 'frag_keyframe+empty_moov',
    '-f', 'mp4',
    'pipe:1',
  ], { cwd: path.dirname(FFMPEG) });
  proc.stdout.pipe(res);
  proc.stderr.resume();
  proc.on('error', err => { console.error('[SV] apiVideo error:', err.message); try { res.end(); } catch {} });
  req.on('close', () => { try { proc.kill('SIGKILL'); } catch {} });
}

// GET /api/subtitle?path=...&streamIndex=... — extract subtitle stream as WebVTT via ffmpeg
function apiSubtitle(req, res) {
  const urlObj = new URL('http://x' + req.url);
  const filePath    = urlObj.searchParams.get('path');
  const streamIndex = urlObj.searchParams.get('streamIndex');
  if (!filePath || streamIndex === null) return json(res, 400, { error: 'path and streamIndex required' });

  const absPath = path.join(BASE_DIR, filePath);
  if (!absPath.startsWith(BASE_DIR)) return json(res, 403, { error: 'forbidden' });

  res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8' });
  const proc = spawn(FFMPEG, [
    '-v', 'quiet', '-i', absPath,
    '-map', `0:${streamIndex}`,
    '-f', 'webvtt', 'pipe:1',
  ], { cwd: path.dirname(FFMPEG) });
  proc.stdout.pipe(res);
  proc.stderr.resume();
  proc.on('error', () => { try { res.end(); } catch {} });
}

// POST /write/settings.json — write body directly to settings.json
async function writeSettings(req, res) {
  try {
    const body = await readBody(req);
    fs.writeFileSync(SETTINGS_FILE, body);
    json(res, 200, { status: 'ok' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}

// POST /write/usage-log.json — append body as a new line to usage-log.json
async function writeUsageLog(req, res) {
  try {
    const body = await readBody(req);
    fs.appendFileSync(USAGE_LOG_FILE, body + '\n');
    json(res, 200, { status: 'ok' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}

// GET /quit — clean shutdown
function apiQuit(req, res) {
  json(res, 200, { status: 'bye' });
  setTimeout(() => process.exit(0), 100);
}

// ── request router ────────────────────────────────────────────────────────────

const ROUTES = [
  { method: 'GET',  test: u => u === '/api/scan',                 handler: apiScan },
  { method: 'GET',  test: u => u.startsWith('/api/tracks'),      handler: apiTracks },
  { method: 'GET',  test: u => u.startsWith('/api/video'),       handler: apiVideo },
  { method: 'GET',  test: u => u.startsWith('/api/subtitle'),    handler: apiSubtitle },
  { method: 'GET',  test: u => u === '/quit',                    handler: apiQuit },
  { method: 'POST', test: u => u === '/write/settings.json',   handler: writeSettings },
  { method: 'POST', test: u => u === '/write/usage-log.json',  handler: writeUsageLog },
];

function handleRequest(req, res) {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);

  const urlPath = req.url.split('?')[0];

  for (const route of ROUTES) {
    if (req.method === route.method && route.test(urlPath)) {
      Promise.resolve(route.handler(req, res)).catch(e => json(res, 500, { error: e.message }));
      return;
    }
  }

  serveStatic(req, res);
}

// ── static file server ────────────────────────────────────────────────────────

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const filePath = path.join(BASE_DIR, urlPath);

  if (!filePath.startsWith(BASE_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      return res.end('Not Found');
    }

    const ext   = path.extname(filePath).toLowerCase();
    const mime  = MIME[ext] || 'application/octet-stream';
    const total = stat.size;
    const rangeHeader = req.headers['range'];

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (!match) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        return res.end();
      }
      const start = parseInt(match[1], 10);
      const end   = match[2] ? parseInt(match[2], 10) : total - 1;
      if (start > end || end >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        return res.end();
      }
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${total}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': chunkSize,
        'Content-Type':   mime,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': total,
        'Content-Type':   mime,
        'Accept-Ranges':  'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

// ── startup ───────────────────────────────────────────────────────────────────

const server = http.createServer(handleRequest);
const PORTS  = [8080, 8081, 8082];

function tryListen(ports) {
  if (ports.length === 0) {
    console.error('All ports in use (8080, 8081, 8082). Exiting.');
    process.exit(1);
  }
  const port = ports[0];
  server.listen(port, () => {
    console.log(`streamserver running on http://localhost:${port}`);
    console.log(`Serving files from: ${BASE_DIR}`);
    console.log('Endpoints:');
    console.log('  GET  /api/scan');
    console.log('  GET  /api/tracks?path=...');
    console.log('  GET  /api/video?path=...&audioIndex=...');
    console.log('  GET  /api/subtitle?path=...&streamIndex=...');
    console.log('  GET  /quit');
    console.log('  POST /write/settings.json');
    console.log('  POST /write/usage-log.json');
    console.log('  GET  <any path> -> static file');
  });
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Port ${port} in use, trying ${ports[1]}...`);
      server.removeAllListeners('error');
      tryListen(ports.slice(1));
    } else {
      console.error(err);
      process.exit(1);
    }
  });
}

tryListen(PORTS);
