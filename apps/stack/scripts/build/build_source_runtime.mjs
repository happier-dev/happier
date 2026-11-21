import { captureRuntimeDependencies } from './captured_runtime_dependencies.mjs';
import { removeOwnedDirectorySync } from '../utils/fs/fs.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, statSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { runSourceBuildCommand, sourceBuildNodeArgs } from '../utils/proc/runSourceBuildCommand.mjs';
import { runWorkspaceBuildAdmission } from '../utils/proc/workspace_build_admission.mjs';
import { SOURCE_RELOAD_ADMISSION_CLASS } from '../utils/dev_targets/command_resources.mjs';
import { isRepoStackIdentityName } from '../utils/stack/repo_stack_identity.mjs';
import { assertSharedDatabaseMigrationsApplied, SharedDatabaseMigrationError } from '../utils/server/shared_database_migration_gate.mjs';
import { isWorkspaceBundleLockActive, withWorkspaceBundleLock } from '../../../../packages/cli-common/workspaceBundleLock.mjs';
import { isPidAlive, observePidLiveness } from '../utils/proc/pids.mjs';
import { hasTrustedStackRuntimeLifecycle } from '../utils/stack/runtime_state.mjs';
import { readWorkspaceBuildInputs, readSourceComponentBuildInputs, isSourceServerGeneratedInput } from '../utils/fs/workspaceBuildInputs.mjs';
import { readCachedFileDigestSync } from '../utils/fs/cached_file_digest.mjs';
import { writeJsonAtomic } from '../utils/fs/json.mjs';
import { withJsonOwnerFileLock } from '../utils/proc/jsonOwnerFileLock.mjs';
import { redactFailureDiagnostic, run, runCapture } from '../utils/proc/proc.mjs';
import { prepareSourceComponent } from '../utils/dev/devReloadCoordinator.mjs';
import { assertBuildInputDependencies, captureBuildInputFiles, isTerminalBuildFailure, mountCapturedWorkspaceDependencies, mountInstalledNodeModules, readBuildInputDependencies, readBuildInputIdentity, readTerminalBuildFailure, serializeTerminalBuildFailure, withBuildInputDependencies, withSingleTrailingBuildPass } from '../../../../scripts/workspaces/buildInputConvergence.mjs';
import { assertSourceRuntimeDependenciesCurrent, sourceRuntimeDependencyIdentityMatches } from '../../../../packages/cli-common/sourceRuntimeDependencies.mjs';
import { probeCliDistRuntimeImport } from '../utils/cli/cliDistIntegrity.mjs';
import { pendingSourceSelectionAwaitsActivation, retainPendingSourcePreparation, updatePendingSourcePreparationPhase } from '../runtime/shared/pending_source_start.mjs';
import { readBundledPluginPackageResourceRelativePaths } from '../../../../packages/cli-common/bundledPluginResources.mjs';
import { BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH } from '../../../../packages/cli-common/bundledPluginPublicationPolicy.mjs';
import { reapHistoricalTempRoots } from '../utils/dev_targets/historical_temp_roots.mjs';
import { assertWebArtifactPayload } from '../runtime/shared/web_payload.mjs';
import { readPublishedSourceRuntimeRecord, readSelectedSourceRuntimeRecord, readSourceRuntimeBundleRecord, sourceBundleCandidatePath, sourceRuntimeCandidateKey } from '../runtime/shared/source_bundle_record.mjs';
import { resolveDependencyInstallRoot, resolveDependencyRefreshMarkerPath, resolveDependencyRefreshLockPath } from '../utils/proc/dependency_refresh.mjs';
import { diagnoseSourceReloadFailure, emitSourceReloadRefusal, parseSourceReloadRefusalLine, recordSourceReloadRefusal } from '../runtime/shared/source_reload_refusal.mjs';
import { emitSourceAuthorPackages, isFirstPartyBuiltInput } from './source_author_packages.mjs';
import { readSourceRuntimeDependencyIdentity } from './source_author_inputs.mjs';
import { buildSourceGuestPayload, readSourceGuestPayloadArchiveImports, readSourceGuestPayloadTargets, sourceGuestPayloadEnvironment } from './source_guest_payload.mjs';
import { resolveRuntimeBuildAuthority } from '../runtime/shared/runtime_build_authority.mjs';
import { readGreenSourceRuntimeCandidateGroups, sourceRuntimeCaptureUnavailable } from './source_runtime_last_green.mjs';
import { assertSourceReloadBundledPluginFailures } from '../runtime/launch/sourceReloadPluginFailures.mjs';
import { rememberSourceCaptureFailure, withSourceCaptureRetry } from './source_capture_retry.mjs';
import { readSourceSelectionPaths, readSourceSelectionRollbackPaths, sourceRecordReferencePaths } from '../runtime/shared/source_selection_rollback.mjs';
import { readRevisionServerClientRoots, requestRevisionInstallArchive, resolveRevisionDependencyRoot, sourceRevisionTreesRoot } from './source_revision_install.mjs';
import { applySourceRevision, canResolveSourceRevisions, parseSourceOverlayPaths, readSourceCaptureBuildInputs, readSourceRevisionDescriptor, resolveSourceRevisionIdentity, sourceRevisionIdentity, writeSourceRevisionDescriptor } from './source_revision.mjs';

import { SOURCE_CONDITION, SOURCE_RUNTIME_COMMONJS_BANNER, SOURCE_RUNTIME_COMMONJS_DEFINE, SOURCE_RUNTIME_OUTPUT_OPTIONS, assertSourceRuntimeCodeAscii, dropRedundantSourceRuntimeChunkImports, stripUnusedSourceRuntimeBanners, sourceExport, readWorkspacePackages, resolveWorkspaceSource, packageNameOfSpecifier, readCliSourceEntries, createCliSourceProjectionResolver, createWorkspaceSourceResolver, bundleCliSourceSidecars, runtimePackageExports } from '../../../../packages/cli-common/sourceRuntimeEntries.mjs';
export { readWorkspacePackages, resolveWorkspaceSource } from '../../../../packages/cli-common/sourceRuntimeEntries.mjs';

const SHARED_SOURCE_INPUT_MANIFEST = '.source-runtime-shared-inputs.json';

function logSourceRuntimePhase(component, phase, started, status, logger = console) {
  logger.error(`[source-bundle] phase=${phase} elapsedMs=${Math.round(performance.now() - started)} component=${component}${status ? ` status=${status}` : ''}`);
}

/** Both roles derive from one authored-input capture, including their imports
 * and manifests. Capturing only Protocol would mix it with later SDK/host bytes.
 * Installed third-party tools retain their existing dependency-publication owner. */
export async function captureSourceRuntimeSharedInputs({ repoDir, outputDir, signal, env = process.env, revision, treesRoot, revisionArchivePath }) {
  repoDir = resolve(repoDir);
  const { ensureServerGeneratedProviderOutputs } = await import('../utils/proc/pm.mjs');
  await ensureServerGeneratedProviderOutputs(join(repoDir, 'apps/server'), repoDir, { env, quiet: true, signal });
  return await withBuildInputDependencies({ sourceDir: repoDir, env, signal }, async () => {
    const descriptor = revision ? await readSourceRevisionDescriptor(revision.descriptorPath) : null;
    let filesByComponent = {};
    let ownerDirsByComponent = {};
    const capture = await captureBuildInputFiles({ sourceDir: repoDir, captureDir: outputDir,
      readPaths: async () => {
        signal?.throwIfAborted();
        const inputs = Object.fromEntries(await Promise.all(['server', 'daemon'].map(async component => [
          component, await readSourceCaptureBuildInputs({ repoDir, component, descriptor })])));
        filesByComponent = Object.fromEntries(Object.entries(inputs).map(([component, { files }]) => [component, files]));
        ownerDirsByComponent = Object.fromEntries(Object.entries(inputs).map(([component, { workspaceDirs }]) => [component, workspaceDirs]));
        return [...new Set(Object.values(filesByComponent).flat())];
      } });
    const captured = new Set(capture.files);
    let revisionIdentity;
    let dependencyRootDir;
    if (descriptor) {
      // One revision application for both roles keeps their shared bytes identical.
      // Its generated clients, mounted tools and captured runtime dependencies come
      // from the revision's own installation (the checkout's when identical). A caller
      // without the host's revision store (`treesRoot`) captures with the checkout's.
      dependencyRootDir = treesRoot ? await resolveRevisionDependencyRoot({ repoDir, descriptor, treesRoot,
        archivePath: revisionArchivePath, env, signal }) : repoDir;
      const selectedFiles = Object.keys(filesByComponent).flatMap(component => descriptor.inputsByComponent?.[component]?.files ?? []);
      const files = await applySourceRevision({ captureDir: outputDir, sourceDir: dependencyRootDir,
        files: [...new Set([...capture.files, ...selectedFiles])],
        ownerDirs: [...new Set(Object.values(ownerDirsByComponent).flat())], descriptor, env, signal });
      // A capture-owned Prisma layout's client package and clients belong to the server.
      const serverClientRoots = readRevisionServerClientRoots(outputDir);
      filesByComponent = Object.fromEntries(Object.entries(filesByComponent).map(([component, componentFiles]) => {
        const members = new Set(componentFiles);
        const restored = [...ownerDirsByComponent[component], ...(component === 'server' ? serverClientRoots : [])];
        return [component, files.filter(path => members.has(path) || (!captured.has(path)
          && restored.some(dir => path.startsWith(`${dir}/`))))];
      }));
      revisionIdentity = sourceRevisionIdentity(descriptor);
    } else {
      filesByComponent = Object.fromEntries(Object.entries(filesByComponent)
        .map(([component, files]) => [component, files.filter(path => captured.has(path))]));
    }
    const ownDependencies = dependencyRootDir && dependencyRootDir !== repoDir ? { dependencyRootDir } : {};
    await writeFile(join(outputDir, SHARED_SOURCE_INPUT_MANIFEST), JSON.stringify({ filesByComponent, capturedAt: capture.capturedAt,
      ...(revisionIdentity ? { revision: revisionIdentity } : {}), ...ownDependencies }));
    return { repoDir: realpathSync(outputDir), ...(revisionIdentity ? { revision: revisionIdentity } : {}) };
  });
}

async function readSharedSourceInputManifest(sharedSourceInputs) {
  if (!sharedSourceInputs) return null;
  const manifest = JSON.parse(await readFile(join(sharedSourceInputs.repoDir, SHARED_SOURCE_INPUT_MANIFEST), 'utf8'));
  if (!manifest?.filesByComponent || !Array.isArray(manifest.filesByComponent.server)
      || !Array.isArray(manifest.filesByComponent.daemon)) {
    throw new Error('[source-bundle] invalid shared source input capture');
  }
  return manifest;
}

export async function captureSourceWebBuildInputs({ repoDir, outputDir, component = 'expo', signal, sharedSourceInputs, revision, includeGuestPayload = false }) {
  repoDir = resolve(repoDir);
  const sharedManifest = await readSharedSourceInputManifest(sharedSourceInputs);
  const sourceDir = sharedSourceInputs?.repoDir ?? repoDir;
  const descriptor = !sharedManifest && revision ? await readSourceRevisionDescriptor(revision.descriptorPath) : null;
  const inputs = await readSourceCaptureBuildInputs({ repoDir: sourceDir, component, descriptor });
  const guestInputs = includeGuestPayload && component === 'server'
    ? await readSourceCaptureBuildInputs({ repoDir: sourceDir, component: 'daemon', descriptor }) : null;
  const workspaceDirs = [...new Set([...inputs.workspaceDirs, ...(guestInputs?.workspaceDirs ?? [])])];
  signal?.throwIfAborted();
  const started = performance.now();
  const capture = await captureBuildInputFiles({ sourceDir, captureDir: outputDir,
    readPaths: async () => {
      signal?.throwIfAborted();
      return sharedManifest ? sharedManifest.filesByComponent[component]
        : (await readSourceCaptureBuildInputs({ repoDir, component, descriptor })).files;
    } });
  // A shared capture already holds the revision's bytes; a direct capture applies it here.
  if (descriptor) capture.files = await applySourceRevision({ captureDir: outputDir, sourceDir: repoDir,
    files: [...new Set([...capture.files, ...(descriptor.inputsByComponent?.[component]?.files ?? []),
      ...(guestInputs ? descriptor.inputsByComponent?.daemon?.files ?? [] : [])])],
    ownerDirs: workspaceDirs, descriptor, signal });
  const revisionIdentity = sharedManifest?.revision ?? (descriptor ? sourceRevisionIdentity(descriptor) : undefined);
  // The checkout's workspace list can name another lane's untracked package,
  // which the revision drops; mount only the workspaces the capture holds.
  const captured = descriptor ? new Set(capture.files) : null;
  const dependencyRootDir = sharedManifest?.dependencyRootDir;
  await mountCapturedWorkspaceDependencies({ sourceDir: dependencyRootDir ?? repoDir, captureDir: outputDir,
    workspaceDirs: captured ? workspaceDirs.filter(dir => captured.has(`${dir.replaceAll('\\', '/')}/package.json`)) : workspaceDirs });
  if (component === 'expo') {
    const uiManifest = JSON.parse(await readFile(join(outputDir, 'apps/ui/package.json'), 'utf8'));
    const workspaces = await readWorkspacePackages(outputDir);
    const fromSource = createRequire(join(repoDir, 'apps/ui/package.json'));
    const fromCapture = createRequire(join(outputDir, 'apps/ui/package.json'));
    for (const name of Object.keys(uiManifest.dependencies ?? {})) {
      if (workspaces.has(name) || name.startsWith('@types/')) continue;
      try {
        let resolved;
        try { resolved = fromSource.resolve(name); }
        catch (error) {
          // Subpath-only packages intentionally have no root runtime export.
          if (error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') continue;
          throw error;
        }
        await lstat(resolved);
        await lstat(fromCapture.resolve(name));
      } catch (cause) {
        if (!['MODULE_NOT_FOUND', 'ENOENT', 'ENOTDIR'].includes(cause.code)) throw cause;
        const error = new Error(`[source-ui] installed package input is missing: ${name}. Complete dependency refresh before capture.`, { cause });
        error.code = 'HAPPIER_EXPO_DEPENDENCIES_NOT_READY';
        throw error;
      }
    }
  }
  signal?.throwIfAborted();
  const log = component === 'expo' ? console.log : console.error;
  log(`[source-${component === 'expo' ? 'ui' : 'bundle'}] phase=input-capture elapsedMs=${Math.round(performance.now() - started)} files=${capture.files.length}`);
  // Node resolves an entry script's module URL through filesystem aliases.
  // Return that same physical root so /var/folders on macOS cannot skip a
  // generator's direct-entry guard against its /private/var module URL.
  const capturedRepoDir = realpathSync(outputDir);
  return { repoDir: capturedRepoDir, uiProjectDir: join(capturedRepoDir, 'apps/ui'), files: capture.files,
    capturedAt: sharedManifest?.capturedAt ?? capture.capturedAt, ...(revisionIdentity ? { revision: revisionIdentity } : {}),
    ...(dependencyRootDir ? { dependencyRootDir } : {}), inputIdentity: await readBuildInputIdentity({ sourceDir: outputDir, files: capture.files }) };
}

async function linkInstalledDirectory(from, to) {
  if (!existsSync(from)) return;
  await mkdir(dirname(to), { recursive: true });
  await symlink(from, to, process.platform === 'win32' ? 'junction' : 'dir');
}

function isCompilerTracedSource(path) {
  return /^apps\/(?:cli\/src|server\/sources)\/.*\.[cm]?[jt]sx?$/.test(path)
    && !path.endsWith('/generatedBundledPluginManifests.ts');
}

async function sourceBundleFingerprint({ repoDir, identityRepoDir = repoDir, component, serverComponent, dbProvider, consumedPaths, sharedSourceInputs, env = process.env }) {
  const projectDir = join(repoDir, 'apps', component === 'daemon' ? 'cli' : 'server');
  const esbuild = createRequire(pathToFileURL(join(projectDir, 'package.json')))('esbuild');
  const sharedManifest = await readSharedSourceInputManifest(sharedSourceInputs);
  const componentFiles = sharedManifest ? sharedManifest.filesByComponent[component]
    : (await readSourceComponentBuildInputs({ repoDir, component })).files;
  const exportGuestPayload = env.HAPPIER_DEV_GUEST_CLI_EXPORT === '1';
  const files = component === 'server' && exportGuestPayload
    ? [...new Set([...componentFiles, ...(sharedManifest?.filesByComponent.daemon
      ?? (await readSourceComponentBuildInputs({ repoDir, component: 'daemon' })).files)])] : componentFiles;
  const consumed = consumedPaths && new Set(consumedPaths);
  const guestPayloadTargets = component === 'daemon' || component === 'server' && exportGuestPayload ? readSourceGuestPayloadTargets(env) : null;
  const fingerprintFiles = consumed && !guestPayloadTargets ? files.filter(path => !isCompilerTracedSource(path) || consumed.has(path)) : files;
  const options = [identityRepoDir, component, serverComponent, dbProvider, process.version, process.platform, process.arch, esbuild.version, files,
    guestPayloadTargets?.map(({ target, relativeDir }) => [target.bunTarget, relativeDir]) ?? null,
    exportGuestPayload,
    readSourceGuestPayloadArchiveImports(env).map(({ target, sha256 }) => [target.os, target.arch, sha256]),
    component === 'server' ? env.HAPPIER_BUILD_GUEST_CLI_SOURCE ?? 'home-payload' : null,
    component === 'server' ? env.HAPPIER_BUILD_GUEST_CLI_CHANNEL ?? 'publicdev' : null,
    // A revision's own installation is part of what its graph links and captures.
    ...(sharedManifest?.dependencyRootDir ? [sharedManifest.dependencyRootDir] : [])];
  return await readBuildInputIdentity({ sourceDir: sharedSourceInputs?.repoDir ?? repoDir,
    files: fingerprintFiles, options });
}

/** Exact revision (+overlay) locator: the selection key of a revision build. */
function sourceRuntimeRevisionCandidateKey({ repoDir, component, serverComponent, dbProvider, revisionKey }) {
  return `rev-${createHash('sha256').update(JSON.stringify([repoDir, component, serverComponent, dbProvider, revisionKey])).digest('hex')}`;
}

function sameSourceRevision(capture, revision) {
  return capture?.revision === revision.revision && (capture.overlayDigest ?? null) === (revision.overlayDigest ?? null);
}

/** The controller resolves `--rev`/`--overlay` (default: the latest built HEAD)
 * from its Git checkout; an execution host receives the controller's
 * descriptor. A mirror without either keeps the checkout capture. */
async function resolveProducerRevision({ repoDir, sourceRevision, env }) {
  if (sourceRevision?.descriptorPath) {
    const descriptor = await readSourceRevisionDescriptor(sourceRevision.descriptorPath);
    return { ...sourceRevisionIdentity(descriptor), overlay: descriptor.overlay,
      descriptorPath: sourceRevision.descriptorPath, latest: sourceRevision.latest === true };
  }
  if (!canResolveSourceRevisions({ repoDir, env })) return null;
  const overlay = parseSourceOverlayPaths(sourceRevision?.overlay ?? env.HAPPIER_STACK_SOURCE_OVERLAY ?? '');
  const identity = await resolveSourceRevisionIdentity({ repoDir, rev: sourceRevision?.rev ?? 'HEAD', overlay });
  return { ...identity, descriptorPath: null, latest: !sourceRevision?.rev && !overlay.length };
}

/** The revision of this host's most recently captured, still retained, non-overlay
 * daemon revision build: the default a reload selects, so it adopts a finished build
 * instead of waiting for HEAD. Revision locators are read directly so a checkout
 * capture published as the current candidate cannot hide them. */
export async function readLatestBuiltSourceRevision({ repoDir, stackBaseDir }) {
  const bundleRoot = join(dirname(resolve(stackBaseDir)), 'source-bundles');
  let names;
  try { names = await readdir(bundleRoot); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const repo = resolve(repoDir);
  let latest = null;
  for (const name of names) {
    const match = /^candidate-(rev-[a-f0-9]{64})\.json$/.exec(name);
    if (!match) continue;
    const candidate = await readOptionalJson(join(bundleRoot, name));
    if (!/^(?:bundle|runtime)-[^\\/\0]+$/.test(candidate?.outputName ?? '')) continue;
    const record = await readOptionalJson(join(bundleRoot, candidate.outputName, 'source-bundle.json'));
    const capture = record?.sourceCapture;
    if (record?.inputIdentity !== candidate.inputIdentity || !record.cliDir || !capture?.revision || capture.overlayDigest) continue;
    if (match[1] !== sourceRuntimeRevisionCandidateKey({ repoDir: repo, component: 'daemon', serverComponent: 'happier-server-light',
      dbProvider: undefined, revisionKey: capture.revision })) continue;
    if (!latest || Date.parse(capture.capturedAt) > Date.parse(latest.capturedAt)) latest = capture;
  }
  return latest?.revision ?? null;
}

function sourceRuntimeCaptureCandidateKey(fingerprint) {
  return `capture-${fingerprint}`;
}

/** The completed product's publisher owns its exact locator. Domains choose
 * their key from their real capture contract, not from retained directories. */
/** `alias` names what a producer proved equal for this key (e.g. another
 * revision with identical inputs); readers verify it against the record. */
export async function publishSourceBundleCandidate({ bundleRoot, candidateKey, outputDir, record, producerCompletedAt, producerCandidateKey, alias }) {
  const candidatePath = sourceBundleCandidatePath({ bundleRoot, candidateKey });
  if (producerCompletedAt) {
    const previous = await readOptionalJson(candidatePath);
    if (previous?.outputName !== basename(outputDir) && /^(?:bundle|runtime|web)-[^\\/\0]+$/.test(previous?.outputName ?? '')) {
      // A legacy current locator also proves a successful producer. Preserve
      // it before the newest pointer advances to an unverified capture.
      const preservedPath = sourceBundleCandidatePath({ bundleRoot, candidateKey: `capture-${previous.outputName}` });
      const legacyTimestamp = previous.producerCompletedAt ? null : await lstat(candidatePath);
      await writeJsonAtomic(preservedPath, {
        ...previous, producerCandidateKey: previous.producerCandidateKey ?? candidateKey,
      });
      if (legacyTimestamp) await utimes(preservedPath, legacyTimestamp.atime, legacyTimestamp.mtime);
    }
  }
  const candidate = {
    outputName: basename(outputDir), inputIdentity: record.inputIdentity, reuseFingerprint: record.reuseFingerprint,
    ...(producerCompletedAt ? { producerCompletedAt, producerCandidateKey } : {}), ...(alias ? { alias } : {}),
  };
  await writeJsonAtomic(candidatePath, candidate);
  if (producerCompletedAt) await writeJsonAtomic(sourceBundleCandidatePath({ bundleRoot,
    candidateKey: `capture-${candidate.outputName}` }), candidate);
}

async function readReusableSourceBundle({ outputDir, record, repoDir, component, serverComponent, dbProvider, sharedSourceInputs, env, newestCompleted = false, sourceCapturedAfter }) {
  if (!record.sourceInputDigests) return null;
  // Opting in requests archives from the producer, including when a consumer
  // adopts a completed revision without comparing the checkout fingerprint.
  if (env.HAPPIER_DEV_GUEST_CLI_EXPORT === '1') {
    const targets = readSourceGuestPayloadTargets(env);
    if (targets?.some(({ target }) => !record.guestPayload?.archives?.some(archive =>
      archive.target.os === target.os && archive.target.arch === target.arch))) return null;
    const imported = readSourceGuestPayloadArchiveImports(env);
    const retained = (record.guestPayload?.archives ?? []).filter(archive => !targets?.some(({ target }) =>
      archive.target.os === target.os && archive.target.arch === target.arch));
    if (imported.length !== retained.length || imported.some(archive => !retained.some(existing =>
      existing.target.os === archive.target.os && existing.target.arch === archive.target.arch && existing.sha256 === archive.sha256))) return null;
  }
  if (component === 'server'
      && (record.serverComponent !== serverComponent || record.dbProvider !== (dbProvider ?? (serverComponent === 'happier-server-light' ? 'sqlite' : 'postgres')))) return null;
  // A capture older than an explicit boundary is adopted only when its consumed inputs are still
  // byte-identical (checked below): identical bytes already satisfy the boundary. A future boundary waits.
  const predatesBoundary = sourceCapturedAfter != null && !(Date.parse(record.sourceCapture?.capturedAt) >= sourceCapturedAfter);
  if (predatesBoundary && sourceCapturedAfter > Date.now()) return null;
  const sharedManifest = await readSharedSourceInputManifest(sharedSourceInputs);
  const sharedFiles = sharedManifest && new Set([...sharedManifest.filesByComponent[component],
    ...(component === 'server' && env.HAPPIER_DEV_GUEST_CLI_EXPORT === '1' ? sharedManifest.filesByComponent.daemon : [])]);
  const dependencyPublication = await readBuildInputDependencies({ sourceDir: repoDir, env });
  if (!sourceRuntimeDependencyIdentityMatches(record.dependencyPublication, dependencyPublication, component)) return null;
  if (newestCompleted && !predatesBoundary) {
    const { reuseFingerprint, sourceInputDigests, inputIdentity, ...built } = record;
    return { outputDir, built: { ...built, dependencyPublication: { ...record.dependencyPublication, ...dependencyPublication } } };
  }
  if (record.inputIdentity !== await sourceBundleFingerprint({ repoDir, component, serverComponent, dbProvider, sharedSourceInputs, env,
    consumedPaths: Object.keys(record.sourceInputDigests) })) return null;
  // A consumed file can change and be undone during preparation. The wide
  // membership fingerprint is only a cache hint; captured load bytes decide
  // whether this emitted graph is reusable for the current source.
  const current = Object.entries(record.sourceInputDigests).every(([path, digest]) => {
    // Installed dependency bytes are outside the authored capture and retain
    // their existing dependency-publication owner and physical location.
    const absolute = resolve(sharedFiles?.has(path) ? sharedSourceInputs.repoDir : repoDir, path);
    return digest && existsSync(absolute)
      && readCachedFileDigestSync(absolute, statSync(absolute, {bigint:true})) === digest;
  });
  if (!current) return null;
  // A freshness boundary only requires a new capture when the authored inputs
  // changed. An older capture with the same current input identity already
  // contains the exact bytes the new capture would read, so rebuilding it
  // would only repeat plugin/UI and author-package work on a daemon reload.
  const {reuseFingerprint, sourceInputDigests, inputIdentity, ...built} = record;
  return {outputDir, built: { ...built,
    dependencyPublication: { ...record.dependencyPublication, ...dependencyPublication } }};
}

export function sourceBundleBuildLockPath(bundleRoot, fingerprint) {
  return join(bundleRoot, `build-${fingerprint}.lock`);
}

export function sourceRuntimeProducerBuildLockPath(stackBaseDir) {
  return sourceBundleBuildLockPath(join(dirname(stackBaseDir), 'source-bundles'), 'producer');
}

/** Runtime connection state never participates in an authored build. Keep the
 * host/tool/dependency environment, and rebase Stack identity to its producer. */
export function resolveSourceRuntimeProducerContext({ repoDir, stackBaseDir, env = process.env }) {
  const authority = resolveRuntimeBuildAuthority({ rootDir: repoDir, consumerStackName: basename(stackBaseDir),
    env: { ...env, HAPPIER_STACK_REPO_DIR: repoDir, HAPPIER_STACK_STORAGE_DIR: dirname(resolve(stackBaseDir)) } });
  const producerEnv = Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(?:DATABASE_URL|DIRECT_URL|HAPPIER_(?:SERVER_|WEBAPP_|PUBLIC_|AUTH_|ACCOUNT_|MACHINE_|HOME_DIR|CLI_HOME_DIR)|HAPPIER_STACK_(?:PORT|SERVER_URL|PUBLIC_URL|WEB_URL|CLI_HOME|STACK_BASE_DIR|EXPO_SOURCE_STACK))/.test(key)));
  Object.assign(producerEnv, { HAPPIER_STACK_REPO_DIR: resolve(repoDir), HAPPIER_STACK_STACK: authority.producerStackName,
    HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: authority.producerStackName,
    HAPPIER_STACK_STORAGE_DIR: dirname(authority.producerStackBaseDir) });
  return { ...authority, env: producerEnv };
}

export async function setBundleReadOnly(directory, readOnly) {
  // Unlocking only prepares a bundle for deletion, so an entry a concurrent producer already removed
  // needs nothing; locking a published bundle still fails closed when an entry vanishes.
  const ignoreRemoved = error => { if (readOnly || error?.code !== 'ENOENT') throw error; };
  let entries;
  try { entries = await readdir(directory, {withFileTypes:true}); } catch (error) { ignoreRemoved(error); return; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue; // Installed dependencies keep their own lifecycle.
    try {
      if (entry.isDirectory()) {
        if (!readOnly) await chmod(path, 0o755);
        await setBundleReadOnly(path, readOnly);
      } else {
        const mode = (await lstat(path)).mode;
        await chmod(path, readOnly ? mode & ~0o222 : mode | 0o200);
      }
    } catch (error) { ignoreRemoved(error); }
  }
  try { await chmod(directory, readOnly ? 0o555 : 0o755); } catch (error) { ignoreRemoved(error); }
}

async function readOptionalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// A Stack runs only while a recorded owner or process is verifiably its own
// live process: the canonical runtime lifecycle owner checks the recorded
// start witness and boot, then the Stack's launch binding. A recycled PID or a
// remote-service flag left in a stale state file proves nothing. Inconclusive
// observation retains.
async function privateSourceStackActive(stackBaseDir, state, pending) {
  if (Number.isSafeInteger(Number(pending?.pid)) && Number(pending.pid) > 1
    && observePidLiveness(pending.pid).status !== 'dead') return true;
  if (!state) return false;
  try {
    return await hasTrustedStackRuntimeLifecycle(state, {
      stackName: String(state.stackName ?? '').trim() || basename(stackBaseDir),
      envPath: join(stackBaseDir, 'env'), cliHomeDir: join(stackBaseDir, 'cli'),
    }, { throwOnInconclusive: true });
  } catch (error) {
    if (error?.code === 'ESTACKRUNTIMEPROCESSINCONCLUSIVE' || error?.code === 'EPROCESSIDENTITYINCONCLUSIVE') return true;
    throw error;
  }
}

function readSourceRetentionRecord(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw Object.assign(new Error('Source retention record unavailable'), { code: 'ERETENTIONRECORD' });
  }
}

async function readSourceRetentionStack(stackBaseDir) {
  const sourceRoot = join(stackBaseDir, 'source-runtime');
  const pending = readSourceRetentionRecord(join(sourceRoot, 'start.pending.json'));
  const state = readSourceRetentionRecord(join(stackBaseDir, 'stack.runtime.json'));
  const active = await privateSourceStackActive(stackBaseDir, state, pending);
  const references = [];
  if (pending && isPidAlive(pending.pid)) references.push(...(pending.preparationDirs ?? []), pending.preparationDir);
  const selections = readSourceSelectionPaths(stackBaseDir);
  // An unsettled reload may still restart the incumbent revision it replaced.
  references.push(...readSourceSelectionRollbackPaths(stackBaseDir));
  if (active && [state?.ownerPid, state?.processes?.daemonPid, ...(state?.processes?.daemonPids ?? [])].some(isPidAlive)) {
    references.push(...sourceRecordReferencePaths(state?.sourceRuntimeLaunch));
  }
  if (active && [state?.ownerPid, state?.processes?.serverPid].some(isPidAlive)) {
    references.push(...sourceRecordReferencePaths(state?.sourceUiLaunch));
  }
  // A Stack's own outputs stay pinned by its selections. A shared bundle stays
  // pinned by a selection only while its Stack runs or prepares, or while a
  // reload's selection awaits activation (owner ruling 2026-11-15, growth
  // fixes): a stopped Stack with no pending selection releases it, and its
  // next start treats a reclaimed selection as absent.
  const pinsSelections = active || pendingSourceSelectionAwaitsActivation(pending);
  return { state, pending, active, references: [...references, ...selections],
    sharedReferences: pinsSelections ? [...references, ...selections] : references };
}

/** The source retention owner observes actual commands, including detached Session hosts.
 * Unavailable observation retains lazy-loadable runtime files. */
export async function readSourceRuntimeProcessCommands() {
  let liveCommands = '';
  try {
    if (process.platform === 'win32') return null; // No authoritative process command observation here.
    if (process.platform === 'linux') {
      for (const pid of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
        try {
          const status = await readFile(`/proc/${pid}/status`, 'utf8');
          const uids = /^Uid:[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)/m.exec(status);
          if (uids && !uids.slice(1).some(uid => Number(uid) === process.getuid())) continue;
          liveCommands += '\n' + await readFile(`/proc/${pid}/cmdline`, 'utf8');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    } else liveCommands = await runCapture('ps', ['-ax', '-o', 'command=']);
  } catch (error) {
    console.error(`[source-runtime] retaining source runtimes: live process observation unavailable (${error.code ?? error.message})`);
    return null;
  }
  return liveCommands;
}

function canonicalSourceReferences(references) {
  return references.filter(Boolean).flatMap(path => {
    try { return [realpathSync(path)]; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  });
}

function privateSourceRecordRetains(directory, records) {
  if (records.active) return true;
  const canonicalDirectory = realpathSync(directory);
  return canonicalSourceReferences(records.references)
    .some(path => path === canonicalDirectory || path.startsWith(canonicalDirectory + sep));
}

function sourceRetentionStat(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function sameSourceRetentionStat(left, right) {
  if (left === null || right === null) return left === right;
  return left.dev === right.dev && left.ino === right.ino && left.mtimeMs === right.mtimeMs;
}

function retireSourceDirectory(directory) {
  if (basename(directory).startsWith('.retired-')) return directory;
  const retiredDirectory = join(dirname(directory), `.retired-${basename(directory)}-${randomUUID()}`);
  renameSync(directory, retiredDirectory);
  return retiredDirectory;
}

async function withSourceBundlePublicationCustody({ bundleRoot, component = 'shared', signal, operation, onTiming }, publish) {
  const started = performance.now();
  let acquired;
  try {
    return await withJsonOwnerFileLock(() => {
      acquired = performance.now();
      return publish();
    }, { lockPath: join(bundleRoot, 'publication.lock'), timeoutMs: Infinity, staleAfterMs: Infinity,
      signal, errorLabel: 'source-bundle publication lock' });
  } finally {
    const finished = performance.now();
    const timing = { acquireMs: (acquired ?? finished) - started,
      holdMs: acquired === undefined ? 0 : finished - acquired };
    if (onTiming) onTiming(timing);
    else console.error(`[source-bundle] phase=${operation}-custody component=${component} acquireMs=${Math.round(timing.acquireMs)} holdMs=${Math.round(timing.holdMs)}`);
  }
}

async function retireSourceCandidates({ stacksRoot, bundleRoot, candidates, dryRun, signal }) {
  const sharedRoots = [];
  if (!candidates.length) return sharedRoots;
  const retired = [];
  await withSourceBundlePublicationCustody({ bundleRoot, signal, operation: 'retirement' }, async () => {
    // Refresh the narrow canonical pin records after expensive qualification.
    // Every publisher/adopter uses this same custody; no await separates a
    // candidate's final pin check from the atomic removal of its reusable name.
    const stacks = new Map();
    for (const entry of readdirSync(stacksRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'source-bundles') continue;
      stacks.set(join(stacksRoot, entry.name), await readSourceRetentionStack(join(stacksRoot, entry.name)));
    }
    const references = canonicalSourceReferences([...stacks.values()].flatMap(stack => stack.sharedReferences));
    for (const candidate of candidates) {
      const info = sourceRetentionStat(candidate.directory);
      const completion = candidate.privateStack ? null : sourceRetentionStat(join(candidate.directory, 'source-bundle.json'));
      const canonicalDirectory = info && realpathSync(candidate.directory);
      const retained = info && (!sameSourceRetentionStat(info, candidate.info)
        || !sameSourceRetentionStat(completion, candidate.completion ?? null)
        || (candidate.fingerprint && isWorkspaceBundleLockActive(sourceBundleBuildLockPath(bundleRoot, candidate.fingerprint), { staleAfterMs: Infinity }))
        || references.some(path => path === canonicalDirectory || path.startsWith(canonicalDirectory + sep))
        || (candidate.privateStack && privateSourceRecordRetains(candidate.directory, stacks.get(candidate.privateStack))));
      if (!info || retained) {
        if (candidate.result) {
          candidate.result.reclaimableRoots--;
          candidate.result.reclaimableBytes -= candidate.bytes;
          if (retained) candidate.result.retainedRoots++;
        }
        continue;
      }
      if (!candidate.result) sharedRoots.push(candidate.directory);
      if (dryRun) continue;
      retired.push({ ...candidate, directory: retireSourceDirectory(candidate.directory) });
    }
  });
  for (const candidate of retired) {
    try {
      removeOwnedDirectorySync(candidate.directory);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (candidate.result) {
      candidate.result.reclaimedRoots++;
      candidate.result.reclaimedBytes += candidate.bytes;
    }
  }
  return sharedRoots;
}

async function retainSourceBundles({ stacksRoot, bundleRoot, newest, dryRun = false, privateStackNames,
  reclaimShared = !privateStackNames, signal }) {
  await mkdir(bundleRoot, { recursive: true });
  const references = [newest];
  const candidates = [];
  const privateWeb = [];
  const newestBuilt = new Map();
  // Completion and selection share publication custody. Allocation names bind
  // unfinished graphs to existing fingerprint custody, so cancellation leaves
  // no new ledger and a later publication can reclaim an abandoned allocation.
  for (const entry of await readdir(bundleRoot, {withFileTypes:true})) {
    if (!entry.isDirectory() || !/^(?:\.retired-)?(?:bundle|runtime|web)-/.test(entry.name)) continue;
    const directory = join(bundleRoot, entry.name);
    const info = sourceRetentionStat(directory);
    if (!info) continue;
    const record = await readOptionalJson(join(directory, 'source-bundle.json'));
    const completion = sourceRetentionStat(join(directory, 'source-bundle.json'));
    const fingerprint = record?.reuseFingerprint
      ?? /^(?:\.retired-)?(?:bundle|runtime|web)-([a-f0-9]{64})-/.exec(entry.name)?.[1];
    if (!record) {
      // Old allocation names cannot prove unfinished-producer custody. A
      // retired name already surrendered that authority before cleanup, which
      // may have removed its completion record before being interrupted.
      if (!fingerprint && !entry.name.startsWith('.retired-')) continue;
      if (fingerprint && isWorkspaceBundleLockActive(sourceBundleBuildLockPath(bundleRoot, fingerprint), {staleAfterMs:Infinity})) continue;
      candidates.push({ directory, info, completion: null, fingerprint });
      continue;
    }
    if (!completion) continue; // Another reclaimer already retired this directory.
    // Completion is immutable; allocation-directory metadata can change
    // independently and must not make an older product the newest fallback.
    const createdMs = completion.mtimeMs;
    const component = record.component ?? (record.cliDir ? 'daemon' : 'server');
    // Interrupted retirement remains ordinary cleanup input, never a reusable
    // product or a replacement for the newest completed fallback.
    // An overlay build is retained by its declaring Stack's selection, never as the newest fallback.
    if (!entry.name.startsWith('.retired-') && !record.sourceCapture?.overlayDigest
      && (!newestBuilt.has(component) || createdMs > newestBuilt.get(component).createdMs)) {
      newestBuilt.set(component, {directory, createdMs});
    }
    if (fingerprint && isWorkspaceBundleLockActive(sourceBundleBuildLockPath(bundleRoot, fingerprint), {staleAfterMs:Infinity})) continue;
    candidates.push({ directory, info, completion, fingerprint });
  }
  references.push(...[...newestBuilt.values()].map(({ directory }) => directory));
  for (const entry of await readdir(stacksRoot, {withFileTypes:true})) {
    if (!entry.isDirectory() || entry.name === 'source-bundles') continue;
    const stackBaseDir = join(stacksRoot, entry.name);
    const sourceRoot = join(stackBaseDir, 'source-runtime');
    const records = await readSourceRetentionStack(stackBaseDir);
    const { active, sharedReferences } = records;
    references.push(...sharedReferences);
    if (existsSync(sourceRoot)) {
      const entries = await readdir(sourceRoot, {withFileTypes:true});
      // Maintenance nominates only its exact private stacks; ordinary
      // publication keeps the existing runtime-bundle retention scope.
      if (!privateStackNames) for (const bundle of entries) {
        if (bundle.isDirectory() && /^(?:\.retired-)?bundle-/.test(bundle.name)) {
          const directory = join(sourceRoot, bundle.name);
          const info = sourceRetentionStat(directory);
          if (!info) continue;
          const completion = sourceRetentionStat(join(directory, 'source-bundle.json'));
          const record = completion && readSourceRetentionRecord(join(directory, 'source-bundle.json'));
          candidates.push({ directory, info, completion, fingerprint: record?.reuseFingerprint });
        }
      }
      if (privateStackNames && !privateStackNames.includes(entry.name)) continue;
      const names = entries.filter(bundle => bundle.isDirectory() && /^(?:\.retired-)?web-/.test(bundle.name)).map(bundle => bundle.name);
      if (!names.length) continue;
      const group = { stack: entry.name, parent: sourceRoot, names, active, records };
      privateWeb.push(group);
      if (active) continue; // Another program's running or preparing Stack is untouched.
      // Legacy private exports have no completion record. Reuse the producer's
      // payload validator; a newer partial output cannot replace last green.
      let lastGreen;
      for (const name of names) {
        if (name.startsWith('.retired-')) continue;
        const payloadDir = join(sourceRoot, name, 'export');
        try {
          await assertWebArtifactPayload({ payloadDir, entrypoint: 'index.html' });
          const completedMs = (await lstat(join(payloadDir, 'index.html'))).mtimeMs;
          if (!lastGreen || completedMs > lastGreen.completedMs) lastGreen = { payloadDir, completedMs };
        }
        catch { continue; }
      }
      if (lastGreen) references.push(lastGreen.payloadDir);
    }
  }
  // A detached daemon may outlive its Stack owner and its recorded launch.
  // Observe the actual command before reclaiming its lazy-loadable JS tree.
  const liveCommands = await readSourceRuntimeProcessCommands();
  if (liveCommands === null) return { observationUnavailable: true, stacks: [] };
  // Serving links and managed storage aliases can name the same retained
  // product differently. Compare their actual filesystem authority before
  // reclamation; missing references no longer retain a reader.
  const canonicalReferences = canonicalSourceReferences(references);
  const isPinned = directory => {
    let canonicalDirectory;
    try { canonicalDirectory = realpathSync(directory); }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    return canonicalReferences.some(path => path === canonicalDirectory || path.startsWith(canonicalDirectory + sep))
      || liveCommands.includes(directory + sep) || liveCommands.includes(canonicalDirectory + sep);
  };
  // Dry-run qualifies shared products exactly like a real run, without retiring them.
  const nominations = (!reclaimShared ? [] : candidates)
    .filter(candidate => !isPinned(candidate.directory));
  const stacks = [];
  for (const group of privateWeb) {
    const candidateNames = group.active ? [] : group.names.filter(name => !isPinned(join(group.parent, name)));
    // Private historical outputs retain the canonical historical age boundary,
    // ownership, descendant/inode, binding and immediate process-reference checks.
    const qualified = [];
    const qualification = reapHistoricalTempRoots(group.parent, '/proc', { candidateNames, dryRun: true,
      retainCandidate: (directory, _references, tree) => {
        if (privateSourceRecordRetains(directory, group.records)) return true;
        qualified.push({ directory, info: tree.info, bytes: tree.bytes, privateStack: dirname(group.parent) });
        return false;
      } });
    const result = { stack: group.stack, roots: group.names.length, protectedRoots: group.names.length - candidateNames.length,
      active: group.active, ...qualification };
    stacks.push(result);
    nominations.push(...qualified.map(candidate => ({ ...candidate, result })));
  }
  const sharedRoots = await retireSourceCandidates({ stacksRoot, bundleRoot, candidates: nominations, dryRun, signal });
  return { observationUnavailable: false, stacks, sharedRoots };
}

/** Explicit private-export maintenance uses exactly the publication owner's
 * nominations and lock. Dry-run never changes output bytes or selections. */
export async function reclaimPrivateSourceWebExports({ stacksRoot, stackNames, dryRun = true, signal }) {
  if (!Array.isArray(stackNames) || stackNames.some(name => typeof name !== 'string' || !name
      || name === '.' || name === '..' || /[\\/\0]/.test(name))) throw new Error('Private retention requires exact Stack names');
  const bundleRoot = join(stacksRoot, 'source-bundles');
  return await retainSourceBundles({ stacksRoot, bundleRoot, dryRun, privateStackNames: stackNames, signal });
}

/** Reuse publication retention without publishing a replacement or nominating
 * any Stack's private outputs. Current selections and live readers stay pinned. */
export async function reclaimSourceBundles({ stacksRoot, dryRun = true, signal }) {
  return await retainSourceBundles({ stacksRoot, bundleRoot: join(stacksRoot, 'source-bundles'),
    dryRun, privateStackNames: [], reclaimShared: true, signal });
}

/** Runtime and finite web products share completion and reclamation custody.
 * The consumer pins/selects the completed product inside this short section;
 * qualification and recursive retirement run after publication release. */
export async function withSourceBundlePublication({ stackBaseDir, outputDir, record, signal, dependencySourceDir, dependencyEnv }, publish) {
  const bundleRoot = join(dirname(stackBaseDir), 'source-bundles');
  let timing = { acquireMs: 0, holdMs: 0 };
  let recordMs = 0;
  let publishMs = 0;
  let retainMs = 0;
  let published = false;
  let failedRetirement;
  try {
    const result = await withSourceBundlePublicationCustody({ bundleRoot, signal,
      component: record?.component, operation: 'publication', onTiming: value => { timing = value; } }, async () => {
      let result;
      try {
        if (record) {
          const recordStarted = performance.now();
          try {
            if (record.dependencyPublication) await assertBuildInputDependencies({ sourceDir: dependencySourceDir,
              env: dependencyEnv, state: record.dependencyPublication });
            await writeJsonAtomic(join(outputDir, 'source-bundle.json'), record);
            await setBundleReadOnly(outputDir, true);
          } finally { recordMs = performance.now() - recordStarted; }
        }
        const publishStarted = performance.now();
        try { result = await publish(); }
        finally { publishMs = performance.now() - publishStarted; }
      } catch (error) {
        // Distinct admission hints can converge on the same captured inputs.
        // Retire a failed new product before releasing publication custody, so
        // another producer cannot adopt it during caller-side error cleanup.
        if (record) {
          try {
            failedRetirement = retireSourceDirectory(outputDir);
          } catch (retirementError) {
            throw new AggregateError([error, retirementError], '[source-bundle] publication and failed-product retirement both failed');
          }
        }
        throw error;
      }
      return result;
    });
    published = true;
    const retainStarted = performance.now();
    try { await retainSourceBundles({ stacksRoot: dirname(stackBaseDir), bundleRoot, newest: outputDir, signal }); }
    catch (error) {
      console.error(`[source-bundle] published graph retained; reclamation failed (${error.code ?? error.message})`);
    }
    finally { retainMs = performance.now() - retainStarted; }
    return result;
  } catch (error) {
    if (failedRetirement) {
      const retainStarted = performance.now();
      try {
        removeOwnedDirectorySync(failedRetirement);
      } catch (retirementError) {
        throw new AggregateError([error, retirementError], '[source-bundle] publication and failed-product retirement both failed');
      } finally { retainMs = performance.now() - retainStarted; }
    }
    throw error;
  } finally {
    console.error(`[source-bundle] phase=publication-custody component=${record?.component ?? 'shared'} acquireMs=${Math.round(timing.acquireMs)} recordMs=${Math.round(recordMs)} publishMs=${Math.round(publishMs)} holdMs=${Math.round(timing.holdMs)} retainMs=${Math.round(retainMs)} status=${published ? 'published' : 'failed'}`);
  }
}

async function readSelectedSourceRuntimeBundle(options) {
  const record = await readSelectedSourceRuntimeRecord(options);
  if (!record) return null;
  const { reuseFingerprint, sourceInputDigests, inputIdentity, ...built } = record;
  return built;
}

function isProtocolSourceInput(path) {
  return /^packages\/protocol\/src\/.*\.(?:[cm]?ts|tsx)$/.test(path) && !/\.d\.[cm]?ts$/.test(path);
}

export async function readSourceRuntimeInputConflict({ stackBaseDir, replacements = {} }) {
  const records = {};
  for (const component of ['server', 'daemon']) {
    records[component] = replacements[component]
      ? await readSourceRuntimeBundleRecord(replacements[component].entrypoint)
      : await readSelectedSourceRuntimeRecord({ stackBaseDir, component, required: false });
  }
  if (!records.server || !records.daemon) return null;
  const serverInputs = records.server.sourceInputDigests;
  const daemonInputs = records.daemon.sourceInputDigests;
  if (!serverInputs || !daemonInputs) return null;
  const conflict = Object.keys(serverInputs).find(path => isProtocolSourceInput(path)
    && Object.hasOwn(daemonInputs, path)
    && (!serverInputs[path] || !daemonInputs[path] || serverInputs[path] !== daemonInputs[path]));
  return conflict ? {
    components: { server: records.server.identity, daemon: records.daemon.identity },
    conflictingInput: conflict,
  } : null;
}

async function assertSelectedSourceRuntimeInputCoherence({ stackBaseDir }) {
  const conflict = await readSourceRuntimeInputConflict({ stackBaseDir });
  if (!conflict) return;
  throw Object.assign(
    new Error(`[source-bundle] selected source server and daemon use conflicting protocol input ${conflict.conflictingInput}; restart with --restart to prepare one coherent Stack runtime`),
    { code: 'source_runtime_input_skew', ...conflict },
  );
}

async function selectCompletedSourceRuntimeBundle({ stackBaseDir, component, built, signal, reuseSelected, pendingRequestId }) {
  const outputDir = resolve(built.runtimeDir, '../..');
  const completed = await readOptionalJson(join(outputDir, 'source-bundle.json'));
  if (completed?.identity !== built.identity || completed?.entrypoint !== built.entrypoint || !existsSync(built.entrypoint)) {
    throw new Error('[source-bundle] cannot select an incomplete source runtime graph');
  }
  signal?.throwIfAborted();
  if (pendingRequestId) {
    await retainPendingSourcePreparation({ stackBaseDir, requestId: pendingRequestId, preparationDir: outputDir, signal });
    return built;
  }
  // The only selection writer, after completion/read-only success. A failed
  // construction, completion rename or selection rename preserves the prior
  // coherent selection; unfinished output remains protected until cleanup.
  // A CLI bootstrap may have started before startup selected its graph.
  // Recheck under publication custody so it cannot replace that selection.
  const selectedBundle = reuseSelected === 'if-available'
    ? await readSelectedSourceRuntimeBundle({ stackBaseDir, component, required: false }) : null;
  if (!selectedBundle) {
    await writeJsonAtomic(join(stackBaseDir, 'source-runtime', `selected-${component}.json`), {entrypoint:built.entrypoint});
  }
  return selectedBundle ?? built;
}

async function probePreparedSourceRuntimeBundle({ built, component, repoDir, env, signal }) {
  if (component !== 'daemon') return;
  await assertSourceRuntimeDependenciesCurrent({ entrypoint: built.entrypoint, record: built, component, env, signal });
  try { await probeCliDistRuntimeImport(built.entrypoint, { cwd: built.cliDir, env, signal, timeoutMs: null }); }
  catch (error) {
    if (signal?.aborted || error?.signal || error?.name === 'AbortError') throw error;
    await assertBuildInputDependencies({ sourceDir: repoDir, env, state: built.dependencyPublication });
    throw error;
  }
}

/** Completed immutable runtime/web products need only the narrow publication
 * owner for metadata reads and their final selected/pending pin. */
export async function adoptReusableSourceBundle({ bundleRoot, candidateKey, publishedCandidate, component, signal, verify, publish }) {
  const candidate = publishedCandidate ?? await readOptionalJson(sourceBundleCandidatePath({ bundleRoot, candidateKey }));
  if (typeof candidate?.outputName !== 'string' || !/^(?:bundle|runtime|web)-[^\\/\0]+$/.test(candidate.outputName)
      || !candidate.inputIdentity || !/^[a-f0-9]{64}$/.test(candidate.reuseFingerprint)) return null;
  const outputDir = join(bundleRoot, candidate.outputName);
  const record = await withSourceBundlePublicationCustody({ bundleRoot, component, signal, operation: 'reuse-read' },
    () => readOptionalJson(join(outputDir, 'source-bundle.json')));
  if (record?.inputIdentity !== candidate.inputIdentity || record?.reuseFingerprint !== candidate.reuseFingerprint) return null;
  const reusable = await verify({ record, outputDir, candidate });
  if (!reusable) return null;
  return await withSourceBundlePublicationCustody({ bundleRoot, component, signal, operation: 'reuse-select' }, async () => {
    const completed = await readOptionalJson(join(outputDir, 'source-bundle.json'));
    if (completed?.inputIdentity !== candidate.inputIdentity || completed?.reuseFingerprint !== candidate.reuseFingerprint) return null;
    return await publish({ ...reusable, record: completed });
  });
}

export function normalizeSourceCapturedAfter(value) {
  if (value == null) return undefined;
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError('[source-bundle] sourceCapturedAfter must be a timestamp');
  return timestamp;
}

export function sourceRuntimeProducerUnavailable(cause, context) {
  const nextAction = cause.nextAction ?? 'Repair repository producer inputs and retry the Stack reload';
  return Object.assign(new Error(`[source-bundle] repository producer ${context.producerStackName} unavailable (${cause.code ?? cause.name}): ${redactFailureDiagnostic(cause.message, context.env)}; ${nextAction}`, { cause }), {
    code: cause.producerFailed || cause.code === 'source_runtime_producer_failed' ? 'source_runtime_producer_failed' : 'source_runtime_producer_unavailable',
    reason: cause.code ?? 'producer_request_failed', phase: 'source-producer',
    retryable: cause.retryable ?? true,
    producerStackName: context.producerStackName, sourceStack: context.producerStackName,
    nextAction,
  });
}

async function readCompletedProducerComponents({ repoDir, stackBaseDir, components, env, signal,
  sourceCapturedAfter, pending, reuseSelected, requireCurrentSource = false, captureFingerprints,
  requireLastGreen = false, revision, sharedSourceInputs, select = true }) {
  const bundleRoot = join(dirname(stackBaseDir), 'source-bundles');
  // A revision selects the exact revision build, or (by default) the latest
  // built revision; content-equal captures go through captureFingerprints.
  const exactRevision = revision && !revision.latest && !captureFingerprints;
  const keys = components.map((component, index) => captureFingerprints
    ? sourceRuntimeCaptureCandidateKey(captureFingerprints[index])
    : exactRevision ? sourceRuntimeRevisionCandidateKey({ repoDir, serverComponent: 'happier-server-light', ...component, revisionKey: revision.key })
      : sourceRuntimeCandidateKey({ repoDir, serverComponent: 'happier-server-light', ...component }));
  const candidateSets = await withSourceBundlePublicationCustody({ bundleRoot, signal, operation: 'producer-read' }, async () => {
    if (requireLastGreen && !revision) {
      const groups = await readGreenSourceRuntimeCandidateGroups({ bundleRoot });
      return groups.filter(group => keys.every(key => group.candidates.has(key)))
        .map(group => keys.map(key => group.candidates.get(key)));
    }
    return [await Promise.all(keys.map(candidateKey => readOptionalJson(sourceBundleCandidatePath({ bundleRoot, candidateKey }))))];
  });
  for (const candidates of candidateSets) {
    if (candidates.some(candidate => !candidate?.reuseFingerprint)) continue;
    const prepared = {};
    const records = {};
    for (const [index, descriptor] of components.entries()) {
      const candidate = candidates[index];
      const record = await withSourceBundlePublicationCustody({ bundleRoot, signal, operation: 'producer-record' },
        () => readPublishedSourceRuntimeRecord({ bundleRoot, candidate }));
      if (!record) break;
      const outputDir = join(bundleRoot, candidate.outputName);
      // A legacy linked product cannot satisfy a pinned capture, even when
      // its authored revision is equal. The producer must materialize it once.
      if (descriptor.component === 'daemon' && (revision || env.HAPPIER_STACK_RUNTIME_MODE === 'source-snapshot')
        && record.runtimeDependencyClosure?.captured !== true) break;
      // Revision builds never adopt a dirty-checkout capture; the latest built
      // revision is never an overlay build.
      if (revision && !captureFingerprints && (exactRevision ? !sameSourceRevision(record.sourceCapture, revision)
        : !record.sourceCapture?.revision || record.sourceCapture.overlayDigest)) break;
      const reusable = await readReusableSourceBundle({ outputDir, record, repoDir, env, serverComponent: 'happier-server-light',
        // Every component, single or paired (Systemic ruling 2026-11-13 12:43Z).
        ...descriptor, sharedSourceInputs, sourceCapturedAfter,
        newestCompleted: revision && !captureFingerprints ? true : !requireCurrentSource });
      if (!reusable) break;
      await probePreparedSourceRuntimeBundle({ built: reusable.built, component: descriptor.component, repoDir, env, signal });
      prepared[descriptor.component] = reusable.built;
      records[descriptor.component] = record;
    }
    if (Object.keys(prepared).length !== components.length) continue;
    if (prepared.server && prepared.daemon && await readSourceRuntimeInputConflict({ stackBaseDir, replacements: prepared })) continue;
    // A completed immutable product needs no producer/fingerprint lease.
    // Publication custody validates completion and pins the chosen product;
    // probes stay outside this short publication section.
    await withSourceBundlePublicationCustody({ bundleRoot, signal, operation: 'producer-adoption' }, async () => {
      if (captureFingerprints) for (const [index, descriptor] of components.entries()) {
        const outputDir = resolve(prepared[descriptor.component].runtimeDir, '../..');
        // A content-equal capture also serves this revision from now on.
        if (revision) await publishSourceBundleCandidate({ bundleRoot, outputDir, record: records[descriptor.component],
          candidateKey: sourceRuntimeRevisionCandidateKey({ repoDir, ...descriptor, revisionKey: revision.key }) });
        if (!revision?.overlayDigest && !records[descriptor.component].sourceCapture?.overlayDigest) await publishSourceBundleCandidate({ bundleRoot, outputDir, record: records[descriptor.component],
          candidateKey: sourceRuntimeCandidateKey({ repoDir, ...descriptor }),
          producerCompletedAt: candidates[index].producerCompletedAt,
          producerCandidateKey: candidates[index].producerCandidateKey });
      }
      if (select) for (const [component, built] of Object.entries(prepared)) prepared[component] = await selectCompletedSourceRuntimeBundle({
        stackBaseDir, component, built, signal, reuseSelected, pendingRequestId: pending?.requestId });
    });
    return prepared;
  }
  return null;
}

// Compiler children can write inherited stdout, including during exit. Keep
// their diagnostics on stderr and use the same result-file boundary as workspace
// package workers so those writes cannot corrupt the finite build result.
async function withSourceRuntimeWorkerResult(run) {
  const directory = await mkdtemp(join(tmpdir(), 'hstack-source-result-'));
  const resultPath = join(directory, 'result.json');
  try {
    await run(resultPath);
    return JSON.parse(await readFile(resultPath, 'utf8'));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** QA adopts completed products. Only this repository producer request enters
 * the compiler owner, under the execution host's shared admission locks. */
export async function prepareSourceRuntimeProducer({ repoDir, stackBaseDir, components, env = process.env,
  signal, sourceCapturedAfter, pending, reuseSelected, requireLastGreen = false, sourceRevision, devStartup = false,
  requestBaseArchive, logger = console, stderrStream = process.stderr }) {
  repoDir = resolve(repoDir);
  stackBaseDir = resolve(stackBaseDir);
  signal ??= pending?.signal;
  sourceCapturedAfter = normalizeSourceCapturedAfter(sourceCapturedAfter);
  components = components.map(component => ({ ...component, serverComponent: component.serverComponent ?? 'happier-server-light',
    ...(component.component === 'daemon' ? { serverComponent: 'happier-server-light', dbProvider: undefined } : {}) }));
  const context = resolveSourceRuntimeProducerContext({ repoDir, stackBaseDir, env });
  const requireCurrentSource = context.consumerStackName === context.producerStackName;
  let revision;
  let revisionArchivePath = null;
  // The producer's own source-dev Stack keeps its live-checkout runtime; a revision it
  // builds for QA consumers is published to the store, never selected into that Stack.
  const select = () => !(requireCurrentSource && revision);
  const adopt = () => readCompletedProducerComponents({ repoDir, stackBaseDir, components, env: context.env,
    signal, sourceCapturedAfter, pending, reuseSelected, requireCurrentSource, requireLastGreen, revision, select: select() });
  const report = prepared => {
    for (const [component, built] of Object.entries(prepared)) logger.error(`[source-bundle] adopted component=${component} producer=${context.producerStackName} rev=${built.sourceCapture?.revision ?? 'checkout'}${built.sourceCapture?.overlayDigest ? `+overlay:${built.sourceCapture.overlayDigest}` : ''} capturedAt=${built.sourceCapture?.capturedAt} inputIdentity=${built.sourceCapture?.inputIdentity}`);
    return prepared;
  };
  try {
    // QA consumers run a committed revision (+ declared overlay). The producer's own
    // development Stack keeps following its live checkout unless a revision is requested.
    revision = sourceRevision || !requireCurrentSource ? await resolveProducerRevision({ repoDir, sourceRevision, env: context.env }) : null;
    if (!revision && !requireCurrentSource) logger.error('[source-bundle] capture source=checkout: no revision descriptor reached this host; other lanes\' uncommitted edits can enter this capture');
    const completed = await adopt();
    const buildsCheckoutServer = !revision && components.some(component => component.component === 'server');
    if (buildsCheckoutServer) {
      // Checkout captures can preflight their live catalog before build admission.
      // Revision captures use the selected server's catalog at migration admission;
      // another lane's untracked checkout migrations do not belong to that runtime.
      await assertSharedDatabaseMigrationsApplied({ serverDir: join(repoDir, 'apps/server'), env });
    }
    if (completed) return report(completed);
    if (requireLastGreen && !revision) throw sourceRuntimeCaptureUnavailable();
    if (!existsSync(join(repoDir, 'package.json'))) throw Object.assign(new Error('producer checkout is unavailable'), { code: 'ENOENT' });
    // A revision needing its own installation on a mirror without Git objects
    // receives its archive from the controller before the finite worker starts.
    revisionArchivePath = revision?.descriptorPath ? await requestRevisionInstallArchive({ repoDir,
      descriptor: await readSourceRevisionDescriptor(revision.descriptorPath), treesRoot: sourceRevisionTreesRoot(context.producerStackBaseDir),
      requestBaseArchive, env: context.env, signal }) : null;
    const startsCheckoutDaemon = !revision && devStartup && components.some(component => component.component === 'daemon');
    const admissionEnv = (buildsCheckoutServer || startsCheckoutDaemon) && requireCurrentSource
      && isRepoStackIdentityName(context.producerStackName)
      ? { ...context.env, HAPPIER_ADMISSION_PREPARES_CLASS: SOURCE_RELOAD_ADMISSION_CLASS }
      : context.env;
    const response = await withSingleTrailingBuildPass({ run: async () => {
      const response = await withSourceRuntimeWorkerResult(async resultPath => {
        const result = await runWorkspaceBuildAdmission({ repoDir,
          launcherPath: fileURLToPath(new URL('../../bin/hstack-exec', import.meta.url)), command: process.execPath,
          args: sourceBuildNodeArgs({ repoDir, scriptPath: fileURLToPath(import.meta.url), args: [JSON.stringify({ repoDir,
            stackBaseDir: context.producerStackBaseDir, consumerStackBaseDir: stackBaseDir, pendingRequestId: pending?.requestId,
            producerComponents: components, sourceCapturedAfter, reuseSelected, requireCurrentSource,
            revision: revision && { ...revision, latest: false }, select: select(), revisionArchivePath, resultPath })] }),
          locks: [{ path: sourceRuntimeProducerBuildLockPath(context.producerStackBaseDir), kind: 'workspace', timeoutMs: null,
            errorLabel: 'source runtime producer lock' }],
          cwd: repoDir, env: admissionEnv, signal, devStartup: true, admissionClass: 'source-bundle', stdio: ['ignore', 'pipe', 'pipe'],
          captureStdout: false, onStdout: chunk => stderrStream.write(chunk),
          onStderr: chunk => stderrStream.write(chunk) });
        if (result.error) throw result.error;
        if (result.status !== 0) {
          const refusal = String(result.stderr).split('\n').map(line => parseSourceReloadRefusalLine(line, context.env))
            .find(refusal => refusal?.code);
          throw Object.assign(new Error(`producer exited with ${result.signal ?? result.status}`),
            { code: 'source_runtime_producer_failed', signal: result.signal, diagnostic: result.stderr, ...refusal, producerFailed: true });
        }
      });
      const failure = readTerminalBuildFailure(response);
      if (failure) throw failure;
      return response;
    } });
    return report(response);
  } catch (cause) {
    if (signal?.aborted) throw cause;
    if (cause instanceof SharedDatabaseMigrationError) throw cause;
    throw sourceRuntimeProducerUnavailable(cause, context);
  } finally {
    if (revisionArchivePath) await rm(revisionArchivePath, { force: true });
  }
}

async function prepareSourceRuntimeProducerInProcess({ repoDir, stackBaseDir, consumerStackBaseDir, pendingRequestId,
  producerComponents: components, sourceCapturedAfter, reuseSelected, requireCurrentSource, revision, select = true, revisionArchivePath, env = process.env, signal }) {
  if (pendingRequestId) await updatePendingSourcePreparationPhase({ stackBaseDir: consumerStackBaseDir,
    requestId: pendingRequestId, phase: 'building',
    ...(components.length === 1 ? { component: components[0].component } : {}), signal });
  const lookup = { repoDir, stackBaseDir: consumerStackBaseDir, components, env, signal, sourceCapturedAfter, reuseSelected,
    revision, select, pending: { requestId: pendingRequestId } };
  const completed = await readCompletedProducerComponents({ ...lookup, requireCurrentSource });
  if (completed) return completed;
  // A checkout capture keys its locks before capture. A revision capture is
  // its own identity: capture first, then match content-equal builds by it.
  const checkoutFingerprints = revision ? null
    : await Promise.all(components.map(component => sourceBundleFingerprint({ repoDir, ...component, env })));
  if (checkoutFingerprints) {
    const historical = await readCompletedProducerComponents({ ...lookup, requireCurrentSource: true, captureFingerprints: checkoutFingerprints });
    if (historical) return historical;
  }
  const bundleRoot = join(dirname(stackBaseDir), 'source-bundles');
  const withBuildLocks = async (fingerprints, build) => {
    const locks = [...new Set(fingerprints)].sort().map(fingerprint => sourceBundleBuildLockPath(bundleRoot, fingerprint));
    const lock = async index => index < locks.length ? await withWorkspaceBundleLock(() => lock(index + 1), {
      lockPath: locks[index], timeoutMs: Infinity, staleAfterMs: Infinity, env, signal, errorLabel: 'source-bundle build lock' }) : await build();
    return await lock(0);
  };
  const buildComponents = async (fingerprints, sharedSourceInputs) => {
    const prepared = {};
    for (const [index, descriptor] of components.entries()) prepared[descriptor.component] = await prepareSharedSourceRuntimeBundle({
      repoDir, stackBaseDir, ...descriptor, fingerprint: fingerprints[index], sharedSourceInputs, env, signal,
    });
    if (sourceCapturedAfter != null && Object.values(prepared).some(built => !(Date.parse(built.sourceCapture?.capturedAt) >= sourceCapturedAfter))) {
      throw sourceRuntimeCaptureUnavailable({
        message: 'Producer capture predates the requested sourceCapturedAfter boundary',
        nextAction: 'Request a fresh capture with a valid --source-after=<ISO timestamp> boundary',
      });
    }
    await withSourceBundlePublicationCustody({ bundleRoot, signal, operation: 'producer-completion' }, async () => {
      const producerCompletedAt = new Date().toISOString();
      for (const descriptor of components) {
        const built = prepared[descriptor.component];
        const outputDir = resolve(built.runtimeDir, '../..');
        const record = await readOptionalJson(join(outputDir, 'source-bundle.json'));
        if (revision) await publishSourceBundleCandidate({ bundleRoot, outputDir, record,
          candidateKey: sourceRuntimeRevisionCandidateKey({ repoDir, ...descriptor, revisionKey: revision.key }) });
        // An overlay build serves only its declaring Stack and identical overlays.
        if (revision?.overlayDigest) continue;
        const producerCandidateKey = sourceRuntimeCandidateKey({ repoDir, ...descriptor });
        await publishSourceBundleCandidate({ bundleRoot, outputDir, record,
          candidateKey: producerCandidateKey, producerCompletedAt, producerCandidateKey });
      }
      if (select) for (const [component, built] of Object.entries(prepared)) prepared[component] = await selectCompletedSourceRuntimeBundle({
        stackBaseDir: consumerStackBaseDir, component, built, signal, reuseSelected, pendingRequestId });
    });
    return prepared;
  };
  const prepare = async () => {
    const sourceRoot = join(stackBaseDir, 'source-runtime');
    await mkdir(sourceRoot, { recursive: true });
    let captureDir;
    let descriptorDir;
    try {
      if (!revision) return await withBuildLocks(checkoutFingerprints, async () => {
        const sharedSourceInputs = components.length > 1
          ? await captureSourceRuntimeSharedInputs({ repoDir, outputDir: captureDir = await mkdtemp(join(sourceRoot, 'shared-inputs-')), env, signal }) : undefined;
        return await buildComponents(checkoutFingerprints, sharedSourceInputs);
      });
      // The controller describes its revision only once a capture needs it.
      const descriptorPath = revision.descriptorPath ?? await writeSourceRevisionDescriptor({ repoDir, identity: revision,
        outputDir: descriptorDir = await mkdtemp(join(sourceRoot, 'revision-')) });
      const sharedSourceInputs = await captureSourceRuntimeSharedInputs({ repoDir, env, signal, treesRoot: sourceRevisionTreesRoot(stackBaseDir), revisionArchivePath,
        outputDir: captureDir = await mkdtemp(join(sourceRoot, 'shared-inputs-')), revision: { descriptorPath } });
      const fingerprints = await Promise.all(components.map(component => sourceBundleFingerprint({ repoDir, ...component, sharedSourceInputs, env })));
      // Digest adoption (94ce557e60c) against the revision's bytes, never the checkout's.
      const historical = await readCompletedProducerComponents({ ...lookup, requireCurrentSource: true, captureFingerprints: fingerprints, sharedSourceInputs });
      if (historical) return historical;
      return await withBuildLocks(fingerprints, () => buildComponents(fingerprints, sharedSourceInputs));
    } finally {
      if (captureDir) removeOwnedDirectorySync(captureDir);
      if (descriptorDir) removeOwnedDirectorySync(descriptorDir);
    }
  };
  return await withSourceCaptureRetry({ repoDir, env, signal }, prepare);
}

/** Build from the execution host's installed source. Stack consumers adopt the
 * newest completed producer result; explicit outputDir is the finite producer
 * boundary used by source-bundle tests and probes. A pending Stack
 * request prepares and retains shared candidates; its activation selects them.
 */
export async function buildSourceRuntimeBundle(options) {
  try {
    if (options.stackBaseDir) return await buildSourceRuntimeBundlePass(options);
    return await withSingleTrailingBuildPass({ run: () => buildSourceRuntimeBundlePass(options) });
  } catch (error) {
    await diagnoseSourceReloadFailure(error, options);
    await recordSourceReloadRefusal({ stackBaseDir: options.stackBaseDir, error, env: options.env });
    throw error;
  }
}

async function buildSourceRuntimeBundlePass(options) {
  // Explicit live-development starts resolve current inputs before launch.
  // Pending QA starts retain their revision and startup admission policy.
  const developmentServerStartup = options.devStartup === true;
  // A pending Stack start/reload is runtime-host startup work, just like dev
  // construction. Select the existing startup admission policy here so every
  // local/remote role shares it; standalone validation keeps capacity admission.
  options = { devStartup: Boolean(options.preparation ?? options.pending), ...options };
  if (options.pending && (!options.stackBaseDir || !options.pending.requestId || options.reuseSelected)) {
    throw new Error('[source-bundle] pending preparation requires a Stack request and current-input lookup');
  }
  // An explicit capture boundary belongs to producer selection, including
  // the controller daemon prepared for a remotely placed source Stack.
  const readLastGreen = Boolean(options.devStartup && options.preparation && !options.pending && !options.reuseSelected
    && options.sourceCapturedAfter == null);
  // Dev startup is a current-source demand for both server and daemon. Retained
  // graphs remain available to pinned QA/recovery consumers through this owner.
  const liveDevStartup = developmentServerStartup && !options.sourceRevision
    && (options.env ?? process.env).HAPPIER_STACK_RUNTIME_MODE !== 'source-snapshot';
  if (liveDevStartup) options = { ...options, reuseSelected: false };
  const selection = liveDevStartup ? false : options.reuseSelected || (readLastGreen ? 'if-available' : false);
  if (options.stackBaseDir && selection) {
    const stackBaseDir = resolve(options.stackBaseDir);
    // Recovery and CLI commands read the pinned graph without consulting
    // moving source inputs or reserving source-build capacity.
    const readSelected = async () => {
      const record = await readSelectedSourceRuntimeRecord({
        stackBaseDir, component: options.component, required: selection !== 'if-available',
      });
      if (!record) return null;
      const { reuseFingerprint, sourceInputDigests, inputIdentity, ...built } = record;
      return built;
    };
    // Read the component pair under the selection owner so a multi-component
    // activation cannot be observed halfway through its atomic publication.
    let selectedBundle = await withSourceBundlePublicationCustody({
      bundleRoot: join(dirname(stackBaseDir), 'source-bundles'), component: options.component,
      signal: options.signal, operation: 'selection-read',
    }, async () => {
      const selected = await readSelected();
      if (options.requireCoherentSelection === true) {
        await assertSelectedSourceRuntimeInputCoherence({ stackBaseDir });
      }
      return selected;
    });
    if (selectedBundle && options.component === 'server'
      && ((options.serverComponent && selectedBundle.serverComponent !== options.serverComponent)
        || (options.dbProvider && selectedBundle.dbProvider !== options.dbProvider))) {
      if (selection !== 'if-available') throw new Error('[source-bundle] selected server configuration does not match the requested server');
      selectedBundle = null;
    }
    if (selectedBundle) {
      if (options.component === 'daemon') {
        // The shared record reader also serves reload/recovery. Refuse only
        // where this request actually consumes the retained executable graph.
        await assertSourceRuntimeDependenciesCurrent({ entrypoint: selectedBundle.entrypoint, record: selectedBundle,
          component: options.component, env: options.env, signal: options.signal });
        await probeCliDistRuntimeImport(selectedBundle.entrypoint,
          { cwd: selectedBundle.cliDir, env: options.env, signal: options.signal, timeoutMs: null });
      }
      if (readLastGreen) {
        const { preparation, ...refreshOptions } = options;
        // Publish a shared candidate while preserving the QA selection. Only
        // its existing explicit reload owner activates replacement bytes.
        void preparation.prepareInBackground(async signal => {
          const preparationSignal = options.signal ? AbortSignal.any([signal, options.signal]) : signal;
          try {
            await prepareSourceComponent({ repoDir: resolve(options.repoDir), target: options.component,
              env: options.env, signal: preparationSignal, logger: options.logger,
              prepare: () => prepareSourceRuntimeProducer({ ...refreshOptions, pending: undefined, signal: preparationSignal,
                reuseSelected: 'if-available',
                components: [{ component: options.component, serverComponent: options.serverComponent, dbProvider: options.dbProvider }] }) });
          } catch (error) {
            if (!preparationSignal.aborted) (options.logger ?? console).error(`[source-bundle] background ${options.component} preparation failed:`, error);
          }
        });
      }
      return developmentServerStartup ? { ...selectedBundle, lastGreen: true } : selectedBundle;
    }
  }
  if (!options.stackBaseDir) return await buildSourceRuntimeBundleOnce(options);
  return (await prepareSourceRuntimeProducer({ ...options, components: [{ component: options.component,
    serverComponent: options.serverComponent, dbProvider: options.dbProvider }] }))[options.component];
}

async function buildSourceRuntimeBundleOnce({ repoDir, outputDir, component, serverComponent = 'happier-server-light', dbProvider,
  env = process.env, signal, devStartup = false, sharedSourceInputs, logger = console, stderrStream = process.stderr }) {
  repoDir = resolve(repoDir);
  outputDir = resolve(outputDir);
  const result = await withSourceRuntimeWorkerResult(resultPath => runSourceBuildCommand({ repoDir, scriptPath: fileURLToPath(import.meta.url),
    args: [JSON.stringify({ repoDir, outputDir, component, serverComponent, dbProvider, sharedSourceInputs, resultPath })],
    env, signal, devStartup, captureStderr: true, captureStdout: false, stdoutStream: stderrStream, stderrStream, admissionClass:'source-bundle' }));
  const failure = readTerminalBuildFailure(result);
  if (failure) throw failure;
  const {sourceInputDigests, inputIdentity, captureFingerprint, ...built} = result;
  try {
    signal?.throwIfAborted();
    const probeStarted = performance.now();
    await probePreparedSourceRuntimeBundle({ built, component, repoDir, env, signal });
    logSourceRuntimePhase(component, 'probe', probeStarted, undefined, logger);
    const publicationStarted = performance.now();
    await assertBuildInputDependencies({ sourceDir: repoDir, env, state: built.dependencyPublication });
    await writeJsonAtomic(join(outputDir, 'source-bundle.json'), {...built, sourceInputDigests, inputIdentity});
    logSourceRuntimePhase(component, 'publication', publicationStarted, undefined, logger);
    return built;
  } catch (error) {
    if (error.code === 'BUILD_INPUTS_CHANGED') removeOwnedDirectorySync(outputDir);
    throw error;
  }
}

async function prepareSharedSourceRuntimeBundle({ repoDir, stackBaseDir, component, serverComponent, dbProvider,
  fingerprint, sharedSourceInputs, env = process.env, signal }) {
  const bundleRoot = join(dirname(stackBaseDir), 'source-bundles');
  const inputs = { repoDir, component, serverComponent, dbProvider, sharedSourceInputs };
  // The selected graph already has Stack retention. Borrow its inventory only
  // as a candidate; the canonical UI owner revalidates and materializes bytes
  // into this replacement, never leaving a link to the incumbent's output.
  const incumbent = component === 'daemon' ? await withSourceBundlePublicationCustody({ bundleRoot, component, signal,
    operation: 'selection-read' }, () => readSelectedSourceRuntimeBundle({ stackBaseDir, component, required: false })) : null;
  const retainedPluginUiInventoryPath = incumbent && join(incumbent.runtimeDir, 'plugin-ui-inventory.js');
  await mkdir(bundleRoot, {recursive:true});
  // This allocation is not a claim about checkout bytes. The existing
  // emitted-code identity below describes what this finite build produced.
  // Typed allocation kinds stay in the same store. Already-loaded legacy
  // retainers do not nominate these newly deferred shared candidates.
  const outputDir = await mkdtemp(join(bundleRoot, `runtime-${fingerprint}-`));
  try {
    // This worker inherits dependency custody and owns fingerprint custody and compiler admission.
    // There is no second launch/admission for the same finite graph.
    const {sourceInputDigests, inputIdentity, captureFingerprint, ...built} = await buildSourceRuntimeBundleInProcess({...inputs, outputDir, retainedPluginUiInventoryPath, retainedRuntime: incumbent, env, signal});
    signal?.throwIfAborted();
    const probeStarted = performance.now();
    await probePreparedSourceRuntimeBundle({ built, component, repoDir, env, signal });
    logSourceRuntimePhase(component, 'probe', probeStarted);
    const publicationStarted = performance.now();
    const record = {...built, sourceInputDigests, inputIdentity, reuseFingerprint:fingerprint};
    const published = await withSourceBundlePublication({ stackBaseDir, outputDir, record, signal,
      dependencySourceDir: repoDir, dependencyEnv: env }, async () => {
      await publishSourceBundleCandidate({ bundleRoot, outputDir, record, candidateKey: sourceRuntimeCaptureCandidateKey(captureFingerprint) });
      return built;
    });
    logSourceRuntimePhase(component, 'publication', publicationStarted);
    return published;
  } catch (error) {
    if (existsSync(outputDir)) { removeOwnedDirectorySync(outputDir); }
    throw error;
  }
}

/** The source selection owner admits a complete replacement, without claiming
 * that its processes have loaded it. Preparation never writes these pointers.
 * A null UI selection clears the previous export on activation. Omit it to keep that selection.
 */
export async function admitSourceRuntimeReload({ stackBaseDir, components, ui, pending, env = process.env, logger = console }) {
  pending.signal.throwIfAborted();
  if (components.daemon) {
    const started = performance.now();
    try {
      const incumbent = await readSelectedSourceRuntimeRecord({ stackBaseDir, component: 'daemon', required: false });
      await assertSourceReloadBundledPluginFailures({ replacementCliDir: components.daemon.runtimeDir, incumbentCliDir: incumbent?.runtimeDir });
      await assertSourceRuntimeDependenciesCurrent({ entrypoint: components.daemon.entrypoint, env, signal: pending.signal });
      await probeCliDistRuntimeImport(components.daemon.entrypoint,
        { cwd: components.daemon.cliDir, env, signal: pending.signal, timeoutMs: null });
    } catch (error) {
      await diagnoseSourceReloadFailure(error, { component: 'daemon', repoDir: env.HAPPIER_STACK_REPO_DIR, env, signal: pending.signal });
      throw error;
    } finally {
      logSourceRuntimePhase('daemon', 'replacement-loader', started, undefined, logger);
    }
  }
  if (components.server || ui) {
    const started = performance.now();
    try {
      // Replacement health smoke is service lifecycle; finite builders own admission.
      const repoDir = env.HAPPIER_STACK_REPO_DIR;
      await run(process.execPath, sourceBuildNodeArgs({ repoDir,
        scriptPath: fileURLToPath(new URL('../runtime/launch/smokeSourceRuntimeReload.mjs', import.meta.url)),
        args: [JSON.stringify({ components, ui })] }),
      { cwd: repoDir, env, signal: pending.signal, ownedProcessGroup: true, captureFailureDiagnostic: true });
    } catch (error) {
      await diagnoseSourceReloadFailure(error, { component: 'server', repoDir: env.HAPPIER_STACK_REPO_DIR, env, signal: pending.signal });
      throw error;
    } finally {
      logSourceRuntimePhase('server', 'replacement-smoke', started, undefined, logger);
    }
  }
  const sourceRoot = join(stackBaseDir, 'source-runtime');
  return { activate: () => pending.publishSelection(() => withSourceBundlePublicationCustody({
    bundleRoot: join(dirname(stackBaseDir), 'source-bundles'), signal: pending.signal, operation: 'activation',
  }, async () => {
    const previous = new Map();
    try {
      for (const [component, built] of Object.entries(components)) {
        const record = await readOptionalJson(join(resolve(built.runtimeDir, '../..'), 'source-bundle.json'));
        if (record?.identity !== built.identity || record?.entrypoint !== built.entrypoint || !existsSync(built.entrypoint)) {
          throw Object.assign(new Error(`[source-bundle] cannot select an incomplete ${component} reload graph`),
            { code: 'source_bundle_unavailable', component, entryGraph: component, phase: 'activation', retryable: false });
        }
      }
      const selections = { ...Object.fromEntries(Object.entries(components).map(([component, built]) => [component, { entrypoint: built.entrypoint }])),
        ...(ui === undefined ? {} : { ui }) };
      for (const [component, selection] of Object.entries(selections)) {
        const path = join(sourceRoot, `selected-${component}.json`);
        previous.set(path, await readOptionalJson(path));
        if (selection === null) await rm(path, { force: true });
        else await writeJsonAtomic(path, selection);
      }
    } catch (error) {
      for (const [path, selection] of previous) {
        if (selection) await writeJsonAtomic(path, selection);
        else await rm(path, { force: true });
      }
      throw error;
    }
  })) };
}

async function buildSourceRuntimeBundleInProcess({ repoDir, outputDir, component, serverComponent, dbProvider, retainedPluginUiInventoryPath, retainedRuntime, sharedSourceInputs, env = process.env, signal }) {
  if (component === 'server' && !sharedSourceInputs) {
    const { ensureServerGeneratedProviderOutputs } = await import('../utils/proc/pm.mjs');
    // A queued standalone build checks readiness at its actual capture point.
    // A shared capture already owns matching provider outputs for both roles.
    await ensureServerGeneratedProviderOutputs(join(repoDir, 'apps/server'), repoDir, { env, quiet: true, signal });
  }
  let ownsOutput = false;
  try {
    return await withBuildInputDependencies({ sourceDir: repoDir, env, signal }, async (env, publication) => ({
      ...await consumeSourceRuntimeBuildInputs({ repoDir, outputDir, component, serverComponent, dbProvider,
        retainedPluginUiInventoryPath, retainedRuntime, sharedSourceInputs, env, signal, onOutputReady: () => { ownsOutput = true; } }),
      dependencyPublication: { ...publication.state,
        markerPath: resolveDependencyRefreshMarkerPath(resolveDependencyInstallRoot(repoDir)),
        generationPath: `${resolveDependencyRefreshLockPath(resolveDependencyInstallRoot(repoDir), env)}.generation`,
      },
    }));
  } catch (error) {
    if (ownsOutput && error.code === 'BUILD_INPUTS_CHANGED') removeOwnedDirectorySync(resolve(outputDir));
    throw error;
  }
}

async function consumeSourceRuntimeBuildInputs({ repoDir, outputDir, component, serverComponent, dbProvider, retainedPluginUiInventoryPath, retainedRuntime, sharedSourceInputs, env, signal, onOutputReady }) {
  if (component !== 'daemon' && component !== 'server') throw new Error(`Unsupported source runtime component: ${component}`);
  repoDir = resolve(repoDir);
  outputDir = resolve(outputDir);
  await mkdir(outputDir, { recursive: true });
  if ((await readdir(outputDir)).length > 0) throw new Error(`Source runtime output directory must be empty: ${outputDir}`);
  onOutputReady();
  const sourceRepoDir = repoDir;
  const exportGuestPayload = env.HAPPIER_DEV_GUEST_CLI_EXPORT === '1';
  const guestPayloadTargets = component === 'daemon' || component === 'server' && exportGuestPayload ? readSourceGuestPayloadTargets(env) : null;
  const captured = await captureSourceWebBuildInputs({ repoDir, component, outputDir: join(outputDir, 'workspace'), signal, sharedSourceInputs,
    includeGuestPayload: exportGuestPayload });
  const sourceCapture = { inputIdentity: captured.inputIdentity, capturedAt: captured.capturedAt,
    ...(captured.revision ? { revision: captured.revision.revision, overlayDigest: captured.revision.overlayDigest } : {}) };
  repoDir = captured.repoDir;
  // Installed packages come from here; sourceRepoDir stays the checkout identity.
  const dependencyRootDir = captured.dependencyRootDir ?? sourceRepoDir;
  const projectDir = join(repoDir, 'apps', component === 'daemon' ? 'cli' : 'server');
  const runtimeDir = join(outputDir, 'apps', component === 'daemon' ? 'cli' : 'server');
  await mkdir(runtimeDir, { recursive: true });
  const manifest = JSON.parse(await readFile(join(projectDir, 'package.json'), 'utf8'));
  const requireFromProject = createRequire(pathToFileURL(join(projectDir, 'package.json')));
  const esbuild = requireFromProject('esbuild');
  // Each admitted worker owns exactly one build. Retire its native service
  // before returning the result to the long-lived caller.
  const interrupt = () => { esbuild.stop(); process.exit(130); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const built = await emitSourceRuntimeBundle({ repoDir, sourceRepoDir, dependencyRootDir, capturedFiles: captured.files, guestPayloadTargets,
      captureDependencies: Boolean(captured.revision) || env.HAPPIER_STACK_RUNTIME_MODE === 'source-snapshot',
      outputDir, component, serverComponent, dbProvider, retainedPluginUiInventoryPath, retainedRuntime, projectDir, runtimeDir, manifest, requireFromProject, esbuild, env, signal });
    if (guestPayloadTargets) {
      built.guestPayload = await buildSourceGuestPayload({ repoDir, sourceRepoDir, outputDir,
        ...(captured.dependencyRootDir ? { dependencyRootDir } : {}),
        targets: guestPayloadTargets, sourceCapture, env, signal });
      built.env = { ...built.env, ...sourceGuestPayloadEnvironment(built.guestPayload) };
    }
    const identityStarted = performance.now();
    const inputIdentity = await sourceBundleFingerprint({ repoDir, identityRepoDir: sourceRepoDir,
      component, serverComponent, dbProvider, consumedPaths: Object.keys(built.sourceInputDigests), sharedSourceInputs, env });
    const captureFingerprint = await sourceBundleFingerprint({ repoDir, identityRepoDir: sourceRepoDir,
      component, serverComponent, dbProvider, sharedSourceInputs, env });
    logSourceRuntimePhase(component, 'input-identity', identityStarted);
    return { ...built, inputIdentity, captureFingerprint,
      // Retains a revision's own installation while this graph links into it.
      ...(captured.dependencyRootDir ? { dependencyRootDir } : {}),
      sourceCapture, ...(component === 'server'
      ? { serverComponent, dbProvider: dbProvider ?? (serverComponent === 'happier-server-light' ? 'sqlite' : 'postgres') } : {}) };
  } catch (error) {
    throw rememberSourceCaptureFailure(error, captured);
  } finally {
    removeOwnedDirectorySync(repoDir);
    esbuild.stop();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

// Private finite worker: callers use the public function above so every source
// build goes through the existing host admission owner before graph construction.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log = (...values) => console.error(...values);
  let options;
  try {
    options = JSON.parse(process.argv[2]);
    let result;
    if (options.stackBaseDir) {
      // Preserve cancellation during fingerprint observation/publication;
      // graph construction also retires its own native esbuild service.
      const cancellation = new AbortController();
      const interrupt = () => cancellation.abort();
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', interrupt);
      try {
        if (options.producerComponents) {
          result = await prepareSourceRuntimeProducerInProcess({ ...options, signal: cancellation.signal });
        } else {
          // A queued pre-cutover launcher retains the former component request
          // and fingerprint lease. Translate at this boundary; the admission
          // owner unwinds inherited custody on contention instead of inverting
          // the new host-wide producer lock order.
          const prepared = await prepareSourceRuntimeProducer({ ...options, env: process.env,
            components: [{ component: options.component, serverComponent: options.serverComponent, dbProvider: options.dbProvider }],
            pending: options.pendingRequestId ? { requestId: options.pendingRequestId } : undefined,
            signal: cancellation.signal });
          result = prepared[options.component];
        }
      } finally {
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', interrupt);
      }
    } else result = await withSourceCaptureRetry({ ...options, env: process.env,
      beforeRetry: () => removeOwnedDirectorySync(resolve(options.outputDir)) },
      () => buildSourceRuntimeBundleInProcess(options));
    if (options.resultPath) await writeFile(options.resultPath, JSON.stringify(result));
    else process.stdout.write(JSON.stringify(result)); // Already queued pre-cutover workers.
  } catch (error) {
    await diagnoseSourceReloadFailure(error, { ...options, env: process.env });
    if (options?.producerComponents) Object.assign(error, { sourceStack: process.env.HAPPIER_STACK_STACK,
      phase: error.phase ?? 'source-producer', retryable: error.retryable ?? true,
      code: error.code ?? 'source_runtime_producer_failed' });
    const failure = serializeTerminalBuildFailure(error, { includeRetryableDrift: true });
    // A retryable worker result is not a terminal reload refusal. The shared
    // convergence owner settles its trailing pass before the caller reports it.
    if (!failure || isTerminalBuildFailure(error)) emitSourceReloadRefusal(error);
    if (failure) {
      if (options?.resultPath) await writeFile(options.resultPath, JSON.stringify(failure));
      else process.stdout.write(JSON.stringify(failure));
    }
    else if (error?.name === 'AbortError') process.exitCode = 130;
    else {
      console.error(error);
      process.exitCode = 1;
    }
  }
}

async function emitSourceRuntimeBundle({ repoDir, sourceRepoDir, dependencyRootDir = sourceRepoDir, capturedFiles, guestPayloadTargets, captureDependencies, outputDir, component, serverComponent, dbProvider, retainedPluginUiInventoryPath, retainedRuntime,
  projectDir, runtimeDir, manifest, requireFromProject, esbuild, env, signal }) {
  let phaseStarted = performance.now();
  let activePhase = 'input-digests';
  const phase = (name, next) => {
    logSourceRuntimePhase(component, name, phaseStarted);
    phaseStarted = performance.now();
    activePhase = next;
  };
  try {
  const { transform } = esbuild;
  const sourceInputDigests = {};
  // Include separately compiled Plugin UI/collection migrations, compiler
  // tooling and copied resources from this same view. Main-code neighbours
  // participate only when the real loader consumes them; membership still
  // invalidates additions/deletions that can alter resolution.
  // The full guest payload owns additional code beyond the daemon entry graph.
  for (const path of capturedFiles.filter(path => guestPayloadTargets || !isCompilerTracedSource(path))) {
    const absolute = join(repoDir, path);
    if ((await lstat(absolute)).isFile()) sourceInputDigests[path] = createHash('sha256').update(await readFile(absolute)).digest('hex');
  }
  const readSourceInput = async path => {
    const contents = await readFile(path);
    const capturedKey = relative(repoDir, path);
    const key = (capturedKey.startsWith('..' + sep) ? relative(sourceRepoDir, path) : capturedKey).split(sep).join('/');
    const digest = createHash('sha256').update(contents).digest('hex');
    const previous = sourceInputDigests[key];
    sourceInputDigests[key] = previous === undefined || previous === digest ? digest : null;
    return contents;
  };
  const captureInputs = {name:'source-runtime-consumed-inputs', setup(builder) {
    builder.onLoad({filter:/.*/, namespace:'file'}, async ({path}) => ({
      contents:await readSourceInput(path), loader:'default', resolveDir:dirname(path),
    }));
  }};
  // Capture the bytes actually returned to esbuild, including sidecar graphs.
  // Its metafile inventories paths/byte counts, not the consumed content digest.
  // Linked external maps retain the captured TypeScript in sourcesContent.
  // Metafile outputs include them in the same retained code/identity inventory.
  // Native preparation helpers consume the same captured source exports as
  // the main graph; captured workspaces need no installed dist products.
  const build = options => esbuild.build({...options, conditions:[SOURCE_CONDITION], sourcemap:'linked', sourcesContent:true,
    plugins:[...(options.plugins ?? []), captureInputs]});
  const workspacePackages = await readWorkspacePackages(repoDir);
  phase('input-digests', 'entry-preparation');
  const entries = {};
  let migrationSource;
  let sqliteMigration = false;
  const pluginMetadata = [];
  const daemonProjectionRoot = join(repoDir, '.source-daemon-projections');
  let derivesDaemonProjections = false;
  const outputPrefix = component === 'daemon' ? 'apps/cli' : 'apps/server';
  if (component === 'daemon') {
    const generatorPath = join(projectDir, 'scripts/build-owned/generateBundledPluginEntries.ts');
    derivesDaemonProjections = existsSync(generatorPath) || existsSync(join(repoDir, 'packages/plugins'));
    if (derivesDaemonProjections) {
      // Derive the locator/declaration closure from these captured inputs.
      // Committed projections remain the package/CI checker's responsibility.
      await run(process.execPath, sourceBuildNodeArgs({ repoDir, scriptPath: generatorPath,
        args: ['--daemon-projections', '--daemon-output-root', daemonProjectionRoot] }), {
        cwd: repoDir, env, signal, stdio: ['ignore', 'ignore', 'inherit'], captureFailureDiagnostic: true,
      });
      await lstat(join(daemonProjectionRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts'));
    }
    const cli = await readCliSourceEntries({repoDir, manifest, transform,
      projectionRoot: derivesDaemonProjections ? daemonProjectionRoot : repoDir});
    Object.assign(entries, cli.entries);
    pluginMetadata.push(...cli.pluginMetadata.map(item => ({...item, dir:join(outputDir,item.prefix)})));
  } else {
    if (serverComponent !== 'happier-server-light' && serverComponent !== 'happier-server') throw new Error(`Unsupported server component: ${serverComponent}`);
    entries[`${outputPrefix}/sources/main`] = join(projectDir, 'sources', serverComponent === 'happier-server-light' ? 'main.light.ts' : 'main.ts');
    const provider = dbProvider ?? (serverComponent === 'happier-server-light' ? 'sqlite' : 'postgres');
    const migrationScript = { postgres: 'full', mysql: 'mysql', pglite: 'light' }[provider];
    if (migrationScript) {
      migrationSource = join(projectDir, 'scripts', `migrate.${migrationScript}.deploy.ts`);
      entries[`${outputPrefix}/scripts/migrate`] = migrationSource;
    } else if (provider === 'sqlite') {
      sqliteMigration = true;
      entries[`${outputPrefix}/scripts/migrate`] = 'source-runtime:sqlite-migration';
    } else if (provider !== 'sqlite') throw new Error(`Unsupported source database provider: ${provider}`);
  }
  phase('entry-preparation', 'esbuild-main');
  let irohPackageRoot;
  let irohInputDigest;
  const plugin = {
    name: 'source-runtime-boundaries',
    setup(builder) {
      if (component === 'server') builder.onLoad({ filter: /publicProfileFonts\.ts$/ }, async args => {
        if (args.path !== join(projectDir, 'sources/app/account/profile/render/publicProfileFonts.ts')) return;
        // This physical asset reader belongs to the retained server package,
        // regardless of the main/shared chunk esbuild places its code in.
        return { contents: (await readSourceInput(args.path)).toString('utf8').replaceAll('import.meta.url',
          JSON.stringify(pathToFileURL(join(runtimeDir, 'package.json')).href)), loader: 'ts', resolveDir: dirname(args.path) };
      });
      if (sqliteMigration) {
        builder.onResolve({ filter: /^source-runtime:sqlite-migration$/ }, () => ({ path: 'sqlite-migration', namespace: 'source-runtime' }));
        builder.onLoad({ filter: /.*/, namespace: 'source-runtime' }, () => ({
          contents: `import {runSqliteMigrationDeploy} from ${JSON.stringify(join(projectDir, 'scripts/migrate.sqlite.deploy.ts'))};\nawait runSqliteMigrationDeploy({serverRoot:${JSON.stringify(runtimeDir)},runSchemaSync:async()=>{}});\n`,
          loader: 'js', resolveDir: projectDir,
        }));
      }
      if (migrationSource) builder.onLoad({ filter: /migrate\.(?:full|mysql|light)\.deploy\.ts$/ }, async (args) => {
        if (args.path !== migrationSource) return;
        return {
          contents: (await readSourceInput(args.path)).toString('utf8').replaceAll('import.meta.url', JSON.stringify(pathToFileURL(join(runtimeDir, 'scripts/migrate.mjs')).href)),
          loader: 'ts', resolveDir: dirname(args.path),
        };
      });
      builder.onResolve({ filter: /generated\/(?:sqlite|mysql)-client/ }, (args) => {
        const capturedPath = resolve(args.resolveDir, args.path);
        const generatedPath = relative(join(projectDir, 'generated'), capturedPath);
        if (component === 'server' && !isAbsolute(generatedPath) && generatedPath !== '..'
          && !generatedPath.startsWith(`..${sep}`)) {
          // Static and dynamic imports share the retained server's generated
          // support root, never the finite input view or its original locator.
          return { path: join(runtimeDir, 'generated', generatedPath), external: true };
        }
        const inputPath = relative(repoDir, capturedPath);
        return { path: !isAbsolute(inputPath) && inputPath !== '..' && !inputPath.startsWith(`..${sep}`)
          ? join(sourceRepoDir, inputPath) : capturedPath, external: true };
      });
      builder.onLoad({ filter: /iroh-native[\\/]src[\\/]nodeNative\.ts$/ }, async (args) => {
        irohPackageRoot = join(runtimeDir, 'iroh-native');
        return {
          contents: (await readSourceInput(args.path)).toString('utf8').replaceAll('import.meta.url',
            JSON.stringify(pathToFileURL(join(irohPackageRoot, 'src/nodeNative.ts')).href)),
          loader: 'ts', resolveDir: dirname(args.path),
        };
      });
    },
  };
  const result = await build({
    absWorkingDir: repoDir, entryPoints: entries, outdir: outputDir,
    bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node20',
    ...SOURCE_RUNTIME_OUTPUT_OPTIONS,
    tsconfig: join(projectDir, 'tsconfig.json'),
    chunkNames: `${outputPrefix}/src/chunks/[name]-[hash]`,
    banner: { js: SOURCE_RUNTIME_COMMONJS_BANNER },
    define: { ...SOURCE_RUNTIME_COMMONJS_DEFINE,
      ...(component === 'server' ? { __HAPPIER_GUEST_CLI_SOURCE__: JSON.stringify(env.HAPPIER_BUILD_GUEST_CLI_SOURCE ?? 'home-payload'),
        __HAPPIER_GUEST_CLI_CHANNEL__: JSON.stringify(env.HAPPIER_BUILD_GUEST_CLI_CHANNEL ?? 'publicdev'),
        __HAPPIER_DEV_GUEST_CLI_EXPORT_AVAILABLE__: JSON.stringify((env.HAPPIER_BUILD_GUEST_CLI_SOURCE ?? 'home-payload') === 'home-payload') } : {}) },
    metafile: true, logLevel: 'silent', plugins: [
      ...(derivesDaemonProjections ? [createCliSourceProjectionResolver({projectionRoot: daemonProjectionRoot})] : []),
      plugin, createWorkspaceSourceResolver({workspacePackages, requireFromProject}),
    ],
  });
  const emittedFiles = Object.keys(result.metafile.outputs).map(file => resolve(repoDir, file));
  await stripUnusedSourceRuntimeBanners(emittedFiles);
  await dropRedundantSourceRuntimeChunkImports(emittedFiles);
  phase('esbuild-main', 'plugin-resources');
  const runtimeManifest = component === 'daemon' ? {
    ...manifest, type: 'module', main: './src/index.mjs', module: './src/index.mjs',
    exports: Object.fromEntries(Object.keys(manifest.exports ?? {}).map((key) => [
      key, `./package-dist/${key === '.' ? 'index' : key.slice(2)}.mjs`,
    ])),
    imports: Object.fromEntries(Object.entries(manifest.imports ?? {}).map(([key, value]) => [
      key, `./package-dist/${sourceExport(value, key).slice('./src/'.length).replace(/\.[^.]+$/, '')}.mjs`,
    ])),
  } : { ...manifest, type: 'module' };
  await writeFile(join(runtimeDir, 'package.json'), JSON.stringify(runtimeManifest));
  const retainedCodeFiles = Object.keys(result.metafile.outputs).map((file) => resolve(repoDir, file));
  for (const item of pluginMetadata) {
    await mkdir(join(item.dir, '.happier-plugin'), { recursive: true });
    await writeFile(join(item.dir, 'package.json'), JSON.stringify({...item.package,exports:runtimePackageExports(item.package.exports)}));
    await writeFile(join(item.dir, '.happier-plugin/plugin.json'), JSON.stringify(item.manifest));
    // Use the same manifest-path owner as packaged workspaces. Resources are
    // retained code inputs, not links back to the moving checkout.
    for (const relativePath of readBundledPluginPackageResourceRelativePaths(item.dir)) {
      const destination = join(item.dir, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, await readSourceInput(join(item.sourceDir, relativePath)));
      retainedCodeFiles.push(destination);
    }
  }
  phase('plugin-resources', 'plugin-ui');
  if (pluginMetadata.some(item => item.manifest.contributes !== undefined)) {
    const preparationDir = await mkdtemp(join(runtimeDir, '.source-plugin-ui-'));
    const inventoryPath = join(runtimeDir, 'plugin-ui-inventory.js');
    try {
      // The same source compiler used by native CLI construction owns these
      // graphs. Checkout dist can be republished while this daemon is serving.
      await run(process.execPath, ['--conditions=happier-source', '--import',
        join(repoDir, 'packages/cli-common/registerSourceRuntime.mjs'),
        join(repoDir, 'apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs')], {
        cwd: repoDir, env, signal, stdio: ['ignore', 'ignore', 'inherit'], captureFailureDiagnostic: true,
        input: JSON.stringify({
          repoRoot: repoDir, outputDir: preparationDir, outputPath: inventoryPath,
          retainedInventoryPath: retainedPluginUiInventoryPath ?? inventoryPath,
          plugins: pluginMetadata.map(item => ({
            directory: item.package.name.slice('@happier-dev/plugins-'.length), manifest: item.manifest,
          })),
          artifactOutputDirs: Object.fromEntries(pluginMetadata.map(item => [
            item.package.name.slice('@happier-dev/plugins-'.length), join(item.dir, 'dist/happier-plugin-ui'),
          ])),
        }),
      });
      retainedCodeFiles.push(inventoryPath);
      const collect = async directory => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await collect(path);
          else retainedCodeFiles.push(path);
        }
      };
      for (const item of pluginMetadata) await collect(join(item.dir, 'dist/happier-plugin-ui'));
    } finally {
      removeOwnedDirectorySync(preparationDir);
    }
  }
  phase('plugin-ui', component === 'daemon' ? 'runtime-dependencies' : 'runtime-resources');
  for (const key of Object.keys(entries).filter((key) => key.startsWith(`${outputPrefix}/`))) {
    const target = join(outputDir, `${key}.mjs`);
    await writeFile(target, `export * from './${key.split('/').at(-1)}.js';\n`);
    retainedCodeFiles.push(target);
  }
  const installedProjectDir = join(dependencyRootDir, 'apps', component === 'daemon' ? 'cli' : 'server');
  if (component === 'server') {
    // Keep the generated clients and the @prisma/client wrapper that loads the
    // default one with this graph after the temporary input capture is retired.
    // They sit where the server's install layout has them (apps/server).
    // A capture-owned Prisma layout (older revisions) adds its client package and
    // clients, which sit where that layout put them (the root node_modules).
    const clientRoots = readRevisionServerClientRoots(repoDir);
    for (const path of capturedFiles.filter(path => isSourceServerGeneratedInput(path)
      || clientRoots.some(root => path.startsWith(`${root}/`)))) {
      const target = join(outputDir, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readSourceInput(join(repoDir, path)));
      await chmod(target, (await lstat(join(repoDir, path))).mode & 0o777);
      retainedCodeFiles.push(target);
    }
    await mountInstalledNodeModules({ sourceModules: join(dependencyRootDir, 'node_modules'), targetModules: join(outputDir, 'node_modules') });
    // The captured clients stay physical; the mount fills the rest of each scope.
    await mountInstalledNodeModules({ sourceModules: join(installedProjectDir, 'node_modules'),
      targetModules: join(runtimeDir, 'node_modules') });
  } else if (!captureDependencies) {
    await linkInstalledDirectory(join(dependencyRootDir, 'node_modules'), join(outputDir, 'node_modules'));
    await linkInstalledDirectory(join(installedProjectDir, 'node_modules'), join(runtimeDir, 'node_modules'));
    // Plugin entries live outside apps/cli, but externalize against that same
    // host. Preserve its Node lookup chain before the checkout-root fallback.
    await linkInstalledDirectory(join(installedProjectDir, 'node_modules'), join(outputDir, 'packages/node_modules'));
  }
  if (irohPackageRoot) {
    const started = performance.now();
    const packagePath = 'packages/iroh-native';
    const nativeInputs = Object.entries(sourceInputDigests).filter(([path]) =>
      path.startsWith(`${packagePath}/rust/`) || path === `${packagePath}/rust-toolchain.toml`
        || path === `${packagePath}/scripts/build-node-addon.mjs`
        || path === `${packagePath}/scripts/ensure-rust-toolchain.mjs`).sort(([a], [b]) => a.localeCompare(b));
    irohInputDigest = createHash('sha256').update(JSON.stringify([process.platform, process.arch, nativeInputs])).digest('hex');
    const { buildNodeAddon } = await import(pathToFileURL(join(repoDir, packagePath, 'scripts/build-node-addon.mjs')).href);
    // A cold nl3 Rust build measured 76 s. Share intermediates beside the
    // external runtime outputs, never inside the checkout Metro watches or a
    // completed read-only bundle. Runtimes only load their private addon copy.
    const cargoTargetDir = join(dirname(outputDir), 'iroh-cargo-target', 'source-runtime', irohInputDigest);
    const addonPath = await buildNodeAddon({ packageDir: join(repoDir, packagePath),
      artifactDir: join(irohPackageRoot, 'native'), cargoTargetDir, env,
      runCommand: (command, args, options) => runCapture(command, args, { ...options, signal }) });
    const packageJson = join(irohPackageRoot, 'package.json');
    await writeFile(packageJson, await readSourceInput(join(repoDir, packagePath, 'package.json')));
    retainedCodeFiles.push(addonPath, packageJson);
    logSourceRuntimePhase(component, 'iroh-native', started);
  }
  let authorPackageInputIdentities;
  let authorRuntimeImports = [];
  if (component === 'daemon') {
    phase('runtime-dependencies', 'author-packages');
    // Only hosts declaring public author packages need a physical author
    // closure; tiny source runtime fixtures have no such package inventory.
    if ((manifest.bundledDependencies ?? []).some(name => workspacePackages.get(name)?.manifest.happier?.publicSdkRelease)) {
      const author = await emitSourceAuthorPackages({repoDir,sourceRepoDir,projectDir,runtimeDir,workspacePackages,
        build,sourceInputDigests,readSourceInput,retainedRuntime,env,signal,
        // Author externals come from the installation this runtime's dependencies
        // come from, captured or linked: a linked runtime's node_modules name that
        // installation (its dependency generation), never a physical tree inside
        // this runtime (2026-11-18: every repo-dev start refused diff as outside
        // the runtime root).
        authorDependencies: {
          resolveFromPackageJsonPath: bundle => join(dependencyRootDir, relative(repoDir, bundle.srcDir), 'package.json'),
          toolRootDir: dependencyRootDir,
          dereferenceRootDir: dependencyRootDir }});
      // Author closures can exceed the engine's function-argument limit.
      for (const path of author.codeFiles) retainedCodeFiles.push(path);
      authorPackageInputIdentities = author.inputIdentities;
      authorRuntimeImports = author.runtimeImports;
    }
    phase('author-packages', 'runtime-resources');
    const sidecars = await bundleCliSourceSidecars({repoDir,outputDir:join(runtimeDir,'scripts'),build,workspacePackages,requireFromProject});
    for (const path of sidecars.codeFiles) retainedCodeFiles.push(path);
    Object.assign(result.metafile.inputs,sidecars.metafile.inputs);
    Object.assign(result.metafile.outputs,sidecars.metafile.outputs);
    // Server graphs join once the generated public-profile renderer is regenerated
    // from its escaped protocol regex (its checked-in output still carries one).
    await assertSourceRuntimeCodeAscii(Object.keys(result.metafile.outputs).map(file => resolve(repoDir, file)));
    if (existsSync(join(projectDir, 'assets'))) await cp(join(projectDir, 'assets'), join(runtimeDir, 'assets'), { recursive: true });
    const projectedCli = join(daemonProjectionRoot, 'apps/cli');
    const failuresPath = join(runtimeDir, BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH);
    await mkdir(dirname(failuresPath), { recursive: true });
    if (derivesDaemonProjections) {
      if (existsSync(join(projectedCli, 'assets'))) await cp(join(projectedCli, 'assets'), join(runtimeDir, 'assets'), { recursive: true });
      await cp(join(projectedCli, BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH), failuresPath);
    } else {
      await writeFile(failuresPath, '[]');
    }
    const nativeSource = join(projectDir, 'native/processcustody');
    const buildsProcessCustody = existsSync(join(nativeSource, 'go.mod'));
    const buildsCliProxyApi = pluginMetadata.some(item => item.package.name === '@happier-dev/plugins-cliproxyapi');
    if (buildsProcessCustody || buildsCliProxyApi) {
      // Vendor tools retain their installed lifecycle. First-party native code
      // must match this source graph, and staging must not write through a link
      // into the checkout's installed tools.
      const sourceTools = join(installedProjectDir, 'tools');
      for (const entry of existsSync(sourceTools) ? await readdir(sourceTools, { withFileTypes: true }) : []) {
        if (entry.name !== 'unpacked') {
          if (entry.isDirectory()) await linkInstalledDirectory(join(sourceTools, entry.name), join(runtimeDir, 'tools', entry.name));
          else { await mkdir(join(runtimeDir, 'tools'), { recursive: true }); await cp(join(sourceTools, entry.name), join(runtimeDir, 'tools', entry.name)); }
          continue;
        }
        const destination = join(runtimeDir, 'tools/unpacked');
        await mkdir(destination, { recursive: true });
        for (const tool of await readdir(join(sourceTools, 'unpacked'), { withFileTypes: true })) {
          if ((buildsProcessCustody && (/^happier-process-custody(?:\.exe)?$/.test(tool.name) || tool.name === 'targets'))
            || (buildsCliProxyApi && /^happier-cliproxyapi-managed(?:\.exe)?$/.test(tool.name))) continue;
          if (tool.isDirectory()) await linkInstalledDirectory(join(sourceTools, 'unpacked', tool.name), join(destination, tool.name));
          else await cp(join(sourceTools, 'unpacked', tool.name), join(destination, tool.name));
        }
      }
      const preparationDir = await mkdtemp(join(runtimeDir, '.source-native-'));
      try {
        const targetPath = join(preparationDir, 'target.mjs');
        await build({ entryPoints: [join(repoDir, 'packages/cli-common/src/componentArtifacts/targets.ts')],
          outfile: targetPath, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
        const { CLI_BINARY_TARGETS, resolveCurrentBinaryTarget } = await import(pathToFileURL(targetPath).href);
        const target = resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS });
        const runCommand = (command, args, options) => runCapture(command, args,
          { ...options, env: { ...env, ...options?.env }, signal });
        if (buildsProcessCustody) {
          const capture = await captureBuildInputFiles({ sourceDir: repoDir, captureDir: preparationDir,
            readPaths: () => readWorkspaceBuildInputs(projectDir, { additionalInputPaths: ['native/processcustody'] })
              .filter(path => path.startsWith('native/')).map(path => relative(repoDir, join(projectDir, path))) });
          for (const path of capture.files) sourceInputDigests[path] = createHash('sha256')
            .update(await readFile(join(preparationDir, path))).digest('hex');
          const ownerPath = join(preparationDir, 'custody.mjs');
          await build({ entryPoints: [join(repoDir, 'packages/cli-common/src/componentArtifacts/stageProcessCustodyRuntime.ts')],
            outfile: ownerPath, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
          const { stageProcessCustodyRuntime, stageProcessCustodyTargetRuntimes } = await import(pathToFileURL(ownerPath).href);
          const { executablePath } = await stageProcessCustodyRuntime({ repoRoot: preparationDir, payloadDir: runtimeDir, target, runCommand });
          retainedCodeFiles.push(executablePath);
          // Container-target helpers (static Linux, both architectures) ship with every runtime.
          retainedCodeFiles.push(...Object.values(await stageProcessCustodyTargetRuntimes({ repoRoot: preparationDir, payloadDir: runtimeDir, runCommand })));
        }
        if (buildsCliProxyApi) {
          const ownerPath = join(preparationDir, 'cliproxyapi.mjs');
          const commandsPath = join(preparationDir, 'commands.mjs');
          await build({ entryPoints: [join(repoDir, 'packages/cli-common/src/componentArtifacts/stageCliProxyApiManagedRuntime.ts')],
            outfile: ownerPath, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
          await build({ entryPoints: [join(repoDir, 'packages/cli-common/src/componentArtifacts/commands.ts')],
            outfile: commandsPath, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
          const { stageCliProxyApiManagedRuntime } = await import(pathToFileURL(ownerPath).href);
          const { resolvePnpmCommand } = await import(pathToFileURL(commandsPath).href);
          const staged = await stageCliProxyApiManagedRuntime({ repoRoot: repoDir, payloadDir: runtimeDir,
            target, pnpm: resolvePnpmCommand(), runCommand });
          retainedCodeFiles.push(staged.executablePath, staged.licensePath, staged.thirdPartyNoticesPath);
        }
      } finally { removeOwnedDirectorySync(preparationDir); }
    } else await linkInstalledDirectory(join(installedProjectDir, 'tools'), join(runtimeDir, 'tools'));
    const assets = join(projectDir, 'src/plugins/projection/registry/static-assets');
    if (existsSync(assets)) await cp(assets, join(runtimeDir, 'package-dist/plugins/projection/registry/static-assets'), { recursive: true });
  } else {
    if (existsSync(join(projectDir, 'sources/app/account/profile/render/publicProfileFonts.ts'))) {
      const { stagePublicProfileAssets } = await import('../../../server/scripts/buildPublicProfileRenderer.mjs');
      for (const path of await stagePublicProfileAssets({ projectDir, outDir: runtimeDir })) retainedCodeFiles.push(path);
    } else await linkInstalledDirectory(join(installedProjectDir, 'assets'), join(runtimeDir, 'assets'));
    const copyPrismaInputs = async (source, destination) => {
      await mkdir(destination, { recursive: true });
      for (const name of await readdir(source)) {
        const path = join(source, name);
        const target = join(destination, name);
        if ((await lstat(path)).isDirectory()) await copyPrismaInputs(path, target);
        else if (/\.(?:prisma|sql)$/.test(name) || name === 'migration_lock.toml') {
          // Record exactly the bytes emitted, just like the source-code loader.
          await writeFile(target, await readSourceInput(path));
        }
      }
    };
    if (existsSync(join(projectDir, 'prisma'))) await copyPrismaInputs(join(projectDir, 'prisma'), join(runtimeDir, 'prisma'));
  }
  phase('runtime-resources', 'output-identity');
  const distInputs = Object.keys(result.metafile.inputs).filter(file => isFirstPartyBuiltInput(file, workspacePackages));
  if (distInputs.length) throw new Error(`Source runtime consumed first-party built code: ${distInputs.join(', ')}`);
  const externalFirstParty = Object.values(result.metafile.outputs).flatMap((out) => out.imports)
    .filter((item) => item.external && (item.path.startsWith('@happier-dev/') || workspacePackages.has(packageNameOfSpecifier(item.path))));
  if (externalFirstParty.length) throw new Error(`Source runtime left first-party code external: ${externalFirstParty.map((item) => item.path).join(', ')}`);
  await writeFile(join(runtimeDir, 'metafile.json'), JSON.stringify(result.metafile));
  // Only installed external imports remain mutable after source emission. Keep
  // the full installation publication for finite build/reload admission, while
  // launch demand compares the closure this retained CLI actually imports.
  // Unbundled sidecars keep relative imports to their retained siblings; those
  // files already participate in the bundle identity above, not the install.
  const runtimeImports = component === 'daemon' ? [...new Map([...Object.values(result.metafile.outputs)
    .flatMap(output => output.imports).filter(item => item.external && !item.path.startsWith('.'))
    .map(item => {
      const entry = { path: item.path, resolveFrom: join(dependencyRootDir, 'apps/cli/package.json') };
      return entry;
    }), ...authorRuntimeImports].map(entry => [JSON.stringify(entry), entry])).values()] : null;
  const runtimeDependencyClosure = runtimeImports ? (captureDependencies
    ? captureRuntimeDependencies({ imports: runtimeImports, outputDir, sourceRepoDir: dependencyRootDir,
      manifestPath: join(projectDir, 'package.json'), signal })
    : { imports: runtimeImports, identity: readSourceRuntimeDependencyIdentity({ imports: runtimeImports, signal }) }) : null;
  const hash = createHash('sha256');
  for (const absolute of retainedCodeFiles.sort()) {
    hash.update(relative(runtimeDir, absolute));
    hash.update(await readFile(absolute));
  }
  // Native source changes select a new identity even when the compiler emits
  // identical bytes (for example after an input-only Rust edit).
  if (irohInputDigest) hash.update(irohInputDigest);
  if (runtimeDependencyClosure?.captured) hash.update(runtimeDependencyClosure.identity);
  const identity = hash.digest('hex').slice(0, 16);
  const entrypoint = join(runtimeDir, component === 'daemon' ? 'src/index.mjs' : 'sources/main.mjs');
  phase('output-identity');
  return {
    identity, entrypoint, runtimeCommand: entrypoint, args: [], runtimeDir, sourceInputDigests,
    ...(runtimeDependencyClosure ? { runtimeDependencyClosure } : {}),
    ...(authorPackageInputIdentities ? { authorPackageInputIdentities } : {}),
    ...(component === 'daemon' ? {
      nodeEntrypoint: entrypoint, cliDir: runtimeDir,
      env: {
        HAPPIER_STACK_CLI_ROOT_DIR: runtimeDir,
        HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint,
        HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
        HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '0',
      },
    } : {
      serverDir: runtimeDir, env: {
        ...(dbProvider ? { HAPPIER_DB_PROVIDER: dbProvider } : {}),
        ...((dbProvider ?? (serverComponent === 'happier-server-light' ? 'sqlite' : 'postgres')) === 'sqlite'
          ? { HAPPIER_SQLITE_MIGRATIONS_DIR: join(runtimeDir, 'prisma/sqlite/migrations') } : {}),
      },
      migration: migrationSource || sqliteMigration
        ? { mode: 'external', command: join(runtimeDir, 'scripts/migrate.mjs'), args: [], cwd: runtimeDir }
        : { mode: 'in-process' },
    }),
  };
  } catch (error) {
    logSourceRuntimePhase(component, activePhase, phaseStarted, 'failed');
    if (isTerminalBuildFailure(error)) console.error(redactFailureDiagnostic(error.message, env));
    throw error;
  }
}
