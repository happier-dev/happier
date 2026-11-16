import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, link, lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { BuildInputDriftError, captureBuildInputFiles, mountCapturedWorkspaceDependencies, readBuildInputDependencies } from '../../../../scripts/workspaces/buildInputConvergence.mjs';
import { readSourceComponentBuildInputs } from '../utils/fs/workspaceBuildInputs.mjs';
import { readWorkspacePackages } from '../../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { withJsonOwnerFileLock } from '../utils/proc/jsonOwnerFileLock.mjs';
import { withWorkspaceBundleLock } from '../../../../packages/cli-common/workspaceBundleLock.mjs';
import { isPidAlive } from '../utils/proc/pids.mjs';
import { resolveSourceRuntimeProducerContext, setBundleReadOnly } from './build_source_runtime.mjs';
import { run, runCapture } from '../utils/proc/proc.mjs';
import { resolveDependencyInstallRoot, resolveDependencyRefreshLockPath, resolveDependencyRefreshMarkerPath } from '../utils/proc/dependency_refresh.mjs';
import { sourceBuildNodeArgs } from '../utils/proc/runSourceBuildCommand.mjs';
import { BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH } from '../../../../packages/cli-common/bundledPluginPublicationPolicy.mjs';
import { deriveRevisionGeneratedInputs, isRevisionGeneratorInput, isRevisionKeptUntrackedPath, readDeclaredShippedPaths, readSourceRevisionDescriptor, resolveSourceRevisionIdentity, sourceRevisionKey, writeSourceRevisionDescriptor } from './source_revision.mjs';

/**
 * QA source Stacks run a revision tree from source (owner 2026-11-14: one shared
 * base build per HEAD, each Stack's overlay applied at runtime from source).
 *
 * - One base tree per revision per host: the whole tracked tree at that revision,
 *   the ignored generated inputs the runtime consumes (derived from that revision), and the host's installed
 *   dependencies mounted so workspace imports resolve inside the tree. It is
 *   built once under a lock, published by rename and kept read-only.
 * - Each Stack runs a hardlink clone of it with only its declared overlay files
 *   replaced by their verified checkout bytes. Nothing here bundles or compiles,
 *   so it never takes a compiler admission.
 * - HEAD moves every few minutes, so a reload at commit X runs the newest base B
 *   that is an ancestor of X, plus X's changes since B as a commit overlay (bytes
 *   from Git, not the checkout). Only a change to the installed-dependency shape
 *   (a package manifest, the lockfile or the workspace list) needs a new base.
 * Other lanes' uncommitted and untracked edits never enter either tree.
 */
const BASE_MARKER = '.happier-revision-tree.json';
const TREE_MARKER = '.happier-revision-tree-ref.json';
const DESCRIBED_SUFFIX = '.described';
const runGit = promisify(execFile);

async function git(repoDir, args) {
  return (await runGit('git', ['-C', repoDir, ...args], { maxBuffer: 1 << 30 })).stdout;
}

/** Paths that change what a base mounts or generates; they cannot be overlaid. */
function shapesBase(path) {
  return path === 'pnpm-lock.yaml' || path === 'pnpm-workspace.yaml' || path === 'package.json' || path.endsWith('/package.json')
    || isRevisionGeneratorInput(path);
}

/** Bases this controller built or described, newest first. A remote host builds a described base once. */
async function readKnownBases(treesRoot) {
  const entries = await readdir(treesRoot, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const known = [];
  for (const entry of entries) {
    const revision = entry.isDirectory() && existsSync(join(treesRoot, entry.name, BASE_MARKER)) ? entry.name
      : entry.isFile() && entry.name.endsWith(DESCRIBED_SUFFIX) ? entry.name.slice(0, -DESCRIBED_SUFFIX.length) : null;
    if (!revision || !/^[a-f0-9]{40,64}$/.test(revision)) continue;
    known.push({ revision, at: (await lstat(join(treesRoot, entry.name))).mtimeMs });
  }
  return [...new Map(known.sort((a, b) => a.at - b.at).map(base => [base.revision, base])).values()].sort((a, b) => b.at - a.at);
}

/**
 * Describe `rev` (+ declared overlay) as the newest compatible base plus a commit
 * overlay. Runs on the controller (Git); the descriptor travels to execution hosts.
 * @returns {Promise<{ revision: string, base: string, key: string, descriptorPath: string, commitPaths: number }>}
 */
export async function resolveSourceTreeRevision({ repoDir, treesRoot, rev = 'HEAD', overlay = [], outputDir }) {
  const target = (await git(repoDir, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`])).trim();
  let base = target;
  let paths = [];
  for (const candidate of await readKnownBases(treesRoot)) {
    if (candidate.revision === target) { paths = []; base = target; break; }
    const ancestor = await runGit('git', ['-C', repoDir, 'merge-base', '--is-ancestor', candidate.revision, target]).then(() => true, () => false);
    if (!ancestor) continue;
    const changed = (await git(repoDir, ['diff', '--name-only', '-z', '--no-renames', candidate.revision, target, '--'])).split('\0').filter(Boolean);
    if (changed.some(shapesBase)) continue;
    base = candidate.revision;
    paths = changed;
    break;
  }
  await mkdir(treesRoot, { recursive: true });
  await writeFile(join(treesRoot, `${base}${DESCRIBED_SUFFIX}`), '');
  const identity = await resolveSourceRevisionIdentity({ repoDir, rev: base, overlay });
  const descriptorPath = await writeSourceRevisionDescriptor({ repoDir, identity, outputDir, fullTree: true,
    ...(base === target ? {} : { commit: { revision: target, paths } }) });
  return { revision: target, base, key: sourceRevisionKey({ revision: target, overlayDigest: identity.overlayDigest }),
    descriptorPath, commitPaths: paths.length };
}

async function writeTreeEntry(target, mode, bytes) {
  await rm(target, { force: true, recursive: true });
  await mkdir(dirname(target), { recursive: true });
  if (mode === '120000') await symlink(bytes.toString(), target);
  else await writeFile(target, bytes, { mode: mode === '100755' ? 0o755 : 0o644 });
}

/** Reads the revision description once; the descriptor must describe the full tree. */
async function readTreeDescriptor(descriptorPath) {
  const descriptor = await readSourceRevisionDescriptor(descriptorPath);
  if (!descriptor.fullTree) throw new Error('[source-tree] revision descriptor does not describe the full tree; describe it with fullTree');
  return descriptor;
}

/**
 * A revision's tracked bytes, from Git objects only: `git archive <revision>` from
 * a checkout that has them, or (`archivePath`) the controller's archive of the same
 * revision on a host whose mirror has no Git objects. Unpacked into outputDir with
 * tar, which every supported OS ships.
 */
async function extractRevision({ repoDir, revision, outputDir, archivePath }) {
  const { spawn } = await import('node:child_process');
  await new Promise((resolvePromise, reject) => {
    const archive = archivePath ? null : spawn('git', ['-C', repoDir, 'archive', '--format=tar', revision], { stdio: ['ignore', 'pipe', 'pipe'] });
    const tar = spawn('tar', archivePath ? ['-xzf', archivePath, '-C', outputDir] : ['-x', '-C', outputDir],
      { stdio: [archive ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    const errors = [];
    archive?.stderr.on('data', chunk => errors.push(chunk));
    tar.stderr.on('data', chunk => errors.push(chunk));
    archive?.stdout.pipe(tar.stdin);
    let pending = archive ? 2 : 1;
    const settle = name => code => {
      if (code !== 0) reject(new Error(`[source-tree] ${name} of ${revision} failed (${code}): ${Buffer.concat(errors).toString().trim()}`));
      else if (--pending === 0) resolvePromise();
    };
    archive?.once('error', reject); tar.once('error', reject);
    archive?.once('close', settle('git archive')); tar.once('close', settle('tar extract'));
  });
}

/** Controller side: the revision's tracked bytes as one archive, for a host whose
 * mirror has no Git objects. Written once per base a host lacks. */
export async function writeSourceRevisionArchive({ repoDir, revision, outputPath }) {
  await mkdir(dirname(outputPath), { recursive: true });
  await runGit('git', ['-C', repoDir, 'archive', '--format=tar.gz', '-1', '-o', `${outputPath}.tmp`, revision]);
  await rename(`${outputPath}.tmp`, outputPath);
  return outputPath;
}

async function buildRevisionBase({ repoDir, baseDir, descriptor, env = process.env, signal, requestBaseArchive }) {
  const staging = `${baseDir}.tmp-${randomUUID()}`;
  let archivePath;
  try {
    const inputs = await Promise.all(['server', 'daemon'].map(component => readSourceComponentBuildInputs({ repoDir, component })));
    await mkdir(staging, { recursive: true });
    // Tracked bytes never come from a working tree: other lanes edit the shared
    // checkout (and its mirrors) while a base builds. A mirror can carry a `.git`
    // entry without the revision's objects; only one that resolves the commit uses it.
    const hasRevision = await runGit('git', ['-C', repoDir, 'cat-file', '-e', `${descriptor.revision}^{commit}`]).then(() => true, () => false);
    if (!hasRevision) {
      if (typeof requestBaseArchive !== 'function') {
        throw new Error(`[source-tree] this host has no Git objects for ${descriptor.revision} and no revision archive source; prepare it through the controller's reload`);
      }
      archivePath = `${baseDir}.archive-${randomUUID()}.tar.gz`;
      await requestBaseArchive({ revision: descriptor.revision, path: archivePath, signal });
    }
    await extractRevision({ repoDir, revision: descriptor.revision, outputDir: staging, archivePath });
    // Only the declared generated inputs the runtime consumes come from the checkout
    // (never stray ignored files); a Stack's new (untracked) overlay file is its own,
    // never the shared base's.
    // Authored untracked files (the controller's --exclude-standard list) are other
    // lanes' uncommitted work, even under a package's shipped `files` dirs; only
    // ignored generated outputs survive there (the revision capture's rule).
    const shipped = await readDeclaredShippedPaths(staging, [...new Set(inputs.flatMap(input => input.workspaceDirs))]);
    const untracked = new Set(descriptor.untracked ?? []);
    await captureBuildInputFiles({ sourceDir: repoDir, captureDir: staging, readPaths: async () => [...new Set(inputs.flatMap(input => input.files))]
      .filter(path => !Object.hasOwn(descriptor.tree, path) && !Object.hasOwn(descriptor.overlay, path)
        && !untracked.has(path) && isRevisionKeptUntrackedPath(path, shipped)) });
    // Those generated inputs follow the revision's sources, not the checkout's.
    await deriveRevisionGeneratedInputs({ captureDir: staging, sourceDir: repoDir, env, signal });
    await rm(baseDir, { recursive: true, force: true });
    await rename(staging, baseDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  } finally {
    if (archivePath) await rm(archivePath, { force: true });
  }
  // Mount at the published path: dependency links are absolute (junctions on
  // Windows). Every workspace of the revision resolves inside the tree, so no
  // import reaches the moving checkout's packages.
  const workspaces = await readWorkspacePackages(baseDir);
  await mountCapturedWorkspaceDependencies({ sourceDir: repoDir, captureDir: baseDir,
    workspaceDirs: [...workspaces.values()].map(workspace => relative(baseDir, workspace.root)).filter(Boolean) });
  await deriveDaemonPluginPublication({ treeDir: baseDir, env, signal });
  // Clones share inodes with the base; a write-in-place would leak into every Stack.
  await setBundleReadOnly(baseDir, true);
  // The marker publishes the base; until it exists the next builder starts over.
  await chmod(baseDir, 0o755);
  await writeFile(join(baseDir, BASE_MARKER), JSON.stringify({ revision: descriptor.revision, builtAt: new Date().toISOString() }));
  await chmod(baseDir, 0o555);
}

const PROJECTIONS = '.source-daemon-projections';
const SUPPORT_STORE = 'daemon-support-store';

function supportStoreDir(treesRoot) {
  return join(resolve(treesRoot), SUPPORT_STORE);
}

/**
 * Native runtime support (packaged Provider runtime binaries, the process-custody
 * helpers, the Iroh addon and Session holders) comes from the daemon support owner,
 * built from the Stack tree's own sources (revision + commit diff + overlay) once
 * per support identity per host, and hardlinked where the tree's source runtime
 * resolves it: the CLI runtime root's `tools/unpacked` and the Iroh package's
 * `native/`. Resolvers require the real path inside the runtime root, so these
 * are hardlinks, never symlinks. An unchanged identity only links.
 * @returns {Promise<string>} the support identity this tree consumed
 */
async function stageTreeNativeSupport({ repoDir, treeDir, treesRoot, env, signal }) {
  const storeDir = supportStoreDir(treesRoot);
  // The tree's own owner, loaded through the tree's source runtime.
  const code = `const { pathToFileURL } = await import('node:url');
const { join } = await import('node:path');
const [baseDir, storeDir, dependencyRootDir] = JSON.parse(process.argv[1]);
const owner = await import(pathToFileURL(join(baseDir, 'apps/stack/scripts/build/build_daemon_artifact.mjs')).href);
if (typeof owner.ensureDaemonSupportArtifact !== 'function') throw new Error('[source-tree] this revision predates source-tree native support; reload at a newer --rev');
const support = await owner.ensureDaemonSupportArtifact({ stackBaseDir: storeDir, repoDir: baseDir, dependencyRootDir, env: process.env });
process.stdout.write('HSTACK_DAEMON_SUPPORT ' + JSON.stringify(support) + '\\n');`;
  const output = await runCapture(process.execPath, ['--conditions=happier-source',
    '--import', pathToFileURL(join(treeDir, 'packages/cli-common/registerSourceRuntime.mjs')).href,
    '--input-type=module', '-e', code, JSON.stringify([treeDir, storeDir, resolveDependencyInstallRoot(repoDir)])], {
    cwd: treeDir, signal,
    // Rust intermediates are shared per host, never inside a published base.
    env: { ...env, CARGO_TARGET_DIR: join(storeDir, 'cargo-target') } });
  const line = String(output).split(/\r?\n/u).find(entry => entry.startsWith('HSTACK_DAEMON_SUPPORT '));
  if (!line) throw new Error('[source-tree] daemon support preparation returned no artifact');
  const { fingerprint, payloadDir } = JSON.parse(line.slice('HSTACK_DAEMON_SUPPORT '.length));
  for (const [from, to] of [['tools/unpacked', 'apps/cli/tools/unpacked'],
    ['node_modules/@happier-dev/iroh-native/native', 'packages/iroh-native/native']]) {
    if (!existsSync(join(payloadDir, from))) continue;
    // The clone's directories are its own; unlink, never write through a base inode.
    await rm(join(treeDir, to), { recursive: true, force: true });
    await cloneTree(join(payloadDir, from), join(treeDir, to));
  }
  return fingerprint;
}

/**
 * Delete support artifacts no live Stack tree names. The newest is kept, so a tree
 * still linking one it just prepared never loses it. Runs with the base sweep.
 */
async function sweepUnreferencedSupport({ treesRoot }) {
  const supportDir = join(supportStoreDir(treesRoot), 'artifacts', 'daemon-support');
  const entries = (await readdir(supportDir, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)))
    .filter(entry => entry.isDirectory() && /^[a-f0-9]{16,128}$/.test(entry.name));
  if (entries.length < 2) return [];
  const keep = new Set();
  for (const refs of (await readdir(treesRoot)).filter(name => name.endsWith('.refs'))) {
    for (const name of await readdir(join(treesRoot, refs)).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
      const reference = await readJson(join(treesRoot, refs, name));
      const marker = reference?.treeDir ? await readJson(join(reference.treeDir, TREE_MARKER)) : null;
      if (marker?.supportFingerprint) keep.add(marker.supportFingerprint);
    }
  }
  const dated = await Promise.all(entries.map(async entry => ({ name: entry.name, at: (await lstat(join(supportDir, entry.name))).mtimeMs })));
  keep.add(dated.sort((a, b) => b.at - a.at)[0].name);
  const deleted = [];
  for (const { name } of dated) {
    if (keep.has(name)) continue;
    // The support owner's own artifact lock: never delete one it is publishing.
    await withWorkspaceBundleLock(async () => {
      await setBundleReadOnly(join(supportDir, name), false);
      await rm(join(supportDir, name), { recursive: true, force: true });
    }, { lockPath: `${join(supportDir, name)}.lock`, errorLabel: 'daemon support artifact build lock' });
    deleted.push(name);
  }
  return deleted;
}

/**
 * The daemon's bundled-plugin publication evidence comes from its canonical
 * generator (the same derivation a bundle runs). The base derives it once per
 * revision; a Stack whose commit diff or overlay touches plugin inputs derives
 * its own (the owner's generator-input exception, a light step).
 */
async function deriveDaemonPluginPublication({ treeDir, env, signal }) {
  const generator = join(treeDir, 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts');
  if (!existsSync(generator)) return;
  const output = join(treeDir, PROJECTIONS);
  await rm(output, { recursive: true, force: true });
  await run(process.execPath, sourceBuildNodeArgs({ repoDir: treeDir, scriptPath: generator,
    args: ['--daemon-projections', '--daemon-output-root', output] }), {
    cwd: treeDir, env, signal, stdio: ['ignore', 'ignore', 'inherit'], captureFailureDiagnostic: true });
  const target = join(treeDir, 'apps/cli', BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH);
  await mkdir(dirname(target), { recursive: true });
  await rm(target, { force: true });
  await writeFile(target, await readFile(join(output, 'apps/cli', BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH)));
}

function touchesPluginInputs(paths) {
  return paths.some(path => path.startsWith('packages/plugins/') || path.startsWith('apps/cli/src/plugins/')
    || path.startsWith('apps/cli/scripts/build-owned/'));
}

/** One base per revision on this host; concurrent requests for it build it once. */
function withBaseLock(baseDir, signal, run) {
  return withJsonOwnerFileLock(run, { lockPath: `${baseDir}.lock`, timeoutMs: Infinity, staleAfterMs: Infinity, signal,
    errorLabel: 'source revision base lock' });
}

function referencePath(baseDir, treeDir) {
  return join(`${baseDir}.refs`, `${createHash('sha256').update(treeDir).digest('hex').slice(0, 24)}.json`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8').catch(error => error.code === 'ENOENT' ? 'null' : Promise.reject(error)));
}

/**
 * One base per revision on this host; concurrent requests for it build it once.
 * The requesting Stack's reference is registered under the same lock, so a
 * concurrent sweep can never delete a base a clone is about to read.
 */
export async function prepareSourceRevisionBase({ repoDir, treesRoot, descriptor, treeDir, env = process.env, signal, requestBaseArchive }) {
  const baseDir = join(resolve(treesRoot), descriptor.revision);
  await mkdir(treesRoot, { recursive: true });
  return await withBaseLock(baseDir, signal, async () => {
    const built = !existsSync(join(baseDir, BASE_MARKER));
    if (built) await buildRevisionBase({ repoDir: resolve(repoDir), baseDir, descriptor, env, signal, requestBaseArchive });
    if (treeDir) {
      await mkdir(`${baseDir}.refs`, { recursive: true });
      await writeFile(referencePath(baseDir, treeDir), JSON.stringify({ treeDir, pid: process.pid }));
    }
    return { baseDir, built };
  });
}

/** A reference is live while its tree names this base, or while its preparer still runs. */
async function isLiveReference(baseDir, reference) {
  if (!reference?.treeDir) return false;
  const marker = await readJson(join(reference.treeDir, TREE_MARKER));
  if (marker) return marker.baseDir === baseDir;
  return Number.isInteger(reference.pid) && isPidAlive(reference.pid);
}

/**
 * Delete every base no Stack tree references, except the host's newest base.
 * Runs on new-base creation and on Stack release; there is no timer.
 * @returns {Promise<string[]>} deleted base directories
 */
export async function sweepSourceRevisionBases({ treesRoot, signal }) {
  treesRoot = resolve(treesRoot);
  const entries = await readdir(treesRoot, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const bases = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{40,64}$/.test(entry.name)) continue;
    const marker = await readJson(join(treesRoot, entry.name, BASE_MARKER));
    if (marker) bases.push({ baseDir: join(treesRoot, entry.name), builtAt: Date.parse(marker.builtAt) || 0 });
  }
  bases.sort((a, b) => b.builtAt - a.builtAt);
  const deleted = [];
  for (const { baseDir } of bases.slice(1)) {
    await withBaseLock(baseDir, signal, async () => {
      let live = 0;
      for (const name of await readdir(`${baseDir}.refs`).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
        const path = join(`${baseDir}.refs`, name);
        if (await isLiveReference(baseDir, await readJson(path))) live += 1;
        else await rm(path, { force: true });
      }
      if (live) return;
      await setSourceRevisionTreeWritable(baseDir);
      await rm(baseDir, { recursive: true, force: true });
      await rm(`${baseDir}.refs`, { recursive: true, force: true });
      await rm(`${baseDir}${DESCRIBED_SUFFIX}`, { force: true });
      deleted.push(baseDir);
    });
  }
  await sweepUnreferencedSupport({ treesRoot });
  return deleted;
}

/** Stack stop: remove its tree and reference, then delete bases nobody references. */
export async function releaseStackSourceRevisionTree({ treesRoot, treeDir, signal }) {
  treeDir = resolve(treeDir);
  const marker = await readJson(join(treeDir, TREE_MARKER));
  await rm(treeDir, { recursive: true, force: true });
  if (marker?.baseDir) await rm(referencePath(marker.baseDir, treeDir), { force: true });
  return await sweepSourceRevisionBases({ treesRoot, signal });
}

/** Hardlink files, recreate links; directories are the clone's own. */
async function cloneTree(from, to, roots = { base: from, clone: to }) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isSymbolicLink()) {
      let link = await readlink(source);
      // A workspace link into the base points at the clone's own copy instead.
      if (isAbsolute(link) && link.startsWith(roots.base + sep)) link = join(roots.clone, relative(roots.base, link));
      const info = await lstat(source);
      await symlink(link, target, process.platform === 'win32' && info.isDirectory() ? 'junction' : undefined);
    } else if (entry.isDirectory()) await cloneTree(source, target, roots);
    else await link(source, target);
  }
}

/**
 * The Stack's runtime tree: a clone of the revision base plus its declared overlay.
 * The base is never written.
 * @returns {Promise<{ baseDir: string, treeDir: string, baseBuilt: boolean, overlaid: number, revision: string, key: string }>}
 */
export async function prepareStackSourceRevisionTree({ repoDir, treesRoot, treeDir, descriptorPath, env = process.env, signal, requestBaseArchive }) {
  repoDir = resolve(repoDir);
  treeDir = resolve(treeDir);
  const descriptor = await readTreeDescriptor(descriptorPath);
  const base = await prepareSourceRevisionBase({ repoDir, treesRoot, descriptor, treeDir, env, signal, requestBaseArchive });
  const staging = `${treeDir}.tmp-${randomUUID()}`;
  let overlaid = 0;
  try {
    // Links name the published tree path; the staging directory is renamed into it.
    await cloneTree(base.baseDir, staging, { base: base.baseDir, clone: treeDir });
    await rm(join(staging, BASE_MARKER), { force: true });
    await writeFile(join(staging, TREE_MARKER), JSON.stringify({ baseDir: base.baseDir, revision: descriptor.commit?.revision ?? descriptor.revision }));
    // The served commit's changes since the base, from Git objects.
    for (const [path, entry] of Object.entries(descriptor.commit?.paths ?? {})) {
      if (!entry) await rm(join(staging, path), { force: true, recursive: true });
      else await writeTreeEntry(join(staging, path), entry[0], descriptor.blobs[`commit:${path}`]);
      overlaid += 1;
    }
    const drift = [];
    for (const [path, expected] of Object.entries(descriptor.overlay)) {
      const target = join(staging, path);
      // Unlink first: the clone's file is the base's inode.
      await rm(target, { force: true, recursive: true });
      if (expected === null) { overlaid += 1; continue; }
      const bytes = await readFile(join(repoDir, path)).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (!bytes || createHash('sha256').update(bytes).digest('hex') !== expected) { drift.push(path); continue; }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      overlaid += 1;
    }
    if (drift.length) {
      throw new BuildInputDriftError(`[source-tree] overlay of ${descriptor.key} moved after it was described at ${drift.length} path(s) (first: ${drift[0]}); reload again to describe the current bytes`);
    }
    // A previous clone's directories are its own; never chmod its files (they are the base's inodes).
    await rm(treeDir, { recursive: true, force: true });
    await mkdir(dirname(treeDir), { recursive: true });
    await rename(staging, treeDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    // The previous tree (if any) keeps its own reference; this attempt's goes.
    if (!existsSync(join(treeDir, TREE_MARKER))) await rm(referencePath(base.baseDir, treeDir), { force: true });
    throw error;
  }
  // Run where the tree's links resolve (its published path). The derivation
  // writes only its own output root and the unlinked evidence file.
  if (touchesPluginInputs([...Object.keys(descriptor.commit?.paths ?? {}), ...Object.keys(descriptor.overlay)])) {
    await deriveDaemonPluginPublication({ treeDir, env, signal });
  }
  const supportFingerprint = await stageTreeNativeSupport({ repoDir, treeDir, treesRoot, env, signal });
  await writeOwnFile(join(treeDir, TREE_MARKER), JSON.stringify({ baseDir: base.baseDir,
    revision: descriptor.commit?.revision ?? descriptor.revision, supportFingerprint }));
  // A new base, or a Stack that moved to another base, can leave an unreferenced one.
  await sweepSourceRevisionBases({ treesRoot, signal });
  const revision = descriptor.commit?.revision ?? descriptor.revision;
  return { baseDir: base.baseDir, treeDir, baseBuilt: base.built, overlaid, revision, base: descriptor.revision,
    overlayDigest: descriptor.overlayDigest ?? null,
    key: sourceRevisionKey({ revision, overlayDigest: descriptor.overlayDigest ?? null }) };
}

/** Restore write permission before deleting a tree (bases are kept read-only). */
export async function setSourceRevisionTreeWritable(directory) {
  await setBundleReadOnly(directory, false);
}

/**
 * QA (non-producer) Stacks reload onto source revision trees by default (owner
 * 2026-11-14); the repository producer's own Stack keeps its bundles.
 * `HAPPIER_STACK_SOURCE_TREES=0` on a Stack rolls it back to the bundle path
 * (rollback window, 2026-11-16); `=1` forces trees.
 */
export function selectsSourceTreeReload({ stackBaseDir, repoDir, env = process.env }) {
  const flag = String(env.HAPPIER_STACK_SOURCE_TREES ?? '').trim();
  if (flag === '0') return false;
  if (flag === '1') return true;
  return resolveSourceRuntimeProducerContext({ repoDir, stackBaseDir, env }).producerStackName !== basename(resolve(stackBaseDir));
}

/** Host-wide root for revision bases, beside the shared source bundles. */
export function sourceRevisionTreesRoot(stackBaseDir) {
  return join(dirname(resolve(stackBaseDir)), 'source-revision-trees');
}

/** Files a Stack writes into its clone are its own: unlink first, never write through a base inode. */
async function writeOwnFile(path, contents) {
  await rm(path, { force: true });
  await writeFile(path, contents);
}

/** A source launcher at the path a bundle keeps its entry, so every bundle-record
 * consumer (selection, launch specs, probes, subprocess spawning) is unchanged. */
function sourceLauncher(treeDir, entry) {
  return `// Generated by source_revision_tree.mjs: run this tree's source through the canonical source runtime.
await import(${JSON.stringify(pathToFileURL(join(treeDir, 'packages/cli-common/registerSourceRuntime.mjs')).href)});
${entry}
`;
}

/**
 * Prepare each requested component as its own Stack tree (server and daemon can
 * run on different hosts) and publish a bundle-shaped record for it, so the
 * existing reload admission, selection and launch owners consume it unchanged.
 * @returns {Promise<Record<string, object>>} component records keyed by component
 */
export async function prepareSourceTreeRuntimeComponents({ repoDir, stackBaseDir, descriptorPath, components, env = process.env, signal, logger = console,
  requestBaseArchive }) {
  const treesRoot = sourceRevisionTreesRoot(stackBaseDir);
  // The tree mounts the checkout's installation: bind it as a bundle does, so
  // launches refuse after a dependency change until the Stack reloads.
  const installRoot = resolveDependencyInstallRoot(repoDir);
  const dependencyPublication = { ...await readBuildInputDependencies({ sourceDir: repoDir, env }),
    markerPath: resolveDependencyRefreshMarkerPath(installRoot),
    generationPath: `${resolveDependencyRefreshLockPath(installRoot, env)}.generation` };
  const prepared = {};
  for (const { component, serverComponent = 'happier-server-light', dbProvider } of components) {
    const started = performance.now();
    // Each preparation gets its own tree: the incumbent keeps running from its tree
    // until the restart retires it, and stop then releases every tree but the selected one.
    const tree = await prepareStackSourceRevisionTree({ repoDir, treesRoot, signal, descriptorPath, env, requestBaseArchive,
      treeDir: join(resolve(stackBaseDir), 'source-runtime', `tree-${component}-${randomUUID().slice(0, 8)}`) });
    const t = tree.treeDir;
    const identity = createHash('sha256').update(JSON.stringify([tree.key, component, serverComponent, dbProvider ?? null])).digest('hex').slice(0, 16);
    // The shared capture record shape: 64-hex input identity, full overlay digest.
    const sourceCapture = { revision: tree.revision, ...(tree.overlayDigest ? { overlayDigest: tree.overlayDigest } : {}),
      base: tree.base, capturedAt: new Date().toISOString(), inputIdentity: createHash('sha256').update(tree.key).digest('hex') };
    let record;
    if (component === 'daemon') {
      const cliDir = join(t, 'apps/cli');
      const entrypoint = join(cliDir, 'src/index.mjs');
      await writeOwnFile(entrypoint, sourceLauncher(t, `await import(${JSON.stringify(pathToFileURL(join(cliDir, 'src/index.ts')).href)});`));
      record = { identity, entrypoint, runtimeCommand: entrypoint, args: [], runtimeDir: cliDir, nodeEntrypoint: entrypoint, cliDir,
        env: { HAPPIER_STACK_CLI_ROOT_DIR: cliDir, HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint,
          HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0', HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '0' } };
    } else {
      const serverDir = join(t, 'apps/server');
      const entrypoint = join(serverDir, 'sources/main.mjs');
      await writeOwnFile(entrypoint, sourceLauncher(t, `await import(${JSON.stringify(pathToFileURL(join(serverDir, 'sources',
        serverComponent === 'happier-server-light' ? 'main.light.ts' : 'main.ts')).href)});`));
      const provider = dbProvider ?? (serverComponent === 'happier-server-light' ? 'sqlite' : 'postgres');
      const script = { postgres: 'full', mysql: 'mysql', pglite: 'light' }[provider];
      const migrate = join(serverDir, 'scripts/migrate.mjs');
      await writeOwnFile(migrate, sourceLauncher(t, script
        ? `await import(${JSON.stringify(pathToFileURL(join(serverDir, `scripts/migrate.${script}.deploy.ts`)).href)});`
        : `const { runSqliteMigrationDeploy } = await import(${JSON.stringify(pathToFileURL(join(serverDir, 'scripts/migrate.sqlite.deploy.ts')).href)});
await runSqliteMigrationDeploy({ serverRoot: ${JSON.stringify(serverDir)}, runSchemaSync: async () => {} });`));
      record = { identity, entrypoint, runtimeCommand: entrypoint, args: [], runtimeDir: serverDir, serverDir, serverComponent, dbProvider: provider,
        env: { HAPPIER_DB_PROVIDER: provider, ...(provider === 'sqlite' ? { HAPPIER_SQLITE_MIGRATIONS_DIR: join(serverDir, 'prisma/sqlite/migrations') } : {}) },
        migration: { mode: 'external', command: migrate, args: [], cwd: serverDir } };
    }
    Object.assign(record, { sourceCapture, dependencyPublication, inputIdentity: sourceCapture.inputIdentity, sourceTree: { base: tree.base, baseBuilt: tree.baseBuilt, overlaid: tree.overlaid } });
    await writeOwnFile(join(t, 'source-bundle.json'), JSON.stringify(record, null, 2));
    logger.error(`[source-tree] prepared component=${component} rev=${tree.revision} base=${tree.base} baseBuilt=${tree.baseBuilt} overlaid=${tree.overlaid} elapsedMs=${Math.round(performance.now() - started)}`);
    prepared[component] = record;
  }
  return prepared;
}

/** Stack stop: release each component tree this Stack holds except the one its
 * selection names. A restart selects its new tree before it stops the incumbent,
 * so only the incumbent's tree goes; a plain stop keeps the selected tree, which
 * the next start launches. A Stack without trees is untouched. */
export async function releaseStackSourceTrees({ stackBaseDir, components = ['server', 'daemon'], signal }) {
  const sourceRoot = join(resolve(stackBaseDir), 'source-runtime');
  // An in-flight reload's finished tree is not selected yet. Its activation
  // still needs it; the Stack's next stop releases the incumbent's tree.
  if (isPidAlive((await readJson(join(sourceRoot, 'start.pending.json')))?.pid)) return [];
  const entries = await readdir(sourceRoot, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const released = [];
  for (const component of components) {
    const selected = await readJson(join(sourceRoot, `selected-${component}.json`));
    const selectedEntrypoint = typeof selected?.entrypoint === 'string' ? resolve(selected.entrypoint) : null;
    // Finished trees only: `tree-<component>[-<id>]`, never a preparation's staging directory.
    const pattern = new RegExp(`^tree-${component}(?:-[a-f0-9]{8})?$`);
    for (const entry of entries) {
      if (!entry.isDirectory() || !pattern.test(entry.name)) continue;
      const treeDir = join(sourceRoot, entry.name);
      if (selectedEntrypoint?.startsWith(treeDir + sep)) continue;
      await releaseStackSourceRevisionTree({ treesRoot: sourceRevisionTreesRoot(stackBaseDir), treeDir, signal });
      released.push(treeDir);
    }
  }
  return released;
}
