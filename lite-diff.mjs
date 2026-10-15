#!/usr/bin/env node
// lite-diff: a tiny, low-memory git diff + file viewer/editor for big repos.
//
// Usage: node lite-diff.mjs [repo-path] [--port 4777] [--depth 3] [--tab] [--no-open]
//   --depth    max Ctrl+click hops before you must start a new chain from the sidebar
//   --tab      open in a normal browser tab instead of an Edge app window
//   --no-open  don't open a browser at all
//
// Nothing is indexed or watched: every request reads git / disk on demand, so the
// server idles at ~0% CPU and a few tens of MB of RAM.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const has = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};

const PORT = Number(opt('port', 4777));
const MAX_DEPTH = Number(opt('depth', 3));
const PLAIN_TAB = has('tab');
const NO_OPEN = has('no-open');
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BARREL_HOPS = 8;
const FILE_INDEX_TTL_MS = 60_000;
const HIDDEN_DIRS = new Set(['node_modules', '.git', '.nx', 'dist', 'coverage', '.next', '.turbo', '.cache', '.vite']);
const EXTS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.scss'];

const git = (args, { cwd = ROOT, allowFail = false } = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, '-c', 'core.quotepath=off', ...args],
      { maxBuffer: 256 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && !allowFail) reject(new Error(String(stderr || err.message).trim()));
        else resolve(stdout ?? '');
      },
    );
  });

let ROOT = path.resolve(argv[0] ?? process.cwd());
try {
  ROOT = path.resolve((await git(['rev-parse', '--show-toplevel'], { cwd: ROOT })).trim());
} catch {
  console.error(`Not a git repository: ${ROOT}`);
  process.exit(1);
}

const httpError = (status, message) => Object.assign(new Error(message), { status });
const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const isInside = (p) => norm(p) === norm(ROOT) || norm(p).startsWith(norm(ROOT) + path.sep);
const toAbs = (rel) => {
  const p = path.resolve(ROOT, rel ?? '');
  if (!isInside(p)) throw httpError(403, 'Path is outside the repository');
  return p;
};
const toRel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const statKind = (p) => {
  try {
    const s = fs.statSync(p);
    return s.isFile() ? 'file' : s.isDirectory() ? 'dir' : null;
  } catch {
    return null;
  }
};
const readJson = (p) => {
  let txt;
  try {
    txt = fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(txt);
  } catch {
    // tsconfig-style JSON: strip comments and trailing commas.
    try {
      return JSON.parse(
        txt.replace(/\/\*[\s\S]*?\*\/|(^|[^:"'])\/\/.*$/gm, '$1').replace(/,\s*([}\]])/g, '$1'),
      );
    } catch {
      return null;
    }
  }
};

// ---------- git ----------

async function baseRef(mode) {
  if (mode !== 'branch') return 'HEAD';
  for (const ref of ['origin/main', 'main', 'origin/master', 'master']) {
    const mergeBase = (await git(['merge-base', 'HEAD', ref], { allowFail: true })).trim();
    if (mergeBase) return mergeBase;
  }
  return 'HEAD';
}

async function listChanges(mode) {
  const ref = await baseRef(mode);
  const [diff, untracked] = await Promise.all([
    git(['diff', ref, '--name-status', '-z', '-M'], { allowFail: true }),
    git(['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const changes = [];
  const t = diff.split('\0');
  for (let i = 0; i < t.length - 1; ) {
    const status = t[i];
    if (!status) {
      i++;
    } else if (status[0] === 'R' || status[0] === 'C') {
      changes.push({ status: status[0], old: t[i + 1], path: t[i + 2] });
      i += 3;
    } else {
      changes.push({ status: status[0], path: t[i + 1] });
      i += 2;
    }
  }
  for (const p of untracked.split('\0')) if (p) changes.push({ status: '?', path: p });
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return changes;
}

async function fileDiff(rel, old, mode) {
  toAbs(rel);
  if (old) toAbs(old);
  const ref = await baseRef(mode);
  const paths = old ? [old, rel] : [rel];
  return git(['diff', ref, '-M', '--no-color', '--no-ext-diff', '-U3', '--', ...paths], { allowFail: true });
}

// Short-lived: dropped after a minute of not searching so it doesn't sit in memory.
let fileIndex = null;
let fileIndexTimer = null;
async function getFileIndex() {
  if (!fileIndex) {
    fileIndex = (await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean);
  }
  clearTimeout(fileIndexTimer);
  fileIndexTimer = setTimeout(() => (fileIndex = null), FILE_INDEX_TTL_MS);
  fileIndexTimer.unref();
  return fileIndex;
}

function matchScore(p, q) {
  const lp = p.toLowerCase();
  const base = lp.slice(lp.lastIndexOf('/') + 1);
  if (base.startsWith(q)) return 0;
  if (base.includes(q)) return 1;
  if (lp.includes(q)) return 2;
  let i = 0;
  for (const ch of lp) if (ch === q[i]) i++;
  return i === q.length ? 3 : -1;
}

async function findFiles(query) {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return [];
  const hits = [];
  for (const p of await getFileIndex()) {
    const s = matchScore(p, q);
    if (s >= 0) hits.push([s, p.length, p]);
  }
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return hits.slice(0, 50).map((h) => h[2]);
}

// ---------- disk ----------

async function listDir(dirRel) {
  const dir = toAbs(dirRel);
  const entries = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (HIDDEN_DIRS.has(e.name)) continue;
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      // Symlinked dirs can point outside the repo (e.g. worktree node_modules); show only linked files.
      if (statKind(path.join(dir, e.name)) !== 'file') continue;
      isDir = false;
    }
    entries.push({ name: e.name, dir: isDir });
  }
  entries.sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name));
  return entries;
}

async function readText(rel) {
  const p = toAbs(rel);
  const st = await fsp.stat(p);
  if (st.size > MAX_FILE_BYTES) return { tooLarge: true, size: st.size };
  const buf = await fsp.readFile(p);
  if (buf.subarray(0, 8000).includes(0)) return { binary: true, size: st.size };
  return { content: buf.toString('utf8') };
}

// ---------- import resolution (relative, tsconfig paths, workspace package exports) ----------

function tryFile(base) {
  if (statKind(base) === 'file') return base;
  const withoutJs = base.replace(/\.[mc]?jsx?$/, '');
  for (const b of new Set([base, withoutJs])) {
    for (const e of EXTS) if (statKind(b + e) === 'file') return b + e;
  }
  if (statKind(base) === 'dir') {
    for (const e of EXTS) {
      const p = path.join(base, `index${e}`);
      if (statKind(p) === 'file') return p;
    }
  }
  return null;
}

let tsPaths = null;
function loadTsPaths() {
  if (tsPaths) return tsPaths;
  tsPaths = [];
  for (const name of ['tsconfig.base.json', 'tsconfig.json']) {
    const co = readJson(path.join(ROOT, name))?.compilerOptions;
    if (!co?.paths) continue;
    const baseUrl = path.resolve(ROOT, co.baseUrl ?? '.');
    for (const [key, targets] of Object.entries(co.paths)) {
      const star = key.indexOf('*');
      tsPaths.push({
        prefix: star < 0 ? key : key.slice(0, star),
        suffix: star < 0 ? null : key.slice(star + 1),
        targets,
        baseUrl,
      });
    }
    break;
  }
  tsPaths.sort((a, b) => b.prefix.length - a.prefix.length);
  return tsPaths;
}

function resolveTsPath(spec) {
  for (const e of loadTsPaths()) {
    let mid = '';
    if (e.suffix === null) {
      if (spec !== e.prefix) continue;
    } else {
      if (!spec.startsWith(e.prefix) || !spec.endsWith(e.suffix)) continue;
      if (spec.length < e.prefix.length + e.suffix.length) continue;
      mid = spec.slice(e.prefix.length, spec.length - e.suffix.length);
    }
    for (const t of e.targets) {
      const hit = tryFile(path.resolve(e.baseUrl, t.replace('*', mid)));
      if (hit) return hit;
    }
  }
  return null;
}

let packageDirs = null;
async function loadPackageDirs() {
  if (packageDirs) return packageDirs;
  packageDirs = new Map();
  const files = (await git(['ls-files', '-z', '--', '*package.json'])).split('\0');
  for (const f of files) {
    if (!f || path.posix.basename(f) !== 'package.json') continue;
    const name = readJson(path.join(ROOT, f))?.name;
    if (name && !packageDirs.has(name)) packageDirs.set(name, path.dirname(path.join(ROOT, f)));
  }
  return packageDirs;
}

const CONDITION_ORDER = ['source', 'development', 'types', 'import', 'module', 'default'];
const conditionRank = (k) => {
  const i = CONDITION_ORDER.indexOf(k);
  return i < 0 ? CONDITION_ORDER.length : i;
};
function exportTargets(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => exportTargets(x, out));
  else if (v && typeof v === 'object') {
    for (const k of Object.keys(v).sort((a, b) => conditionRank(a) - conditionRank(b))) exportTargets(v[k], out);
  }
  return out;
}

function resolveExports(exp, sub) {
  if (exp == null) return null;
  if (typeof exp === 'string' || Array.isArray(exp)) return sub === '.' ? exportTargets(exp) : [];
  const keys = Object.keys(exp);
  if (!keys.some((k) => k.startsWith('.'))) return sub === '.' ? exportTargets(exp) : [];
  if (sub in exp) return exportTargets(exp[sub]);
  let best = null;
  for (const k of keys) {
    const star = k.indexOf('*');
    if (star < 0) continue;
    const pre = k.slice(0, star);
    const suf = k.slice(star + 1);
    if (!sub.startsWith(pre) || !sub.endsWith(suf) || sub.length < pre.length + suf.length) continue;
    if (!best || pre.length > best.pre.length) best = { k, pre, mid: sub.slice(pre.length, sub.length - suf.length) };
  }
  return best ? exportTargets(exp[best.k]).map((t) => t.replaceAll('*', best.mid)) : [];
}

async function resolvePackage(spec) {
  const parts = spec.split('/');
  const n = spec.startsWith('@') ? 2 : 1;
  const name = parts.slice(0, n).join('/');
  const sub = parts.length > n ? `./${parts.slice(n).join('/')}` : '.';
  const dir = (await loadPackageDirs()).get(name);
  if (!dir) return null;
  const pkg = readJson(path.join(dir, 'package.json')) ?? {};
  const candidates = resolveExports(pkg.exports, sub);
  if (candidates) {
    for (const c of candidates) {
      const hit = tryFile(path.resolve(dir, c));
      if (hit) return hit;
    }
    return null;
  }
  if (sub !== '.') return tryFile(path.resolve(dir, sub)) ?? tryFile(path.resolve(dir, 'src', sub));
  const entry = pkg.source ?? pkg.types ?? pkg.typings ?? pkg.module ?? pkg.main;
  return (entry && tryFile(path.resolve(dir, entry))) || tryFile(path.join(dir, 'src', 'index')) || tryFile(path.join(dir, 'index'));
}

async function resolveSpec(fromAbs, spec) {
  const hit =
    spec.startsWith('.') || spec.startsWith('/')
      ? tryFile(path.resolve(path.dirname(fromAbs), spec))
      : resolveTsPath(spec) ?? (await resolvePackage(spec));
  return hit && isInside(hit) ? hit : null;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lineAt = (text, index) => {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
};
const DECL = '(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:const|let|var|function\\*?|class|interface|type|enum|namespace)\\s+';

// Follows barrel re-exports (`export * from`, `export { x } from`) to the real declaration.
async function findExport(file, name, hops = 0, seen = new Set()) {
  if (hops > MAX_BARREL_HOPS || seen.has(file)) return null;
  seen.add(file);
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const at = (index) => ({ file, line: lineAt(text, index) });

  if (name === 'default') {
    const m = /^[ \t]*export\s+default\b/m.exec(text);
    if (m) return at(m.index);
  }
  const direct = new RegExp(`^[ \\t]*export\\s+(?:default\\s+)?${DECL}${escRe(name)}\\b`, 'm').exec(text);
  if (direct) return at(direct.index);

  for (const r of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/g)) {
    for (const item of r[1].split(',')) {
      const [local, exported = local] = item
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .map((s) => s.trim());
      if (exported !== name) continue;
      if (r[2]) {
        const target = await resolveSpec(file, r[2]);
        if (!target) return at(r.index);
        return (await findExport(target, local, hops + 1, seen)) ?? { file: target, line: 1 };
      }
      const decl = new RegExp(`^[ \\t]*${DECL}${escRe(local)}\\b`, 'm').exec(text);
      return at(decl ? decl.index : r.index);
    }
  }
  for (const r of text.matchAll(/export\s+\*\s+from\s*['"]([^'"]+)['"]/g)) {
    const target = await resolveSpec(file, r[1]);
    if (!target) continue;
    const hit = await findExport(target, name, hops + 1, seen);
    if (hit) return hit;
  }
  return null;
}

async function resolveImport({ from, spec, name }) {
  const fromAbs = toAbs(from);
  const target = await resolveSpec(fromAbs, spec);
  if (!target) {
    const external = !spec.startsWith('.') && !spec.startsWith('/');
    throw httpError(404, external ? `"${spec}" is an external package, not followed` : `Can't resolve "${spec}"`);
  }
  const hit = name ? await findExport(target, name) : null;
  return hit ? { path: toRel(hit.file), line: hit.line } : { path: toRel(target), line: 1 };
}

// ---------- http ----------

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_FILE_BYTES * 2) {
        reject(httpError(413, 'File too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

async function route(pathname, q, req) {
  switch (pathname) {
    case '/api/info':
      return {
        root: ROOT,
        branch: (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })).trim(),
        maxDepth: MAX_DEPTH,
      };
    case '/api/changes':
      return { changes: await listChanges(q.mode) };
    case '/api/diff':
      return { diff: await fileDiff(q.path, q.old, q.mode) };
    case '/api/ls':
      return { entries: await listDir(q.dir) };
    case '/api/file':
      return readText(q.path);
    case '/api/find':
      return { files: await findFiles(q.q ?? '') };
    case '/api/resolve':
      return resolveImport(q);
    case '/api/save': {
      if (req.method !== 'POST') throw httpError(405, 'POST required');
      const p = toAbs(q.path);
      if (statKind(p) !== 'file') throw httpError(404, 'File not found');
      await fsp.writeFile(p, await readBody(req), 'utf8');
      return { ok: true };
    }
    default:
      throw httpError(404, 'Not found');
  }
}

const CLIENT_HTML = fs.readFileSync(path.join(HERE, 'client.html'));

const server = http.createServer(async (req, res) => {
  // Reject DNS-rebinding and cross-site writes: only same-machine, same-app requests.
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (host !== '127.0.0.1' && host !== 'localhost') return res.writeHead(403).end();
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(CLIENT_HTML);
  }
  res.setHeader('content-type', 'application/json; charset=utf-8');
  try {
    if (req.method === 'POST' && req.headers['x-lite-diff'] !== '1') throw httpError(403, 'Forbidden');
    const data = await route(url.pathname, Object.fromEntries(url.searchParams), req);
    res.end(JSON.stringify(data));
  } catch (e) {
    res.statusCode = e.status ?? (e.code === 'ENOENT' ? 404 : 500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

function openBrowser(url) {
  if (process.platform === 'win32') {
    const target = PLAIN_TAB ? url : `msedge --app=${url}`;
    spawn('cmd', ['/c', `start "" ${target}`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

function listen(port, triesLeft = 10) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && triesLeft > 0) return listen(port + 1, triesLeft - 1);
    console.error(e.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`lite-diff → ${url}\n  repo: ${ROOT}\n  ctrl+click depth: ${MAX_DEPTH}\n  Ctrl+C to stop`);
    if (!NO_OPEN) openBrowser(url);
  });
}

listen(PORT);
