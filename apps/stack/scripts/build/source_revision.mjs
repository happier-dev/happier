import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGzip, gunzipSync } from 'node:zlib';
import { BuildInputDriftError, mountInstalledNodeModules } from '../../../../scripts/workspaces/buildInputConvergence.mjs';
import { EMBEDDED_FEATURE_POLICIES_OUTPUT, isSourceGeneratedInput, isWorkspaceBuildInputIgnoredPath, readSourceComponentBuildInputs, SERVER_GENERATED_CLIENT_STAMP, SERVER_GENERATED_CLIENTS } from '../utils/fs/workspaceBuildInputs.mjs';
import { run } from '../utils/proc/proc.mjs';
import { sourceBuildNodeArgs } from '../utils/proc/runSourceBuildCommand.mjs';

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
 * - untracked paths are dropped, except the build's declared generated inputs
 *   (isSourceGeneratedInput) and files a package declares as shipped; generated
 *   inputs stay only while they were generated from the revision's own sources,
 *   otherwise their generator regenerates them in the capture
 *   (deriveRevisionGeneratedInputs);
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

/** Whether `repoDir` may select revisions from its own Git objects. Only the
 * controller's checkout may: execution-host mirrors never sync `.git`, and a
 * repository left in one (Sessions keep checkpoints there) holds unrelated
 * history, so a host selects only through the controller's description. The
 * controller marks every Stack and producer it runs in a mirror with
 * `HAPPIER_STACK_SOURCE_MIRROR=1`. */
export function canResolveSourceRevisions({ repoDir, env = process.env }) {
  return env.HAPPIER_STACK_SOURCE_MIRROR !== '1' && existsSync(join(repoDir, '.git'));
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
export async function writeSourceRevisionDescriptor({ repoDir, identity, outputDir, components = ['server', 'daemon'], fullTree = false,
  commit = null }) {
  const tree = {};
  for (const entry of nulList(await git(repoDir, ['ls-tree', '-r', '-z', '--full-tree', identity.revision]))) {
    const tab = entry.indexOf('\t');
    const [mode, type, id] = entry.slice(0, tab).split(' ');
    if (type === 'blob') tree[entry.slice(tab + 1)] = [mode, id];
  }
  // A full-tree description (source revision trees) ships no revision blobs:
  // every base takes the revision's bytes from Git objects (`git archive` here, or
  // this controller's archive of the revision on a host without Git objects), so
  // no working tree, moving or mirrored, contributes a tracked byte to a base.
  const revisionFiles = new Set();
  if (!fullTree) {
    const files = new Set();
    const owners = new Set();
    for (const component of components) {
      const inputs = await readSourceComponentBuildInputs({ repoDir, component });
      for (const file of inputs.files) files.add(file);
      for (const dir of inputs.workspaceDirs) if (dir) owners.add(`${dir.replaceAll('\\', '/')}/`);
    }
    for (const path of files) if (Object.hasOwn(tree, path) && !Object.hasOwn(identity.overlay, path)) revisionFiles.add(path);
    for (const path of nulList(await git(repoDir, ['diff', '--name-only', '-z', '--no-renames', identity.revision, '--']))) {
      if (!Object.hasOwn(tree, path) || Object.hasOwn(identity.overlay, path)) continue;
      if (files.has(path) || ([...owners].some(owner => path.startsWith(owner)) && await readCheckoutBytes(join(repoDir, path)) === null)) {
        revisionFiles.add(path);
      }
    }
  }
  // A later commit served as base + its diff (source revision trees): ship the
  // commit's bytes for each changed path, keyed apart from the base's own blobs.
  const commitTree = {};
  if (commit) for (const entry of nulList(await git(repoDir, ['ls-tree', '-r', '-z', '--full-tree', commit.revision]))) {
    const tab = entry.indexOf('\t');
    const [mode, type, id] = entry.slice(0, tab).split(' ');
    if (type === 'blob') commitTree[entry.slice(tab + 1)] = [mode, id];
  }
  const commitPaths = commit ? Object.fromEntries(commit.paths.map(path => [path, commitTree[path] ?? null])) : null;
  const blobBytes = await readGitBlobs(repoDir, [...new Set([...[...revisionFiles].map(path => tree[path][1]),
    ...Object.values(commitPaths ?? {}).filter(Boolean).map(([, id]) => id)])]);
  const blobs = [...[...revisionFiles].map(path => [path, blobBytes.get(tree[path][1])]),
    ...Object.entries(commitPaths ?? {}).filter(([, entry]) => entry).map(([path, [, id]]) => [`commit:${path}`, blobBytes.get(id)])];
  const untracked = nulList(await git(repoDir, ['ls-files', '-z', '-o', '--exclude-standard']))
    .filter(path => !Object.hasOwn(identity.overlay, path));
  const descriptor = { version: SOURCE_REVISION_DESCRIPTOR_VERSION, revision: identity.revision,
    overlayDigest: identity.overlayDigest, key: identity.key, tree, untracked, overlay: identity.overlay, ...(fullTree ? { fullTree: true } : {}),
    ...(commitPaths ? { commit: { revision: commit.revision, paths: commitPaths } } : {}),
    blobs: blobs.map(([path, bytes]) => [path, bytes.length]) };
  await mkdir(outputDir, { recursive: true });
  const descriptorPath = join(outputDir, `source-revision-${identity.key}-${randomUUID()}.json.gz`);
  await pipeline(Readable.from([Buffer.from(`${JSON.stringify(descriptor)}\n`), ...blobs.map(([, bytes]) => bytes)]),
    createGzip({ level: 1 }), createWriteStream(`${descriptorPath}.tmp`));
  await rename(`${descriptorPath}.tmp`, descriptorPath);
  return descriptorPath;
}

/** Identity plus descriptor in one call. */
export async function resolveSourceRevision({ repoDir, rev = 'HEAD', overlay = [], outputDir, components, fullTree = false }) {
  const identity = await resolveSourceRevisionIdentity({ repoDir, rev, overlay });
  const descriptorPath = await writeSourceRevisionDescriptor({ repoDir, identity, outputDir, components, fullTree });
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
export async function applySourceRevision({ captureDir, sourceDir, files, ownerDirs = [], descriptor, env = process.env, signal }) {
  const shipped = await readDeclaredShippedPaths(captureDir, ownerDirs);
  // Authored untracked paths (the controller's --exclude-standard list) are other lanes' uncommitted
  // work and never enter a revision capture, even under a package's shipped `files` dirs: only ignored
  // generated outputs may survive through that rule (untracked vault.json, 2026-11-16).
  const untracked = new Set(descriptor.untracked ?? []);
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
      if (bytes !== null && !untracked.has(path) && isRevisionKeptUntrackedPath(path, shipped)) result.add(path);
      else await rm(target, { force: true, recursive: true });
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
  await deriveRevisionGeneratedInputs({ captureDir, sourceDir, env, signal });
  return [...result].sort();
}

/** Explicit `files` entries of each owner package (from the capture's manifests):
 * a package can ship an ignored generated file such as its API surface. */
export async function readDeclaredShippedPaths(captureDir, ownerDirs) {
  const shipped = new Set();
  for (const dir of ownerDirs) {
    const owner = dir.replaceAll('\\', '/').replace(/\/$/, '');
    if (!owner) continue;
    const manifest = await readFile(join(captureDir, owner, 'package.json'), 'utf8').then(JSON.parse, () => null);
    for (const entry of Array.isArray(manifest?.files) ? manifest.files : []) {
      if (typeof entry === 'string' && entry && !/[*?{}[\]]/.test(entry)) shipped.add(`${owner}/${entry.replace(/\/$/, '')}`);
    }
  }
  return shipped;
}

/** The untracked paths a revision capture keeps. */
export function isRevisionKeptUntrackedPath(path, shipped) {
  if (isSourceGeneratedInput(path)) return true;
  const parts = path.split('/');
  for (let length = parts.length; length > 0; length -= 1) if (shipped.has(parts.slice(0, length).join('/'))) return true;
  return false;
}

/** A path whose change changes what a revision's generators produce. */
export function isRevisionGeneratorInput(path) {
  return SERVER_GENERATED_CLIENTS.some(({ schema }) => schema === path) || path.startsWith('.github/feature-policy/');
}

async function readStaleServerGeneratedClients(captureDir) {
  const stale = [];
  for (const { schema, client } of SERVER_GENERATED_CLIENTS) {
    const source = await readCheckoutBytes(join(captureDir, schema));
    if (!source) continue;
    const stamp = await readFile(join(captureDir, client, SERVER_GENERATED_CLIENT_STAMP), 'utf8').catch(error =>
      error.code === 'ENOENT' || error.code === 'ENOTDIR' ? null : Promise.reject(error));
    if (stamp?.trim() !== sha256(source)) stale.push(client);
  }
  return stale;
}

/**
 * Ignored generated inputs come from the checkout, which another lane's
 * uncommitted schema may have regenerated (2026-11-15: a clean-revision bundle
 * ran Machine.*Bytes clients, P2022). A capture keeps a checkout client only
 * while the generator's stamp names the capture's (revision's) schema; otherwise
 * the server's own generator regenerates every client inside the capture from
 * the revision's schema. Matching clients cost three small reads. Protocol's
 * embedded feature-policy module follows the same rule through its generator.
 * @returns {Promise<string[]>} the regenerated outputs
 */
export async function deriveRevisionGeneratedInputs({ captureDir, sourceDir, env = process.env, signal }) {
  const regenerated = await deriveEmbeddedFeaturePolicies({ captureDir, env, signal });
  return [...regenerated, ...await deriveServerGeneratedClients({ captureDir, sourceDir, env, signal })];
}

/** Protocol's own generator renders the module from the capture's policy files and
 * writes only a differing module: a matching one costs two small reads. */
async function deriveEmbeddedFeaturePolicies({ captureDir, env, signal }) {
  const generator = join(captureDir, 'packages/protocol/scripts/generate-embedded-feature-policies.mjs');
  const source = await readFile(generator, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (source === null) return [];
  let changed;
  if (source.includes('export async function writeEmbeddedFeaturePolicies')) {
    ({ changed } = await (await import(pathToFileURL(generator).href)).writeEmbeddedFeaturePolicies({ repoRoot: captureDir, env }));
  } else {
    // Revisions before the generator exported its writer: the same generator's CLI.
    const before = await readFile(join(captureDir, EMBEDDED_FEATURE_POLICIES_OUTPUT), 'utf8').catch(() => null);
    await run(process.execPath, [generator], { cwd: captureDir, env, signal, stdio: ['ignore', 'ignore', 'inherit'], captureFailureDiagnostic: true });
    changed = before !== await readFile(join(captureDir, EMBEDDED_FEATURE_POLICIES_OUTPUT), 'utf8').catch(() => null);
  }
  if (!changed) return [];
  console.error(`[source-revision] regenerated ${EMBEDDED_FEATURE_POLICIES_OUTPUT} from the captured feature policy`);
  return [EMBEDDED_FEATURE_POLICIES_OUTPUT];
}

async function deriveServerGeneratedClients({ captureDir, sourceDir, env, signal }) {
  const stale = await readStaleServerGeneratedClients(captureDir);
  if (!stale.length) return [];
  const started = performance.now();
  // Installed tools only, at the capture root: the captured physical clients stay
  // the generator's output, and no workspace link or package cache leads back
  // into the checkout for a write.
  await mountInstalledNodeModules({ sourceModules: join(sourceDir, 'node_modules'), targetModules: join(captureDir, 'node_modules'),
    excludedNames: ['@happier-dev'] });
  await run(process.execPath, sourceBuildNodeArgs({ repoDir: captureDir, scriptPath: join(captureDir, 'apps/server/scripts/generateClients.ts') }), {
    cwd: join(captureDir, 'apps/server'), signal, stdio: ['ignore', 'ignore', 'inherit'], captureFailureDiagnostic: true,
    // Schema sync only checks: the capture's schemas are the revision's bytes.
    env: { ...env, HAPPIER_BUILD_DB_PROVIDERS: 'all', HAPPIER_DEV_TARGET_EXECUTION: '1' } });
  const remaining = await readStaleServerGeneratedClients(captureDir);
  if (remaining.length) throw new Error(`[source-revision] generated server clients still differ from the captured schema: ${remaining.join(', ')}`);
  console.error(`[source-revision] regenerated server clients from the captured schema (${stale.join(', ')}) elapsedMs=${Math.round(performance.now() - started)}`);
  return stale;
}
