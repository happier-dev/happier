import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGzip, gunzipSync } from 'node:zlib';
import { BuildInputDriftError } from '../../../../scripts/workspaces/buildInputConvergence.mjs';
import { isWorkspaceBuildInputIgnoredPath, readSourceComponentBuildInputs } from '../utils/fs/workspaceBuildInputs.mjs';

/**
 * QA source captures run one committed revision plus the paths a Stack
 * declares as its own uncommitted overlay (owner, 2026-11-14). Other lanes'
 * edits in the shared checkout never enter a capture.
 *
 * Git exists only on the controller: execution-host mirrors carry no `.git`.
 * The controller therefore describes the revision once, and every host applies
 * that description to the capture it already makes from its own checkout:
 * - every tracked capture input has its revision blob shipped, so later
 *   checkout edits and mirror lag are repaired from Git objects;
 * - untracked authored paths are dropped; ignored generated outputs stay;
 * - overlay paths keep the checkout's bytes, which must equal their declared digest.
 *
 * A descriptor is gzip(JSON header, "\n", raw blob bytes in header order). A
 * server+daemon+expo revision ships ~450 MiB of blobs, past V8's ~512 MiB string
 * limit once text-encoded, so blobs never enter a JavaScript string.
 */
export const SOURCE_REVISION_DESCRIPTOR_VERSION = 2;

const runGit = promisify(execFile);

async function git(repoDir, args) {
  const { stdout } = await runGit('git', ['-C', repoDir, ...args], { maxBuffer: 1 << 30, encoding: 'buffer' });
  return stdout;
}

function nulList(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

/** Overlay paths are repository-relative POSIX paths, from `--overlay` or the
 * Stack's `HAPPIER_STACK_SOURCE_OVERLAY` (comma or newline separated). */
export function parseSourceOverlayPaths(value) {
  const entries = (Array.isArray(value) ? value : String(value ?? '').split(/[,\n]/))
    .map(entry => String(entry).trim().replaceAll('\\', '/').replace(/\/+$/, '')).filter(Boolean);
  for (const entry of entries) {
    if (isAbsolute(entry) || /^[A-Za-z]:/.test(entry) || entry.split('/').some(part => part === '..' || part === '.' || !part)) {
      throw new Error(`[source-revision] overlay paths must be repository-relative: ${entry}`);
    }
  }
  return [...new Set(entries)].sort();
}

export function gitBlobId(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readGitBlobs(repoDir, ids) {
  if (!ids.length) return new Map();
  const child = spawn('git', ['-C', repoDir, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks = [];
  const stderr = [];
  child.stdout.on('data', chunk => chunks.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`[source-revision] git cat-file failed: ${Buffer.concat(stderr).toString()}`)));
  });
  child.stdin.end(`${ids.join('\n')}\n`);
  await closed;
  const output = Buffer.concat(chunks);
  const blobs = new Map();
  let offset = 0;
  while (offset < output.length) {
    const headerEnd = output.indexOf(0x0a, offset);
    const [id, type, size] = output.subarray(offset, headerEnd).toString().split(' ');
    if (type !== 'blob') throw new Error(`[source-revision] expected blob ${id}, got ${type}`);
    const start = headerEnd + 1;
    blobs.set(id, output.subarray(start, start + Number(size)));
    offset = start + Number(size) + 1;
  }
  return blobs;
}

async function readCheckoutBytes(path) {
  const info = await lstat(path).catch(error => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!info) return null;
  if (info.isSymbolicLink()) return Buffer.from(await readlink(path));
  if (info.isFile()) return await readFile(path);
  return undefined;
}

/**
 * The cheap selection identity of `rev` (default HEAD) plus `overlay`: the
 * commit and the digest of the declared paths' current checkout bytes.
 * @returns {Promise<{ revision: string, overlayDigest: string | null, key: string, overlay: Record<string, string | null> }>}
 */
export async function resolveSourceRevisionIdentity({ repoDir, rev = 'HEAD', overlay = [] }) {
  const revision = (await git(repoDir, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`])).toString().trim();
  const overlayFiles = new Set();
  for (const path of parseSourceOverlayPaths(overlay)) {
    const info = await lstat(join(repoDir, path)).catch(() => null);
    if (info?.isDirectory()) {
      for (const file of nulList(await git(repoDir, ['ls-files', '-z', '-co', '--exclude-standard', '--', path]))) overlayFiles.add(file);
      for (const file of nulList(await git(repoDir, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', revision, '--', path]))) overlayFiles.add(file);
    } else if (info || (await git(repoDir, ['ls-tree', '-z', '--name-only', '--full-tree', revision, '--', path])).length) overlayFiles.add(path);
    else throw new Error(`[source-revision] overlay path is neither in the checkout nor in ${revision}: ${path}`);
  }
  const digests = {};
  for (const path of [...overlayFiles].sort()) {
    const bytes = await readCheckoutBytes(join(repoDir, path));
    digests[path] = bytes ? sha256(bytes) : null;
  }
  const overlayDigest = overlayFiles.size ? sha256(JSON.stringify(Object.entries(digests))) : null;
  return { revision, overlayDigest, key: sourceRevisionKey({ revision, overlayDigest }), overlay: digests };
}

/** One selection key per revision and overlay, for every product built from it. */
export function sourceRevisionKey({ revision, overlayDigest }) {
  return overlayDigest ? `${revision}-${overlayDigest.slice(0, 16)}` : revision;
}

/**
 * Describe a resolved revision for capture on any host. Ship blobs for every
 * tracked input, including files clean now that can change before capture,
 * plus revision files the checkout deleted inside the component owners.
 * The descriptor is a finite request input: callers delete it after use.
 * @returns {Promise<string>} the descriptor path
 */
export async function writeSourceRevisionDescriptor({ repoDir, identity, outputDir, components = ['server', 'daemon'] }) {
  const tree = {};
  for (const entry of nulList(await git(repoDir, ['ls-tree', '-r', '-z', '--full-tree', identity.revision]))) {
    const tab = entry.indexOf('\t');
    const [mode, type, id] = entry.slice(0, tab).split(' ');
    if (type === 'blob') tree[entry.slice(tab + 1)] = [mode, id];
  }
  const files = new Set();
  const owners = new Set();
  for (const component of components) {
    const inputs = await readSourceComponentBuildInputs({ repoDir, component });
    for (const file of inputs.files) files.add(file);
    for (const dir of inputs.workspaceDirs) if (dir) owners.add(`${dir.replaceAll('\\', '/')}/`);
  }
  const revisionFiles = new Set([...files].filter(path => Object.hasOwn(tree, path) && !Object.hasOwn(identity.overlay, path)));
  for (const path of nulList(await git(repoDir, ['diff', '--name-only', '-z', '--no-renames', identity.revision, '--']))) {
    if (!Object.hasOwn(tree, path) || Object.hasOwn(identity.overlay, path)) continue;
    if (files.has(path) || ([...owners].some(owner => path.startsWith(owner)) && await readCheckoutBytes(join(repoDir, path)) === null)) {
      revisionFiles.add(path);
    }
  }
  const blobBytes = await readGitBlobs(repoDir, [...new Set([...revisionFiles].map(path => tree[path][1]))]);
  const blobs = [...revisionFiles].map(path => [path, blobBytes.get(tree[path][1])]);
  const untracked = nulList(await git(repoDir, ['ls-files', '-z', '-o', '--exclude-standard']))
    .filter(path => !Object.hasOwn(identity.overlay, path));
  const descriptor = { version: SOURCE_REVISION_DESCRIPTOR_VERSION, revision: identity.revision,
    overlayDigest: identity.overlayDigest, key: identity.key, tree, untracked, overlay: identity.overlay,
    blobs: blobs.map(([path, bytes]) => [path, bytes.length]) };
  await mkdir(outputDir, { recursive: true });
  const descriptorPath = join(outputDir, `source-revision-${identity.key}-${randomUUID()}.json.gz`);
  await pipeline(Readable.from([Buffer.from(`${JSON.stringify(descriptor)}\n`), ...blobs.map(([, bytes]) => bytes)]),
    createGzip({ level: 1 }), createWriteStream(`${descriptorPath}.tmp`));
  await rename(`${descriptorPath}.tmp`, descriptorPath);
  return descriptorPath;
}

/** Identity plus descriptor in one call. */
export async function resolveSourceRevision({ repoDir, rev = 'HEAD', overlay = [], outputDir, components }) {
  const identity = await resolveSourceRevisionIdentity({ repoDir, rev, overlay });
  const descriptorPath = await writeSourceRevisionDescriptor({ repoDir, identity, outputDir, components });
  return { revision: identity.revision, overlayDigest: identity.overlayDigest, key: identity.key, descriptorPath };
}

export async function readSourceRevisionDescriptor(descriptorPath) {
  const bytes = gunzipSync(await readFile(descriptorPath));
  const headerEnd = bytes.indexOf(0x0a);
  const descriptor = headerEnd < 0 ? null : JSON.parse(bytes.subarray(0, headerEnd).toString('utf8'));
  if (descriptor?.version !== SOURCE_REVISION_DESCRIPTOR_VERSION || !/^[a-f0-9]{40,64}$/.test(descriptor.revision ?? '')
    || !descriptor.tree || !Array.isArray(descriptor.blobs) || !descriptor.overlay || !Array.isArray(descriptor.untracked)) {
    throw new Error('[source-revision] invalid revision descriptor');
  }
  const blobs = {};
  let offset = headerEnd + 1;
  for (const [path, length] of descriptor.blobs) {
    blobs[path] = bytes.subarray(offset, offset += length);
  }
  if (offset !== bytes.length) throw new Error('[source-revision] invalid revision descriptor');
  return { ...descriptor, blobs };
}

/** The identity a capture records and a selection compares. */
export function sourceRevisionIdentity(descriptor) {
  return { revision: descriptor.revision, overlayDigest: descriptor.overlayDigest ?? null, key: descriptor.key };
}

async function writeRevisionEntry(target, mode, bytes) {
  await rm(target, { force: true, recursive: true });
  await mkdir(dirname(target), { recursive: true });
  if (mode === '120000') await symlink(bytes.toString(), target);
  else await writeFile(target, bytes, { mode: mode === '100755' ? 0o755 : 0o644 });
}

/**
 * Make a capture equal to the described revision plus overlay.
 * `files` is the capture's path list; `ownerDirs` are the capture's workspace
 * owner directories, which admit revision files the checkout has deleted.
 * @returns {Promise<string[]>} the revision capture's path list
 */
export async function applySourceRevision({ captureDir, sourceDir, files, ownerDirs = [], descriptor }) {
  const untracked = new Set(descriptor.untracked);
  const result = new Set();
  const drift = [];
  for (const path of files) {
    const target = join(captureDir, path);
    const bytes = await readCheckoutBytes(target);
    if (Object.hasOwn(descriptor.overlay, path)) {
      const expected = descriptor.overlay[path];
      if ((bytes ? sha256(bytes) : null) !== expected) drift.push(path);
      else if (bytes) result.add(path);
      continue;
    }
    const entry = descriptor.tree[path];
    if (!entry) {
      if (untracked.has(path)) await rm(target, { force: true, recursive: true });
      else if (bytes !== null) result.add(path);
      continue;
    }
    if (bytes && gitBlobId(bytes) === entry[1]) { result.add(path); continue; }
    const blob = descriptor.blobs[path];
    if (blob === undefined) { drift.push(path); continue; }
    await writeRevisionEntry(target, entry[0], blob);
    result.add(path);
  }
  // Revision files the checkout deleted are absent from its walk. Admit them
  // inside the same workspace owners, under the owner's input rules.
  const owners = ownerDirs.map(dir => `${dir.replaceAll('\\', '/').replace(/\/$/, '')}/`).filter(dir => dir !== '/');
  for (const [path, blob] of Object.entries(descriptor.blobs)) {
    if (result.has(path)) continue;
    const owner = owners.find(dir => path.startsWith(dir));
    if (!owner || isWorkspaceBuildInputIgnoredPath(posix.relative(owner, path))) continue;
    await writeRevisionEntry(join(captureDir, path), descriptor.tree[path][0], blob);
    result.add(path);
  }
  if (drift.length) {
    throw new BuildInputDriftError(`[source-revision] capture differs from ${descriptor.key} at ${drift.length} path(s) (first: ${drift[0]}); the checkout or its mirror moved after the revision was described`);
  }
  return [...result].sort();
}
