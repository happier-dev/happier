import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Checkout tooling (apps/stack, scripts/workspaces) runs live from the shared
 * checkout by design, but the product packages it imports are the committed
 * revision's: a half-landed edit in another lane's package file must not break
 * every `stack start` and reload (P03-TOOLING-ISOLATION, 2026-11-16).
 *
 * Module URLs stay the checkout's paths, so resolution, node_modules and
 * import.meta.url are unchanged; only the bytes of a pinned module that differ
 * from HEAD are replaced by HEAD's. When HEAD moves, the controller (it has Git)
 * writes HEAD's bytes of every pinned module the checkout changed, then the
 * manifest of HEAD blob ids, into `.happier-tooling-pin/`; it also records a
 * module edited after that as it serves it. The source mirror synchronizes the
 * directory to execution hosts, whose tooling reads it without Git.
 *
 * `HAPPIER_STACK_TOOLING_PACKAGES=live` loads the checkout's packages instead
 * (tests, and a lane trying its own tooling edit that consumes its own
 * uncommitted package edit before committing the producer).
 */
export const TOOLING_PIN_DIR = '.happier-tooling-pin';
const MANIFEST_VERSION = 1;
const MODULE_EXTENSION = /\.(?:ts|tsx|mts|cts|mjs|js|cjs|json)$/u;
const NOT_TOOLING_INPUT = /\.(?:test|spec|bench)\.|\/__tests__\/|\/fixtures\/|\/\.happier-plugin\/|^apps\/(?:ui\/sources|docs|website|desktop)\//u;
// Blobs a running process may still need after HEAD moved; Git re-supplies them on the controller.
const RETAINED_BLOB_MS = 24 * 60 * 60 * 1000;

export function gitBlobId(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** Repository-relative module paths whose committed bytes tooling loads. */
export function isPinnedToolingModule(path) {
  return /^(?:packages|apps)\//u.test(path) && !path.startsWith('apps/stack/')
    && MODULE_EXTENSION.test(path) && !NOT_TOOLING_INPUT.test(path);
}

export function toolingPackagesMode(env = process.env) {
  return String(env.HAPPIER_STACK_TOOLING_PACKAGES ?? '').trim() === 'live' ? 'live' : 'pinned';
}

function writeAtomic(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(temporary, bytes);
  renameSync(temporary, path);
}

function git(repoDir, args, options = {}) {
  // Read-only: never take the shared checkout's index lock (an index refresh by
  // `git diff` would, and a killed tool would leave it behind for every lane).
  const result = spawnSync('git', ['-C', repoDir, ...args], { maxBuffer: 1 << 30, windowsHide: true, ...options,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  if (result.status !== 0) {
    throw new Error(`[tooling-pin] git ${args[0]} failed (${result.status}): ${String(result.stderr ?? '').trim()}`);
  }
  return result.stdout;
}

/** HEAD's blob ids for every pinned module; rewritten by the controller only when HEAD moves. */
export function readToolingPinManifest({ repoDir, hasGit = existsSync(join(repoDir, '.git')) }) {
  const pinDir = join(repoDir, TOOLING_PIN_DIR);
  const manifestPath = join(pinDir, 'manifest.json');
  let recorded = null;
  try { recorded = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { recorded = null; }
  if (recorded?.version !== MANIFEST_VERSION) recorded = null;
  if (!hasGit) return recorded ? { ...recorded, hasGit } : null;
  const revision = String(git(repoDir, ['rev-parse', '--verify', 'HEAD^{commit}'], { encoding: 'utf8' })).trim();
  if (recorded?.revision === revision) return { ...recorded, hasGit };
  const blobs = {};
  for (const line of String(git(repoDir, ['ls-tree', '-r', '-z', '--full-tree', revision, '--', 'packages', 'apps'],
    { encoding: 'utf8' })).split('\0')) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const [mode, type, id] = line.slice(0, tab).split(' ');
    const path = line.slice(tab + 1);
    if (type === 'blob' && mode !== '120000' && isPinnedToolingModule(path)) blobs[path] = id;
  }
  const manifest = { version: MANIFEST_VERSION, revision, blobs };
  // HEAD bytes of every pinned module the checkout changed go up front, before
  // the manifest names this revision, so the mirror carries both together.
  writeChangedModuleBlobs({ repoDir, pinDir, blobs });
  writeAtomic(manifestPath, JSON.stringify(manifest));
  pruneToolingPinBlobs({ pinDir, blobs });
  return { ...manifest, hasGit };
}

function writeChangedModuleBlobs({ repoDir, pinDir, blobs }) {
  const ids = [...new Set(String(git(repoDir, ['diff', '--name-only', '-z', 'HEAD', '--', 'packages', 'apps', ':!apps/stack'],
    { encoding: 'utf8' })).split('\0').filter(path => blobs[path]).map(path => blobs[path]))]
    .filter(id => !existsSync(join(pinDir, 'blobs', id)));
  if (!ids.length) return;
  // One batch read: `<id> blob <size>\n<bytes>\n` per object.
  const output = git(repoDir, ['cat-file', '--batch'], { input: `${ids.join('\n')}\n` });
  let offset = 0;
  for (const id of ids) {
    const newline = output.indexOf(0x0a, offset);
    const size = Number(output.subarray(offset, newline).toString('utf8').split(' ')[2]);
    writeAtomic(join(pinDir, 'blobs', id), output.subarray(newline + 1, newline + 1 + size));
    offset = newline + 1 + size + 1;
  }
}

function pruneToolingPinBlobs({ pinDir, blobs, now = Date.now() }) {
  const blobDir = join(pinDir, 'blobs');
  const referenced = new Set(Object.values(blobs));
  let entries = [];
  try { entries = readdirSync(blobDir); } catch { return; }
  for (const name of entries) {
    if (referenced.has(name) || !/^[a-f0-9]{40,64}$/u.test(name)) continue;
    const path = join(blobDir, name);
    try { if (now - statSync(path).mtimeMs > RETAINED_BLOB_MS) unlinkSync(path); } catch { /* another writer's prune */ }
  }
}

/** HEAD's bytes for one blob: the synchronized store, else (controller) Git, recorded into the store. */
function readHeadBlob({ repoDir, manifest, id }) {
  const path = join(repoDir, TOOLING_PIN_DIR, 'blobs', id);
  try { return readFileSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!manifest.hasGit) return null;
  const bytes = git(repoDir, ['cat-file', 'blob', id]);
  writeAtomic(path, bytes);
  return bytes;
}

const FORMAT_BY_EXTENSION = { '.ts': 'module-typescript', '.mts': 'module-typescript', '.tsx': 'module-typescript',
  '.cts': 'commonjs-typescript', '.mjs': 'module', '.js': 'module', '.cjs': 'commonjs', '.json': 'json' };

/**
 * Registers the pin around the source runtime. `registerContent` must run before
 * tsx registers (so tsx transforms the bytes this hook supplies); the returned
 * `registerResolution` runs after the source runtime (so a HEAD import of a file
 * deleted in the checkout still resolves to HEAD's bytes).
 */
export function registerToolingPackagePin({ repoDir, env = process.env, stderr = process.stderr }) {
  repoDir = resolve(repoDir);
  if (toolingPackagesMode(env) === 'live' || typeof nodeModule.registerHooks !== 'function') return { registerResolution() {} };
  let manifest;
  const warned = new Set();
  const warn = (key, message) => {
    if (warned.has(key)) return;
    warned.add(key);
    stderr.write(`[tooling-pin] ${message}\n`);
  };
  const readManifest = () => {
    if (manifest !== undefined) return manifest;
    try {
      manifest = readToolingPinManifest({ repoDir });
    } catch (error) {
      manifest = null;
      warn('manifest', `committed package manifest unavailable (${error instanceof Error ? error.message : error}); product packages load from the checkout`);
    }
    if (manifest === null) warn('manifest', 'no committed package manifest on this host yet; product packages load from the checkout');
    return manifest;
  };
  const pinnedPath = url => {
    if (!url.startsWith('file:')) return null;
    const path = fileURLToPath(url.split('?')[0]);
    const rel = relative(repoDir, path);
    if (!rel || rel.startsWith('..') || rel.includes(':')) return null;
    const normalized = rel.split(sep).join('/');
    return isPinnedToolingModule(normalized) ? normalized : null;
  };
  const headSource = (rel, id) => {
    const bytes = readHeadBlob({ repoDir, manifest, id });
    if (!bytes) warn(rel, `HEAD bytes of ${rel} (${manifest.revision.slice(0, 12)}) are not on this host yet; loading the checkout's file`);
    return bytes;
  };
  nodeModule.registerHooks({
    load(url, context, nextLoad) {
      const rel = pinnedPath(url);
      const id = rel && readManifest()?.blobs[rel];
      if (!id) return nextLoad(url, context);
      let result;
      try {
        result = nextLoad(url, context);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        // Deleted in the checkout, present at HEAD.
        const source = headSource(rel, id);
        if (!source) throw error;
        const extension = rel.slice(rel.lastIndexOf('.'));
        return { format: context.format ?? FORMAT_BY_EXTENSION[extension], source, shortCircuit: true };
      }
      if (result.source == null) return result;
      if (gitBlobId(Buffer.from(result.source)) === id) return result;
      const source = headSource(rel, id);
      return source ? { ...result, source } : result;
    },
  });
  return {
    registerResolution() {
      nodeModule.registerHooks({
        resolve(specifier, context, nextResolve) {
          try {
            return nextResolve(specifier, context);
          } catch (error) {
            if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !context.parentURL || !pinnedPath(context.parentURL)
              || !(specifier.startsWith('./') || specifier.startsWith('../'))) throw error;
            const blobs = readManifest()?.blobs;
            const target = resolve(dirname(fileURLToPath(context.parentURL.split('?')[0])), specifier);
            const candidates = [target, ...['.ts', '.tsx', '.mts', '.cts'].map(extension => target.replace(/\.[cm]?jsx?$/u, extension)),
              `${target}.ts`, join(target, 'index.ts')];
            for (const candidate of candidates) {
              const rel = relative(repoDir, candidate).split(sep).join('/');
              if (blobs?.[rel]) return { url: pathToFileURL(candidate).href, shortCircuit: true };
            }
            throw error;
          }
        },
      });
    },
  };
}
