import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { lstat, readFile, readdir, readlink, realpath, rm, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createFileChangeObserver, DEFAULT_FILE_CHANGE_CATCH_UP_MS } from '../../../../../packages/cli-common/fileChangeObserver.mjs';
import { pathExists } from '../fs/fs.mjs';
import { readJsonIfExists, writeJsonAtomic } from '../fs/json.mjs';
import { coerceHappyMonorepoRootFromPath, getHappyStacksHomeDir } from '../paths/paths.mjs';
import { isJsonOwnerFileLockActive, readJsonOwnerLockSnapshot, withJsonOwnerFileLock } from './jsonOwnerFileLock.mjs';
import { collectWorkspacePackageJsonPaths, isYarnWorkspace, readWorkspacePatchPaths } from './workspace_package_manifests.mjs';
import { prepareDependencyConsumersForRefresh } from './dependency_consumers.mjs';
import { inspectUiPostinstallOutputs } from './ui_postinstall.mjs';
import { createWorkspaceBuildWaitNotifier } from './workspaceBuildWaitNotifier.mjs';
import { DEPENDENCY_LOCK_STALE_AFTER_MS, dependencyWriterEnv, hasDependencyReadLock, inheritedDependencyWriter, waitForDependencyReaders, withDependencyReadLock } from './dependency_consumption.mjs';

const REFRESH_STATE_VERSION = 7;
const REFRESH_MARKER = '.happier-stack-dependencies-ready';
// Prerequisite owners can nest inside the installer in the same asynchronous
// operation. Independent calls in this process still acquire the real lock.
const dependencyWriters = new AsyncLocalStorage();

export function isDependencyRefreshDisabled(env = process.env) {
  return String(env?.HAPPIER_STACK_SKIP_REFRESH_DEPS ?? '').trim() === '1'
    || String(env?.HAPPIER_STACK_DISABLE_REFRESH_DEPS ?? '').trim() === '1';
}

export function resolveDependencyRefreshMarkerPath(installDir) {
  return join(installDir, 'node_modules', REFRESH_MARKER);
}

export function resolveDependencyInstallRoot(componentDir) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(componentDir);
  return monorepoRoot && existsSync(join(monorepoRoot, 'package.json')) ? monorepoRoot : componentDir;
}

export function resolveDependencyRefreshLockPath(installDir, env = process.env) {
  // Captured source trees can link the canonical installation. Their readers
  // must exclude its writer, rather than locking the source-view spelling.
  let root = resolve(installDir);
  try {
    root = realpathSync(root);
    if (lstatSync(join(root, 'node_modules')).isSymbolicLink()) {
      const target = realpathSync(join(root, 'node_modules'));
      if (!isPathInside(root, target)) root = dirname(target);
    }
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw error;
  }
  const monorepoRoot = coerceHappyMonorepoRootFromPath(root);
  if (monorepoRoot && resolve(monorepoRoot) === root) {
    return join(monorepoRoot, '.project', 'tmp', 'dependency-install.lock');
  }
  const key = createHash('sha256').update(root, 'utf8').digest('hex');
  return join(getHappyStacksHomeDir(env), 'cache', 'dependencies', `${key}.lock`);
}

export function resolveLockedInstallEnv(env = process.env, { lockPath, owner } = {}) {
  // The CLI lifecycle unpacks its runtime tools. Other workspace output owners
  // run explicitly after pnpm; they are not package-manager lifecycle builds.
  const scoped = String(env.HAPPIER_INSTALL_SCOPE ?? '').trim() ? env : { ...env, HAPPIER_INSTALL_SCOPE: 'cli' };
  return lockPath && owner ? dependencyWriterEnv(lockPath, owner, scoped) : scoped;
}

export async function withDependencyRefreshLock({ installDir, env = process.env, signal, wait = true, isRequired }, action) {
  signal?.throwIfAborted();
  await assertDependencyTreeWritable(installDir);
  const lockPath = resolveDependencyRefreshLockPath(installDir, env);
  const inherited = dependencyWriters.getStore();
  const owner = inherited?.get(lockPath);
  if (owner?.active) return await action(owner.context);
  const inheritedWriter = inheritedDependencyWriter(lockPath, env);
  if (inheritedWriter) {
    const generation = await readJsonIfExists(`${lockPath}.generation`);
    const writer = { active: true, context: inheritedWriter,
      beforeGeneration: generation?.completedGeneration ?? null,
      unfinishedAtEntry: false, installationPublished: false };
    try {
      return await dependencyWriters.run(new Map([...(inherited ?? []), [lockPath, writer]]), () => action(inheritedWriter));
    } finally { writer.active = false; }
  }
  if (hasDependencyReadLock(lockPath, env)) {
    throw Object.assign(new Error('Prepare dependencies before consuming the installed tree; a reader cannot acquire mutation custody.'),
      { code: 'HSTACK_WORKSPACE_ADMISSION_ORDER' });
  }
  let observedPublication;
  let required = true;
  const shouldAcquire = isRequired && (async () => {
    const publication = await readJsonIfExists(`${lockPath}.generation`);
    const completed = publication?.completedGeneration ?? null;
    // The existing publisher wakes all waiters. Reinspect canonical freshness
    // once per publication, not once per departing ticket or heartbeat.
    if (observedPublication === undefined || completed !== observedPublication) {
      required = await isRequired();
      observedPublication = completed;
    }
    return required;
  });
  return await withJsonOwnerFileLock(async context => {
    await waitForDependencyReaders({ lockPath, env, signal, wait });
    const generationPath = `${lockPath}.generation`;
    const initialGeneration = await readJsonIfExists(generationPath);
    const beforeGeneration = initialGeneration?.generation ?? null;
    const unfinishedAtEntry = beforeGeneration !== null && beforeGeneration !== initialGeneration.completedGeneration;
    const writer = { active: true, context, beforeGeneration, unfinishedAtEntry, installationPublished: false };
    let result;
    try {
      result = await dependencyWriters.run(new Map([...(inherited ?? []), [lockPath, writer]]), () => action(context));
    } finally { writer.active = false; }
    // The root operation, including its nested prerequisite writers, has now
    // succeeded. A prerequisite repair cannot certify the rest of a tree left
    // unfinished by an earlier installer; only full installation can do that.
    const generation = await readJsonIfExists(generationPath);
    if (generation?.generation && generation.generation !== beforeGeneration
      && (!unfinishedAtEntry || writer.installationPublished)) {
      const outputsChanged = generation.outputsChanged ?? ['install'];
      await writeJsonAtomic(generationPath, { ...generation, completedGeneration: generation.generation,
        completedExpoGeneration: outputsChanged.some(output => output !== 'server-generated-client:prisma')
          ? generation.generation : readCompletedExpoGeneration(generation) });
    }
    return result;
  }, {
    lockPath,
    errorLabel: 'dependency refresh lock',
    timeoutMs: Infinity,
    staleAfterMs: DEPENDENCY_LOCK_STALE_AFTER_MS,
    onWait: createWorkspaceBuildWaitNotifier({ env, label: 'dependency refresh', kind: 'lock' }),
    signal,
    wait,
    shouldAcquire,
  });
}

/** Finite readers share the installer's existing exclusion boundary. Acquire
 * only after capacity admission; preparation and repairs precede consumption. */
export async function withDependencyConsumption({ installDir, env = process.env, signal, wait = true }, consume) {
  const lockPath = resolveDependencyRefreshLockPath(installDir, env);
  if (dependencyWriters.getStore()?.get(lockPath)?.active) return await consume(env);
  return await withDependencyReadLock({
    lockPath, env, signal, wait,
    onAdmit: async () => {
      const publication = await readJsonIfExists(`${lockPath}.generation`);
      assertDependencyPublicationComplete(installDir, publication);
    },
  }, consume);
}

export function callerHoldsDependencyConsumption({ installDir, env = process.env }) {
  const lockPath = resolveDependencyRefreshLockPath(installDir, env);
  return hasDependencyReadLock(lockPath, env) || inheritedDependencyWriter(lockPath, env) !== null;
}

/** The publication-priority owner delegates only dependency continuation here.
 * A reader blocks a declared writer, but never an independent declared reader. */
export function callerHoldsDependencyResourceBlocking(resource, env = process.env) {
  if (!['dependency', 'dependency-input-writer'].includes(resource?.kind)) return false;
  const lockPath = resolveDependencyRefreshLockPath(resource.installDir, env);
  if (lockPath !== resolve(resource.path)) return false;
  const local = dependencyWriters.getStore()?.get(lockPath);
  const writerEnv = local?.active ? dependencyWriterEnv(lockPath, local.context.owner, env) : env;
  if (inheritedDependencyWriter(lockPath, writerEnv)) return true;
  return resource.kind === 'dependency-input-writer' && hasDependencyReadLock(lockPath, env);
}

export function isDependencyRefreshLockActive({ installDir, env = process.env }) {
  return isJsonOwnerFileLockActive(resolveDependencyRefreshLockPath(installDir, env));
}

export function isDependencyRefreshMutationActive(options) {
  return isDependencyRefreshLockActive(options);
}

/** Starters observe an already-running installer. They acquire no lock and
 * retain no dependency custody after the writer releases its own exclusion. */
export async function waitForDependencyRefreshWriter({ installDir, env = process.env, signal }) {
  signal?.throwIfAborted();
  const lockPath = resolveDependencyRefreshLockPath(installDir, env);
  if (dependencyWriters.getStore()?.get(lockPath)?.active) return false;
  if (inheritedDependencyWriter(lockPath, env)) return false;
  if (hasDependencyReadLock(lockPath, env)) return false;
  // A gate may only be draining existing consumers. Readiness observes
  // installed-byte mutation, as decided by the publication owner, not a
  // request for future mutation custody.
  if (!(await readDependencyPublicationState({ installDir, env })).writerActive) return true;
  const observer = createFileChangeObserver([dirname(lockPath)], {
    isRelevant: (_directory, filename) => filename == null || String(filename) === basename(lockPath),
  });
  const startedAt = Date.now();
  const notify = createWorkspaceBuildWaitNotifier({ env, label: 'dependency refresh', kind: 'lock' });
  const readSnapshot = () => {
    if (!isJsonOwnerFileLockActive(lockPath)) return null;
    const { updatedAtMs: _updatedAtMs, ...owner } = readJsonOwnerLockSnapshot(lockPath).owner ?? {};
    return JSON.stringify(owner);
  };
  try {
    for (;;) {
      const snapshot = observer.capture(readSnapshot);
      if (snapshot === null) return true;
      notify({ lockPath, owner: readJsonOwnerLockSnapshot(lockPath).owner, waitedMs: Date.now() - startedAt });
      await observer.wait({ snapshot, readSnapshot, maxWaitMs: DEFAULT_FILE_CHANGE_CATCH_UP_MS, signal });
    }
  } finally { observer.close(); }
}

export async function waitForDependencyRefresh({ installDir, env = process.env, signal }) {
  if (!await waitForDependencyRefreshWriter({ installDir, env, signal })) return;
  const publication = await readJsonIfExists(`${resolveDependencyRefreshLockPath(installDir, env)}.generation`);
  assertDependencyPublicationComplete(installDir, publication);
}

async function collectDependencyInputPaths({ installDir, componentDir }) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(componentDir);
  const workspaceManifests = monorepoRoot && resolve(installDir) === resolve(monorepoRoot)
    ? await collectWorkspacePackageJsonPaths(monorepoRoot)
    : resolve(installDir) === resolve(componentDir) ? [] : [join(componentDir, 'package.json')];
  return [...new Set([
    join(installDir, 'pnpm-lock.yaml'), join(installDir, 'pnpm-workspace.yaml'), join(installDir, 'package.json'),
    ...workspaceManifests, ...(await readWorkspacePatchPaths(installDir)).map(path => resolve(installDir, path)),
  ].map(path => resolve(path)))].sort();
}

function isPathInside(rootPath, candidatePath) {
  const path = relative(resolve(rootPath), resolve(candidatePath));
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

async function inspectBorrowedNodeModulesLink(installDir) {
  const nodeModules = join(installDir, 'node_modules');
  try {
    if (!(await lstat(nodeModules)).isSymbolicLink()) return null;
    const [root, target] = await Promise.all([realpath(installDir), realpath(nodeModules)]);
    return isPathInside(root, target) ? null : target;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return null;
    throw error;
  }
}

function dependenciesBorrowed(installDir, linkTarget) {
  return Object.assign(new Error(`Dependencies at ${installDir} are borrowed from ${linkTarget}; prepare dependencies in their owning checkout or use a separate installation.`),
    { code: 'HAPPIER_DEPENDENCIES_BORROWED', installDir, linkTarget });
}

async function assertDependencyTreeWritable(installDir) {
  const target = await inspectBorrowedNodeModulesLink(installDir);
  if (target !== null) throw dependenciesBorrowed(installDir, target);
}

function dependencyInputIdentityPath({ installDir, componentDir, inputPath }) {
  for (const [domain, root] of [['install', installDir], ['component', componentDir]]) {
    if (isPathInside(root, inputPath)) return `${domain}:${relative(resolve(root), resolve(inputPath)).split(sep).join('/') || '.'}`;
  }
  throw new Error(`Dependency input is outside its installation and component roots: ${inputPath}`);
}

const manifestInstallFields = [
  'name', 'version', 'private', 'dependencies', 'devDependencies', 'optionalDependencies',
  'peerDependencies', 'peerDependenciesMeta', 'bin', 'workspaces', 'resolutions', 'overrides',
  'packageManager', 'engines', 'os', 'cpu', 'flat', 'bundleDependencies', 'bundledDependencies',
];

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJson(value[key])]));
  }
  return value;
}

function manifestInstallDigest(bytes, { root }) {
  const manifest = JSON.parse(bytes.toString('utf8'));
  const inputs = Object.fromEntries(manifestInstallFields.filter(field => Object.hasOwn(manifest, field))
    .map(field => [field, manifest[field]]));
  if (manifest.directories?.bin != null) inputs.directories = { bin: manifest.directories.bin };
  const scripts = Object.fromEntries(['preinstall', 'install', 'postinstall', ...(root ? ['prepublish', 'prepare'] : [])]
    .filter(stage => Object.hasOwn(manifest.scripts ?? {}, stage)).map(stage => [stage, manifest.scripts[stage]]));
  if (Object.keys(scripts).length) inputs.scripts = scripts;
  return createHash('sha256').update(JSON.stringify(stableJson(inputs))).digest('hex');
}

async function readInputSnapshot({ inputPaths, installDir, componentDir }) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(componentDir);
  const manifests = new Set(monorepoRoot && resolve(installDir) === resolve(monorepoRoot)
    ? (await collectWorkspacePackageJsonPaths(monorepoRoot)).map(path => resolve(path)) : []);
  const rootManifestPath = resolve(join(installDir, 'package.json'));
  if (resolve(componentDir) !== resolve(installDir)) manifests.add(resolve(join(componentDir, 'package.json')));
  const snapshot = [];
  const visit = async inputPath => {
    const path = dependencyInputIdentityPath({ installDir, componentDir, inputPath });
    const info = await lstat(inputPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) snapshot.push({ path, kind: 'missing' });
    else if (info.isFile()) {
      const bytes = await readFile(inputPath);
      snapshot.push({ path, kind: 'file', digest: createHash('sha256').update(bytes).digest('hex'),
        ...(resolve(inputPath) === rootManifestPath || manifests.has(resolve(inputPath))
          ? { installDigest: manifestInstallDigest(bytes, { root: resolve(inputPath) === rootManifestPath }) } : {}) });
    } else if (info.isSymbolicLink()) {
      snapshot.push({ path, kind: 'symlink', targetDigest: createHash('sha256').update(await readlink(inputPath)).digest('hex') });
    } else if (info.isDirectory()) {
      snapshot.push({ path, kind: 'directory' });
      for (const entry of (await readdir(inputPath)).sort()) await visit(join(inputPath, entry));
    } else snapshot.push({ path, kind: 'other', size: Number(info.size) });
  };
  for (const path of inputPaths) await visit(path);
  return snapshot.sort((a, b) => a.path.localeCompare(b.path));
}

async function resolveDependencyIdentity({ installDir, runtimeIdentity }) {
  const manifest = await readJsonIfExists(join(installDir, 'package.json'));
  return {
    packageManager: runtimeIdentity?.packageManager ?? manifest?.packageManager ?? 'unknown',
    nodeAbi: runtimeIdentity?.nodeAbi ?? process.versions.modules ?? 'unknown',
    platform: runtimeIdentity?.platform ?? process.platform,
    architecture: runtimeIdentity?.architecture ?? process.arch,
  };
}

export function dependencyInputsIdentity(identity, inputs) {
  const projected = inputs.map(({ installDigest, digest, ...entry }) => ({
    ...entry, ...(installDigest != null ? { installDigest } : digest != null ? { digest } : {}),
  }));
  return createHash('sha256').update(JSON.stringify(stableJson({ identity, inputs: projected }))).digest('hex');
}

async function inspectSelfReferentialNodeModulesLink(installDir) {
  const nodeModules = join(installDir, 'node_modules');
  const candidatePath = join(nodeModules, 'node_modules');
  try {
    if (!(await lstat(candidatePath)).isSymbolicLink()) return null;
    const [root, candidate] = await Promise.all([realpath(nodeModules), realpath(candidatePath)]);
    return root === candidate ? candidatePath : null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return null;
    throw error;
  }
}

export async function inspectDependencyRefresh({ installDir, componentDir = installDir, runtimeIdentity, env = process.env }) {
  const borrowedNodeModulesTarget = await inspectBorrowedNodeModulesLink(installDir);
  const inputPaths = await collectDependencyInputPaths({ installDir, componentDir });
  const inputSnapshot = await readInputSnapshot({ inputPaths, installDir, componentDir });
  const dependencyIdentity = await resolveDependencyIdentity({ installDir, runtimeIdentity });
  const installIdentity = dependencyInputsIdentity(dependencyIdentity, inputSnapshot);
  const markerPath = resolveDependencyRefreshMarkerPath(installDir);
  const marker = await readJsonIfExists(markerPath);
  // A borrower must observe the publisher's unfinished mutation, rather than
  // treating the absence of its own generation as proof of completion.
  const lockPath = resolveDependencyRefreshLockPath(borrowedNodeModulesTarget ? dirname(borrowedNodeModulesTarget) : installDir, env);
  const generation = await readJsonIfExists(`${lockPath}.generation`);
  const writer = dependencyWriters.getStore()?.get(lockPath);
  // Previous failed or interrupted attempts remain unproven even when the
  // install inputs did not change. Nested checks may consume this writer's
  // marked attempt, but acquiring a new lock cannot bless an older failure.
  const currentWriterAttempt = writer?.active && generation?.generation !== writer.beforeGeneration;
  const unfinishedMutation = generation?.generation != null
    && generation.generation !== generation.completedGeneration && !currentWriterAttempt;
  const selfReferentialNodeModulesLinkPath = await inspectSelfReferentialNodeModulesLink(installDir);
  const admitted = await pathExists(join(installDir, 'node_modules'))
    && marker?.version === REFRESH_STATE_VERSION && typeof marker.identity === 'string'
    && selfReferentialNodeModulesLinkPath === null && !unfinishedMutation;
  const required = !admitted || marker.identity !== installIdentity;
  if (borrowedNodeModulesTarget !== null && required) throw dependenciesBorrowed(installDir, borrowedNodeModulesTarget);
  return { admitted, required,
    inputPaths, inputSnapshot, dependencyIdentity, installIdentity, markerPath, selfReferentialNodeModulesLinkPath };
}

function dependenciesNeedRefresh(installDir, reason, detail = '') {
  return Object.assign(new Error(`[local] dependencies need refresh at ${installDir} (${reason}${detail ? `: ${detail}` : ''}). Retry through the owning dependency preparation entry point.`),
    { code: 'HAPPIER_DEPENDENCIES_NEED_REFRESH', reason, installDir });
}

function assertDependencyPublicationComplete(installDir, publication) {
  if (publication?.generation == null || publication.generation === publication.completedGeneration) return;
  if (publication.installationFailure) throw dependencyInstallationFailure(publication.installationFailure);
  throw dependenciesNeedRefresh(installDir, 'unfinished-installation');
}

async function assertMandatoryOutputsReady({ installDir, componentDir, env, signal }) {
  const uiDir = join(installDir, 'apps', 'ui');
  for (const dir of new Set([uiDir, componentDir])) {
    const failures = await inspectUiPostinstallOutputs(dir, installDir, { env });
    if (failures.length) throw dependenciesNeedRefresh(installDir, 'ui-postinstall-incomplete', failures.join('; '));
  }
  const { ensureServerGeneratedProviderOutputs } = await import('./pm.mjs');
  try {
    await ensureServerGeneratedProviderOutputs(join(installDir, 'apps', 'server'), installDir, { env, quiet: true, checkOnly: true, signal });
  } catch { signal?.throwIfAborted(); throw dependenciesNeedRefresh(installDir, 'prisma-outputs-incomplete'); }
}

export async function assertDependenciesReady({ installDir, componentDir = installDir, env = process.env, runtimeIdentity, signal }) {
  await waitForDependencyRefreshWriter({ installDir, env, signal });
  const isYarnPredecessor = isYarnWorkspace(await readJsonIfExists(join(installDir, 'package.json')));
  const inspect = isYarnPredecessor
    ? (await import(pathToFileURL(join(installDir, 'apps/stack/scripts/utils/proc/dependency_refresh.mjs')).href)).inspectDependencyRefresh
    : inspectDependencyRefresh;
  const readiness = await inspect({ installDir, componentDir, runtimeIdentity, env });
  if (readiness.required) {
    const publication = await readJsonIfExists(`${resolveDependencyRefreshLockPath(installDir, env)}.generation`);
    assertDependencyPublicationComplete(installDir, publication);
    throw dependenciesNeedRefresh(installDir, 'stale-or-unadmitted');
  }
  if (!isYarnPredecessor) await assertMandatoryOutputsReady({ installDir, componentDir, env, signal });
  return readiness;
}

function readCompletedExpoGeneration(generation) {
  // The active pre-change development writer publishes only the global pair.
  // Preserve that conservative meaning until its next producer-owned write.
  return generation?.completedExpoGeneration !== undefined
    ? generation.completedExpoGeneration : generation?.completedGeneration ?? null;
}

/** @typedef {'install' | 'ui-dependency-outputs' | 'server-generated-client:prisma'} DependencyOutput */

/** @param {{ installDir: string, env?: NodeJS.ProcessEnv, output?: DependencyOutput }} options */
export async function markDependencyMutation({ installDir, env = process.env, output = 'install' }) {
  await assertDependencyTreeWritable(installDir);
  const lockPath = resolveDependencyRefreshLockPath(installDir, env);
  const generationPath = `${lockPath}.generation`;
  const previous = await readJsonIfExists(generationPath);
  const writer = dependencyWriters.getStore()?.get(lockPath);
  const outputsChanged = writer?.active && (previous?.generation ?? null) !== writer.beforeGeneration
    ? previous?.outputsChanged ?? ['install'] : [];
  await writeJsonAtomic(generationPath, { generation: randomUUID(), completedGeneration: previous?.completedGeneration ?? null,
    completedExpoGeneration: readCompletedExpoGeneration(previous),
    ...(output !== 'install' && previous?.installationFailure
      ? { installationFailure: previous.installationFailure } : {}),
    outputsChanged: [...new Set([...outputsChanged, output])] });
}

export function dependencyInstallationFailure(error) {
  if (error?.code === 'HAPPIER_DEPENDENCY_REFRESH_FAILED' || error?.name === 'AbortError') return error;
  const pnpmErrorCode = [error?.pnpmErrorCode, error?.code, error?.stdout, error?.stderr, error?.message]
    .map(value => String(value ?? '').match(/\bERR_PNPM_[A-Z_]+\b/u)?.[0]).find(Boolean) ?? null;
  return Object.assign(new Error(`Dependency installation failed (${pnpmErrorCode ?? 'installer-error'}); fix the reported pnpm input error and retry.`, { cause: error }),
    { code: 'HAPPIER_DEPENDENCY_REFRESH_FAILED', pnpmErrorCode });
}

export async function removeInstalledDependencyQuarantine(installDir) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(installDir);
  const workspaceManifests = monorepoRoot && resolve(monorepoRoot) === resolve(installDir)
    ? await collectWorkspacePackageJsonPaths(monorepoRoot) : [];
  for (const root of new Set([installDir, ...workspaceManifests.map(path => dirname(path))])) {
    const modulesDir = join(root, 'node_modules');
    const info = await lstat(modulesDir).catch(error => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    });
    // pnpm quarantines unrecorded packages during hoisted installation. Once
    // installation and output preparation succeed, those copies are obsolete.
    // Never follow a workspace's borrowed dependency tree or scan nested repos.
    if (info?.isDirectory()) await rm(join(modulesDir, '.ignored'), { recursive: true, force: true });
  }
}

export async function withDependencyRefresh({
  installDir, componentDir = installDir, env = process.env, onDependenciesReady = null,
  runtimeIdentity, refreshExisting = true, force = false, signal,
}, refresh) {
  if (typeof refresh !== 'function') throw new TypeError('withDependencyRefresh requires a refresh callback');
  if (onDependenciesReady != null && typeof onDependenciesReady !== 'function') {
    throw new TypeError('withDependencyRefresh requires onDependenciesReady to be a function when provided');
  }
  signal?.throwIfAborted();
  if (!force && onDependenciesReady === null && hasDependencyReadLock(resolveDependencyRefreshLockPath(installDir, env), env)) {
    // A nested warm consumer verifies readiness without requesting a write.
    // Its containing preparation owner must repair before admitting readers.
    await assertDependenciesReady({ installDir, componentDir, env, runtimeIdentity, signal });
    return { refreshed: false, reason: 'up-to-date' };
  }
  const canInstall = refreshExisting && !isDependencyRefreshDisabled(env);
  await waitForDependencyRefreshWriter({ installDir, env, signal });
  if (!force) {
    // Readiness waits only for actual publication mutation. A gate that is
    // merely draining consumers does not prevent canonical input inspection,
    // and an unchanged result never needs mutation custody.
    const readiness = await inspectDependencyRefresh({ installDir, componentDir, runtimeIdentity, env });
    if (!readiness.required || (!canInstall && readiness.selfReferentialNodeModulesLinkPath === null)) {
      if (onDependenciesReady) {
        // Keep the provisioner's borrowed-tree policy without taking writer
        // custody for a readiness callback that may perform no mutation.
        await assertDependencyTreeWritable(installDir);
        signal?.throwIfAborted();
        await onDependenciesReady({ env });
      }
      signal?.throwIfAborted();
      return { refreshed: false, reason: readiness.required ? 'refresh-disabled' : 'up-to-date' };
    }
  }
  let readinessUnderWriter = false;
  let skippedReadiness;
  const result = await withDependencyRefreshLock({ installDir, env, signal,
    isRequired: force ? undefined : async () => {
      const readiness = await inspectDependencyRefresh({ installDir, componentDir, runtimeIdentity, env });
      skippedReadiness = readiness;
      return (readiness.required && canInstall) || readiness.selfReferentialNodeModulesLinkPath !== null;
    },
  }, async context => {
    let before = await inspectDependencyRefresh({ installDir, componentDir, runtimeIdentity, env });
    if (!force && !before.required && onDependenciesReady === null) return { refreshed: false, reason: 'up-to-date' };
    const willInstall = canInstall && (force || before.required);
    const willRepairLink = before.selfReferentialNodeModulesLinkPath !== null;
    if (!willInstall && !willRepairLink) return { refreshed: false, reason: before.required ? 'refresh-disabled' : 'up-to-date' };
    const { stacksNeedingRestart } = willInstall
      ? await prepareDependencyConsumersForRefresh({ installDir, env }) : { stacksNeedingRestart: [] };
    // Cold installation/link repair retains its publication boundary. Warm
    // output inspection runs outside it; output owners exclude actual repairs.
    if (willInstall || willRepairLink) await markDependencyMutation({ installDir, env });
    let repaired = false;
    if (willRepairLink) {
      await unlink(before.selfReferentialNodeModulesLinkPath);
      repaired = true;
      before = await inspectDependencyRefresh({ installDir, componentDir, runtimeIdentity, env });
    }
    const didRefresh = canInstall && (force || before.required);
    const installEnv = resolveLockedInstallEnv(env, context);
    try {
      if (didRefresh) await refresh({ env: installEnv });
      if (onDependenciesReady) {
        await onDependenciesReady({ env: installEnv });
        readinessUnderWriter = true;
      }
    } catch (error) {
      if (!didRefresh) throw error;
      signal?.throwIfAborted();
      const failure = dependencyInstallationFailure(error);
      if (failure.code === 'HAPPIER_DEPENDENCY_REFRESH_FAILED') {
        const generationPath = `${context.lockPath}.generation`;
        const publication = await readJsonIfExists(generationPath);
        await writeJsonAtomic(generationPath, { ...publication,
          installationFailure: { pnpmErrorCode: failure.pnpmErrorCode } });
      }
      throw failure;
    }
    signal?.throwIfAborted();
    if (!didRefresh) return { refreshed: false,
      reason: before.required ? 'refresh-disabled' : repaired ? 'repaired-self-referential-node-modules-link' : 'up-to-date' };
    if (!await pathExists(join(installDir, 'node_modules'))) throw dependenciesNeedRefresh(installDir, 'installation-produced-no-tree');
    await removeInstalledDependencyQuarantine(installDir);
    // Only successful installation publishes. The captured identity deliberately
    // precedes installation; a concurrent source edit is the next caller's work.
    await writeJsonAtomic(before.markerPath, { version: REFRESH_STATE_VERSION,
      identity: before.installIdentity, stacksNeedingRestart });
    dependencyWriters.getStore().get(resolveDependencyRefreshLockPath(installDir, env)).installationPublished = true;
    if (stacksNeedingRestart.length) console.log(`[local] Stacks running on pre-refresh dependencies; restart at the next owner boundary: ${stacksNeedingRestart.join(', ')}`);
    return { refreshed: true, reason: force ? 'forced-refresh' : 'stale-inputs', stacksNeedingRestart };
  });
  if (onDependenciesReady && !readinessUnderWriter) await onDependenciesReady({ env });
  signal?.throwIfAborted();
  return result ?? { refreshed: false, reason: skippedReadiness.required ? 'refresh-disabled' : 'up-to-date' };
}

/** Explicit provisioners already installed this tree. They can publish its
 * first admission, but cannot recertify an existing mismatched installation. */
export async function adoptDependencyInstallation({ installDir, componentDir = installDir,
  env = process.env, onDependenciesReady, signal }) {
  await waitForDependencyRefreshWriter({ installDir, env, signal });
  const readiness = await inspectDependencyRefresh({ installDir, componentDir, env });
  if (!readiness.required) {
    await assertDependencyTreeWritable(installDir);
    signal?.throwIfAborted();
    if (onDependenciesReady) await onDependenciesReady({ env });
    await assertMandatoryOutputsReady({ installDir, componentDir, env, signal });
    signal?.throwIfAborted();
    return { refreshed: false, reason: 'up-to-date' };
  }
  return await withDependencyRefreshLock({ installDir, env, signal }, async context => {
    const before = await inspectDependencyRefresh({ installDir, componentDir, env });
    const marker = await readJsonIfExists(before.markerPath);
    if (dependencyWriters.getStore().get(resolveDependencyRefreshLockPath(installDir, env)).unfinishedAtEntry) {
      throw dependenciesNeedRefresh(installDir, 'unfinished-installation');
    }
    if (existsSync(before.markerPath) && before.required) throw dependenciesNeedRefresh(installDir, 'stale-or-unadmitted');
    if (!await pathExists(join(installDir, 'node_modules'))) throw dependenciesNeedRefresh(installDir, 'missing-installation');
    if (!marker) await markDependencyMutation({ installDir, env });
    if (onDependenciesReady) {
      await onDependenciesReady({ env: resolveLockedInstallEnv(env, context) });
    }
    await assertMandatoryOutputsReady({ installDir, componentDir, env, signal });
    signal?.throwIfAborted();
    if (!marker && !isDependencyRefreshDisabled(env)) await removeInstalledDependencyQuarantine(installDir);
    if (!marker) await writeJsonAtomic(before.markerPath, { version: REFRESH_STATE_VERSION,
      identity: before.installIdentity, stacksNeedingRestart: [] });
    return { refreshed: false, reason: marker ? 'up-to-date' : 'adopted-installation' };
  });
}

export async function readDependencyPublicationState({ installDir, env = process.env }) {
  const marker = await readJsonIfExists(resolveDependencyRefreshMarkerPath(installDir));
  const generation = await readJsonIfExists(`${resolveDependencyRefreshLockPath(installDir, env)}.generation`);
  // The supported Yarn source checkout retains its own installer. It holds
  // this gate during installation but does not publish mutation generations.
  const predecessorWriter = isYarnWorkspace(await readJsonIfExists(join(installDir, 'package.json')));
  return { identity: typeof marker?.identity === 'string' ? marker.identity : null,
    generation: generation?.generation ?? null, completedGeneration: generation?.completedGeneration ?? null,
    completedExpoGeneration: readCompletedExpoGeneration(generation),
    outputsChanged: generation?.outputsChanged ?? (generation?.generation ? ['install'] : []),
    // Current readiness gates may only drain readers; marked unfinished
    // attempts mutate bytes. The predecessor installer has no generations.
    writerActive: (predecessorWriter || (generation?.generation != null && generation.generation !== generation.completedGeneration))
      && isDependencyRefreshMutationActive({ installDir, env }) };
}
