import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, link, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { captureBuildInputFiles, mountCapturedWorkspaceDependencies, readBuildInputDependencies, withBuildInputDependencies } from '../../../../scripts/workspaces/buildInputConvergence.mjs';
import { readSourceComponentBuildInputs } from '../utils/fs/workspaceBuildInputs.mjs';
import { readCliPrivateSourceEntries, readWorkspacePackages } from '../../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { withJsonOwnerFileLock } from '../utils/proc/jsonOwnerFileLock.mjs';
import { withWorkspaceBundleLock } from '../../../../packages/cli-common/workspaceBundleLock.mjs';
import { isPidAlive } from '../utils/proc/pids.mjs';
import { captureSourceWebBuildInputs, readSourceRuntimeProcessCommands, resolveSourceRuntimeProducerContext, setBundleReadOnly } from './build_source_runtime.mjs';
import { readSourceGuestPayloadTargets, sourceGuestPayloadEnvironment } from './source_guest_payload.mjs';
import { run, runCapture } from '../utils/proc/proc.mjs';
import { inspectDependencyRefresh, resolveDependencyInstallRoot, resolveDependencyRefreshLockPath, resolveDependencyRefreshMarkerPath } from '../utils/proc/dependency_refresh.mjs';
import { CURRENT_GENERATION_LINK, createDependencyGeneration, resolveDependencyGenerationContainer } from '../utils/proc/dependency_generations.mjs';
import { SOURCE_RELOAD_ADMISSION_CLASS } from '../utils/dev_targets/remote_commands.mjs';
import { runSourceBuildCommand, sourceBuildNodeArgs } from '../utils/proc/runSourceBuildCommand.mjs';
import { BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH } from '../../../../packages/cli-common/bundledPluginPublicationPolicy.mjs';
import { deriveRevisionGeneratedInputs, isRevisionGeneratorInput, isRevisionKeptUntrackedPath, readDeclaredShippedPaths, readSourceRevisionDescriptor, readSourceRevisionOverlayBytes, resolveSourceRevisionIdentity, sourceRevisionKey, writeSourceRevisionDescriptor } from './source_revision.mjs';

/**
 * QA source Stacks run a revision tree from source (owner 2026-11-14: one shared
 * base build per HEAD, each Stack's overlay applied at runtime from source).
 *
 * - One base tree per revision per host: the whole tracked tree at that revision,
 *   the ignored generated inputs the runtime consumes (derived from that revision), and an
 *   installation of that revision's own dependency inputs mounted so workspace imports
 *   resolve inside the tree (prepareRevisionInstall). It is
 *   built once under a lock, published by rename and kept read-only.
 * - Each Stack runs a hardlink clone of it with only its declared overlay files
 *   replaced by the selected bytes carried in their revision description. The daemon guest payload uses
 *   the same captured-input and payload owners as a bundle reload.
 *   Daemon Plugin UI graphs use the canonical source compiler once per base or
 *   changed input.
 * - HEAD moves every few minutes, so a reload at commit X runs the newest base B
 *   that is an ancestor of X, plus X's changes since B as a commit overlay (bytes
 *   from Git, not the checkout). Changes to installed dependencies or the base's
 *   generation/preparation contract need a new base.
 * Other lanes' uncommitted and untracked edits never enter either tree.
 */
const BASE_MARKER = '.happier-revision-tree.json';
const TREE_MARKER = '.happier-revision-tree-ref.json';
const DESCRIBED_SUFFIX = '.described';
/** Products built from a base: the server and daemon trees and the web export. */
const BASE_COMPONENTS = ['server', 'daemon', 'expo'];
const runGit = promisify(execFile);

async function git(repoDir, args) {
  return (await runGit('git', ['-C', repoDir, ...args], { maxBuffer: 1 << 30 })).stdout;
}

/** Paths that change what a base mounts or prepares; they cannot be overlaid. */
function shapesBase(path) {
  return path === 'pnpm-lock.yaml' || path === 'pnpm-workspace.yaml' || path === 'package.json' || path.endsWith('/package.json')
    // The base executes this preparer's result contract before commit overlays.
    || path === 'apps/cli/scripts/prepareSourcePluginUiArtifacts.mjs'
    // The base places the serialized package manifests this generator emits.
    || path === 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts'
    // The base schema check consumes the tracked enum output before commit overlays.
    || path === 'apps/server/sources/storage/enums.generated.ts'
    || isRevisionGeneratorInput(path);
}

/** Bases this controller built, or that a reload's preparation built on any host, newest first. */
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
  // The base is recorded as reusable only once a preparation builds it (recordSourceTreeBases).
  const identity = await resolveSourceRevisionIdentity({ repoDir, rev: base, overlay });
  const descriptorPath = await writeSourceRevisionDescriptor({ repoDir, identity, outputDir, fullTree: true,
    ...(base === target ? {} : { commit: { revision: target, paths } }) });
  return { revision: target, base, key: sourceRevisionKey({ revision: target, overlayDigest: identity.overlayDigest }),
    descriptorPath, commitPaths: paths.length };
}

/** A preparation built (or reused) these bases: later revisions may describe themselves on them.
 * Recorded only after a preparation succeeds, never when a revision is merely described, so a revision no
 * host could build never becomes every later reload's base (P03-QUEUE-2, TREE-GENERATED live 1-3). */
export async function recordSourceTreeBases({ treesRoot, bases }) {
  await mkdir(treesRoot, { recursive: true });
  for (const base of new Set(bases)) {
    if (typeof base === 'string' && /^[a-f0-9]{40,64}$/.test(base)) await writeFile(join(treesRoot, `${base}${DESCRIBED_SUFFIX}`), '');
  }
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

async function buildRevisionBase({ repoDir, baseDir, descriptor, preparePluginUi, installIdentity, env = process.env, signal, requestBaseArchive }) {
  const staging = `${baseDir}.tmp-${randomUUID()}`;
  let archivePath;
  try {
    const inputs = await Promise.all(BASE_COMPONENTS.map(component => readSourceComponentBuildInputs({ repoDir, component })));
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
  const workspaceDirs = [...workspaces.values()].map(workspace => relative(baseDir, workspace.root)).filter(Boolean);
  // The base mounts a pinned installation of its own revision's dependency
  // inputs, so neither a later refresh nor uncommitted dependency edits in the
  // shared checkout change (or refuse) a running tree.
  const install = installIdentity ? { identity: installIdentity, dir: join(dirname(baseDir), INSTALLS, installIdentity) }
    : await prepareRevisionInstall({ repoDir, baseDir, treesRoot: dirname(baseDir), workspaceDirs, env, signal });
  await mountCapturedWorkspaceDependencies({ sourceDir: install.dir, captureDir: baseDir, workspaceDirs });
  // Plugin UI preparation reads the manifests this derivation places.
  await deriveDaemonPluginPublication({ treeDir: baseDir, env, signal });
  if (preparePluginUi) await prepareDaemonPluginUi({ treeDir: baseDir, env, signal });
  // Clones share inodes with the base; a write-in-place would leak into every Stack.
  await setBundleReadOnly(baseDir, true);
  // The marker publishes the base; until it exists the next builder starts over.
  await chmod(baseDir, 0o755);
  await writeFile(join(baseDir, BASE_MARKER), JSON.stringify({ revision: descriptor.revision, installIdentity: install.identity,
    components: BASE_COMPONENTS, pluginUiPrepared: preparePluginUi, builtAt: new Date().toISOString() }));
  await chmod(baseDir, 0o555);
}

const INSTALLS = 'installs';

/**
 * One installation per dependency identity per host, keyed like the shared
 * checkout's refresh marker (the base's own manifests, lockfile, patches and
 * runtime). When the checkout's published installation has exactly that
 * identity it is reused as a hardlink snapshot (the root and every workspace
 * `node_modules`, without the workspace links a base mounts itself; a refresh
 * replaces installed files, never rewrites them). Otherwise the revision's own
 * lockfile is installed frozen into a dependency generation laid out from the
 * base, so another lane's uncommitted dependency edit never reaches a base.
 * @returns {Promise<{ dir: string, identity: string }>}
 */
async function prepareRevisionInstall({ repoDir, baseDir, treesRoot, workspaceDirs, env, signal }) {
  const { installIdentity: identity } = await inspectDependencyRefresh({ installDir: baseDir, env });
  const dir = join(resolve(treesRoot), INSTALLS, identity);
  await mkdir(dirname(dir), { recursive: true });
  return await withBaseLock(dir, signal, async () => {
    if (existsSync(join(dir, BASE_MARKER))) return { dir, identity };
    const staging = `${dir}.tmp-${randomUUID()}`;
    try {
      const snapshotted = await withBuildInputDependencies({ sourceDir: repoDir, env, signal }, async (_env, publication) => {
        if (publication.state.identity !== identity) return false;
        for (const workspaceDir of ['', ...workspaceDirs]) {
          const installed = await realpath(join(repoDir, workspaceDir, 'node_modules')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
          // A generation-managed root links each installed entry into its generation: copy what they name.
          if (installed) await cloneTree(installed, join(staging, workspaceDir, 'node_modules'), { base: installed, clone: installed,
            skip: ['@happier-dev', '.pnpm-task-run-state-v1', CURRENT_GENERATION_LINK], follow: resolveDependencyGenerationContainer(repoDir) });
        }
        await publication.assertCurrent();
        return true;
      });
      if (!snapshotted) await installRevisionDependencies({ baseDir, staging, workspaceDirs, env, signal });
      await writeFile(join(staging, BASE_MARKER), JSON.stringify({ installIdentity: identity, builtAt: new Date().toISOString() }));
      await rm(dir, { recursive: true, force: true });
      await rename(staging, dir);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    // Never chmod it: a snapshot's files share inodes with the checkout's installation.
    return { dir, identity };
  });
}

/** Frozen install of the base's lockfile in a generation shadow (its project
 * paths real, every other entry linked to the base), then only the installed
 * trees stay: the shadow's source links and workspace links are dropped, so an
 * installation shared by bases never points into one base's sources. */
async function installRevisionDependencies({ baseDir, staging, workspaceDirs, env, signal }) {
  await createDependencyGeneration(baseDir, { genRoot: staging });
  const { ensureUiPostinstallOutputs, installFrozenDependencies } = await import('../utils/proc/pm.mjs');
  await installFrozenDependencies(staging, { env, signal });
  const keepInstalledTrees = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.name === 'node_modules' && entry.isDirectory()) {
        await rm(join(path, '@happier-dev'), { recursive: true, force: true });
        await rm(join(path, '.pnpm-task-run-state-v1'), { recursive: true, force: true });
      } else if (entry.isDirectory()) await keepInstalledTrees(path);
      else await rm(path, { force: true });
    }
  };
  await keepInstalledTrees(staging);
  // The UI's installed outputs (vendored WASM, worker bundles) are written by
  // tools that resolve their own real location: run from the shadow, whose
  // tools link into the base, they would write into the base and leave the
  // installation unpatched. Run them from the base with this installation
  // mounted, then remove what the mount added (the base's physical generated
  // clients stay) so the base mounts the published installation.
  const uiDir = join(baseDir, 'apps', 'ui');
  if (!existsSync(join(uiDir, 'package.json'))) return;
  const before = new Map();
  for (const dir of ['', ...workspaceDirs]) {
    const modules = join(baseDir, dir, 'node_modules');
    before.set(modules, existsSync(modules) ? new Set(await readdir(modules)) : null);
  }
  await mountCapturedWorkspaceDependencies({ sourceDir: staging, captureDir: baseDir, workspaceDirs });
  try {
    await ensureUiPostinstallOutputs(uiDir, baseDir, { env, quiet: true, force: true });
    const ready = join(baseDir, 'node_modules', '.happier-ui-postinstall-ready');
    if (existsSync(ready)) await rename(ready, join(staging, 'node_modules', '.happier-ui-postinstall-ready'));
  } finally {
    for (const [modules, kept] of before) {
      if (kept === null) { await rm(modules, { recursive: true, force: true }); continue; }
      for (const name of await readdir(modules)) if (!kept.has(name)) await rm(join(modules, name), { recursive: true, force: true });
    }
  }
}

/** Installation snapshots no remaining base names go with the base sweep (the newest is kept). */
async function sweepUnreferencedInstalls({ treesRoot, keep }) {
  const root = join(treesRoot, INSTALLS);
  const entries = (await readdir(root, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)))
    .filter(entry => entry.isDirectory() && !entry.name.includes('.tmp-') && existsSync(join(root, entry.name, BASE_MARKER)));
  if (entries.length < 2) return;
  const dated = await Promise.all(entries.map(async entry => ({ name: entry.name, at: (await lstat(join(root, entry.name))).mtimeMs })));
  keep.add(dated.sort((a, b) => b.at - a.at)[0].name);
  for (const { name } of dated) {
    if (keep.has(name)) continue;
    await withBaseLock(join(root, name), undefined, () => rm(join(root, name), { recursive: true, force: true }));
  }
}

const PROJECTIONS = '.source-daemon-projections';
const SUPPORT_STORE = 'daemon-support-store';

/** Source locators read package-local graphs, just like the source CLI. Keep
 * compilation, retained-input reuse and publication failures with that owner. */
async function prepareDaemonPluginUi({ treeDir, env, signal }) {
  const locators = join(treeDir, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts');
  if (!existsSync(locators)) return;
  const code = `const { prepareSourceCliPluginUiArtifacts } = await import(${JSON.stringify(pathToFileURL(join(treeDir, 'apps/cli/scripts/prepareSourcePluginUiArtifacts.mjs')).href)});
const { BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES } = await import(${JSON.stringify(pathToFileURL(locators).href)});
await prepareSourceCliPluginUiArtifacts({ repoRoot: ${JSON.stringify(treeDir)},
  workspaceNames: BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES.map(name => name.slice('@happier-dev/'.length)) });`;
  await runSourceBuildCommand({ repoDir: treeDir, command: process.execPath,
    args: sourceBuildNodeArgs({ repoDir: treeDir, scriptPath: '--input-type=module', args: ['-e', code] }),
    cwd: treeDir, env, signal, captureStdout: false, admissionClass: SOURCE_RELOAD_ADMISSION_CLASS });
}

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
async function stageTreeNativeSupport({ treeDir, treesRoot, dependencyRootDir, env, signal }) {
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
    '--input-type=module', '-e', code, JSON.stringify([treeDir, storeDir, dependencyRootDir])], {
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
  // Serialized package manifests are ignored generated files: a revision archive
  // has only the tracked ones. Plugin UI preparation reads every package's.
  const manifests = join(output, 'packages/plugins');
  for (const id of await readdir(manifests).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
    const bytes = await readFile(join(manifests, id, PLUGIN_MANIFEST));
    const path = join(treeDir, 'packages/plugins', id, PLUGIN_MANIFEST);
    if ((await readFile(path).catch(() => null))?.equals(bytes)) continue;
    // Unlink first: a clone's file is its base's inode.
    await rm(path, { force: true });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
}

const PLUGIN_MANIFEST = '.happier-plugin/plugin.json';

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
export async function prepareSourceRevisionBase({ repoDir, treesRoot, descriptor, treeDir, preparePluginUi = false, env = process.env, signal, requestBaseArchive }) {
  const baseDir = join(resolve(treesRoot), descriptor.revision);
  await mkdir(treesRoot, { recursive: true });
  return await withBaseLock(baseDir, signal, async () => {
    const marker = await readJson(join(baseDir, BASE_MARKER));
    // Upgrade legacy installations, missing component inputs and pre-compiler bases.
    // Existing clones retain their own files and pinned installation.
    const built = !marker?.installIdentity || !BASE_COMPONENTS.every(component => marker.components?.includes(component))
      || (preparePluginUi && !marker.pluginUiPrepared);
    if (marker && built) await setSourceRevisionTreeWritable(baseDir);
    if (built) await buildRevisionBase({ repoDir: resolve(repoDir), baseDir, descriptor, preparePluginUi,
      installIdentity: marker?.installIdentity, env, signal, requestBaseArchive });
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
  const installs = new Set();
  for (const { baseDir } of bases) {
    if (deleted.includes(baseDir)) continue;
    const marker = await readJson(join(baseDir, BASE_MARKER));
    if (marker?.installIdentity) installs.add(marker.installIdentity);
  }
  await sweepUnreferencedInstalls({ treesRoot, keep: installs });
  await sweepUnreferencedSupport({ treesRoot });
  return deleted;
}

/** Stack stop: retain live users, otherwise remove the tree and its base reference.
 * @returns {Promise<string[] | null>} deleted bases, or null when the tree is retained
 */
export async function releaseStackSourceRevisionTree({ treesRoot, treeDir, signal, liveCommands }) {
  treeDir = resolve(treeDir);
  liveCommands = liveCommands === undefined ? await readSourceRuntimeProcessCommands() : liveCommands;
  if (liveCommands === null) return null;
  const canonicalTreeDir = await realpath(treeDir).catch(error => error.code === 'ENOENT' ? treeDir : Promise.reject(error));
  if (liveCommands.includes(treeDir + sep) || liveCommands.includes(canonicalTreeDir + sep)) return null;
  const marker = await readJson(join(treeDir, TREE_MARKER));
  await rm(treeDir, { recursive: true, force: true });
  if (marker?.baseDir) await rm(referencePath(marker.baseDir, treeDir), { force: true });
  return await sweepSourceRevisionBases({ treesRoot, signal });
}

/** Hardlink files, recreate links; directories are the clone's own. A link into
 * `roots.follow` is cloned as what it names. */
async function cloneTree(from, to, roots = { base: from, clone: to }) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (roots.skip?.includes(entry.name) && from === roots.base) continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    const named = entry.isSymbolicLink() && roots.follow ? resolve(from, await readlink(source)) : null;
    if (named?.startsWith(roots.follow + sep)) {
      if ((await lstat(named)).isDirectory()) await cloneTree(named, target, roots);
      else await link(named, target);
    } else if (entry.isSymbolicLink()) {
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
export async function prepareStackSourceRevisionTree({ repoDir, treesRoot, treeDir, descriptorPath, preparePluginUi = false, env = process.env, signal, requestBaseArchive }) {
  repoDir = resolve(repoDir);
  treeDir = resolve(treeDir);
  let descriptor = await readTreeDescriptor(descriptorPath);
  let base;
  try {
    base = await prepareSourceRevisionBase({ repoDir, treesRoot, descriptor, treeDir, preparePluginUi, env, signal, requestBaseArchive });
  } catch (error) {
    // A described ancestor is only a cache candidate: it may be an intermediate
    // commit whose generation or import graph the requested revision repairs.
    // Build the requested commit directly; never retry an invalid requested tree.
    if (!descriptor.commit || signal?.aborted) throw error;
    console.error(`[source-tree] base=${descriptor.revision} preparation failed; preparing requested revision=${descriptor.commit.revision} directly`);
    const tree = { ...descriptor.tree };
    for (const [path, entry] of Object.entries(descriptor.commit.paths)) {
      if (entry) tree[path] = entry;
      else delete tree[path];
    }
    descriptor = { ...descriptor, revision: descriptor.commit.revision, tree, commit: undefined };
    base = await prepareSourceRevisionBase({ repoDir, treesRoot, descriptor, treeDir, preparePluginUi, env, signal, requestBaseArchive });
  }
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
    for (const path of Object.keys(descriptor.overlay)) {
      const target = join(staging, path);
      // Unlink first: the clone's file is the base's inode.
      await rm(target, { force: true, recursive: true });
      const bytes = await readSourceRevisionOverlayBytes({ descriptor, path, sourceDir: repoDir });
      if (bytes !== null) {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }
      overlaid += 1;
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
  const changedPaths = [...Object.keys(descriptor.commit?.paths ?? {}), ...Object.keys(descriptor.overlay)];
  // Shared imports and compiler inputs can change outside plugin directories.
  // The compiler's retained-input inventory owns which graphs need rebuilding.
  if (touchesPluginInputs(changedPaths)) {
    await deriveDaemonPluginPublication({ treeDir, env, signal });
  }
  if (preparePluginUi && changedPaths.length) await prepareDaemonPluginUi({ treeDir, env, signal });
  const installIdentity = (await readJson(join(base.baseDir, BASE_MARKER))).installIdentity;
  const supportFingerprint = await stageTreeNativeSupport({ treeDir, treesRoot,
    dependencyRootDir: join(treesRoot, INSTALLS, installIdentity), env, signal });
  await writeOwnFile(join(treeDir, TREE_MARKER), JSON.stringify({ baseDir: base.baseDir,
    revision: descriptor.commit?.revision ?? descriptor.revision, supportFingerprint }));
  // A new base, or a Stack that moved to another base, can leave an unreferenced one.
  await sweepSourceRevisionBases({ treesRoot, signal });
  const revision = descriptor.commit?.revision ?? descriptor.revision;
  return { baseDir: base.baseDir, treeDir, baseBuilt: base.built, overlaid, revision, base: descriptor.revision, installIdentity,
    overlayDigest: descriptor.overlayDigest ?? null, supportFingerprint,
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
    const tree = await prepareStackSourceRevisionTree({ repoDir, treesRoot, signal, descriptorPath, env, requestBaseArchive, preparePluginUi: component === 'daemon',
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
      // File-URL consumers use the same declared private entry paths as bundles.
      // They execute this tree's source under its already-registered source loader.
      const manifestPath = join(cliDir, 'package.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      for (const [output, source] of Object.entries(readCliPrivateSourceEntries({
        projectDir: cliDir, manifest, publicPrefix: 'apps/cli/package-dist',
      }))) {
        const target = join(t, `${output}.mjs`);
        await mkdir(dirname(target), { recursive: true });
        await writeOwnFile(target, sourceLauncher(t, `export * from ${JSON.stringify(pathToFileURL(source).href)};`));
      }
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
    const targets = component === 'daemon' || env.HAPPIER_DEV_GUEST_CLI_EXPORT === '1' ? readSourceGuestPayloadTargets(env) : null;
    if (targets) {
      // Payload staging rewrites copied scripts. Capture writable inputs through
      // the bundle owner instead of carrying the base's read-only hardlinks.
      const workspace = join(t, 'guest-workspace');
      try {
        const captured = await captureSourceWebBuildInputs({ repoDir: t, component: 'daemon', outputDir: workspace, signal });
        await setBundleReadOnly(workspace, false);
        // As in bundle preparation, the finite compiler owns its process env
        // and loader; tool subprocesses must inherit this host's build inputs.
        const code = `const { buildSourceGuestPayload } = await import(${JSON.stringify(new URL('./source_guest_payload.mjs', import.meta.url).href)});
const payload = await buildSourceGuestPayload({ ...JSON.parse(process.argv[1]), env: process.env });
console.log('HSTACK_GUEST_PAYLOAD ' + JSON.stringify(payload));`;
        const output = await runCapture(process.execPath, sourceBuildNodeArgs({ repoDir: t, scriptPath: '--input-type=module',
          args: ['-e', code, JSON.stringify({ repoDir: captured.repoDir, sourceRepoDir: repoDir,
            dependencyRootDir: join(treesRoot, INSTALLS, tree.installIdentity), outputDir: t, targets, sourceCapture })] }),
        { cwd: t, env, signal });
        const line = String(output).split(/\r?\n/u).find(line => line.startsWith('HSTACK_GUEST_PAYLOAD '));
        if (!line) throw new Error('[source-tree] guest payload preparation returned no artifact');
        record.guestPayload = JSON.parse(line.slice('HSTACK_GUEST_PAYLOAD '.length));
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
      Object.assign(record.env, sourceGuestPayloadEnvironment(record.guestPayload));
    }
    // The tree runs its base's pinned installation snapshot: launches never consult
    // the moving checkout's dependency publication (the captured-closure contract).
    const runtimeDependencyClosure = tree.installIdentity ? { captured: true, identity: tree.installIdentity, imports: [] } : null;
    Object.assign(record, { sourceCapture, dependencyPublication, inputIdentity: sourceCapture.inputIdentity,
      ...(runtimeDependencyClosure ? { runtimeDependencyClosure } : {}),
      sourceTree: { dir: t, base: tree.base, baseBuilt: tree.baseBuilt, overlaid: tree.overlaid } });
    await writeOwnFile(join(t, 'source-bundle.json'), JSON.stringify(record, null, 2));
    logger.error(`[source-tree] prepared component=${component} rev=${tree.revision} base=${tree.base} baseBuilt=${tree.baseBuilt} overlaid=${tree.overlaid} nativeSupport=${tree.supportFingerprint} elapsedMs=${Math.round(performance.now() - started)}`);
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
  let liveCommands;
  for (const component of components) {
    const selected = await readJson(join(sourceRoot, `selected-${component}.json`));
    const selectedEntrypoint = typeof selected?.entrypoint === 'string' ? resolve(selected.entrypoint) : null;
    // Finished trees only: `tree-<component>[-<id>]`, never a preparation's staging directory.
    const pattern = new RegExp(`^tree-${component}(?:-[a-f0-9]{8})?$`);
    for (const entry of entries) {
      if (!entry.isDirectory() || !pattern.test(entry.name)) continue;
      const treeDir = join(sourceRoot, entry.name);
      if (selectedEntrypoint?.startsWith(treeDir + sep)) continue;
      // One observation per release sweep, shared with the low-level release owner.
      liveCommands ??= await readSourceRuntimeProcessCommands();
      if (liveCommands === null) return released;
      const deletedBases = await releaseStackSourceRevisionTree({ treesRoot: sourceRevisionTreesRoot(stackBaseDir), treeDir, signal, liveCommands });
      if (deletedBases !== null) released.push(treeDir);
    }
  }
  return released;
}
