import { assertWebArtifactPayload } from '../runtime/shared/web_payload.mjs';
import { reapHistoricalTempRoots } from '../utils/dev_targets/historical_temp_roots.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync, lstatSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { runSourceBuildCommand, sourceBuildNodeArgs } from '../utils/proc/runSourceBuildCommand.mjs';
import { runWorkspaceBuildAdmission } from '../utils/proc/workspace_build_admission.mjs';
import { isWorkspaceBundleLockActive } from '../../../../packages/cli-common/workspaceBundleLock.mjs';
import { isPidAlive, observePidLiveness } from '../utils/proc/pids.mjs';
import { readWorkspaceBuildInputs, readSourceComponentBuildInputs } from '../utils/fs/workspaceBuildInputs.mjs';
import { readCachedFileDigestSync } from '../utils/fs/cached_file_digest.mjs';
import { writeJsonAtomic } from '../utils/fs/json.mjs';
import { withJsonOwnerFileLock } from '../utils/proc/jsonOwnerFileLock.mjs';
import { run, runCapture } from '../utils/proc/proc.mjs';
import { isDevStartupSourceDrift, prepareSourceComponent } from '../utils/dev/devReloadCoordinator.mjs';
import { captureBuildInputFiles, mountCapturedWorkspaceDependencies, readBuildInputIdentity, withBuildInputDependencies, assertBuildInputDependencies } from '../../../../scripts/workspaces/buildInputConvergence.mjs';
import { readSourceRuntimeDependencyIdentity } from './source_author_inputs.mjs';
import { resolveDependencyInstallRoot, resolveDependencyRefreshMarkerPath, resolveDependencyRefreshLockPath } from '../utils/proc/dependency_refresh.mjs';
import { probeCliDistRuntimeImport } from '../utils/cli/cliDistIntegrity.mjs';
import { retainPendingSourcePreparation, updatePendingSourcePreparationPhase } from '../runtime/shared/pending_source_start.mjs';
import { readBundledPluginPackageResourceRelativePaths } from '../../../../packages/cli-common/bundledPluginResources.mjs';
import { BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH } from '../../../../packages/cli-common/bundledPluginPublicationPolicy.mjs';

import { SOURCE_CONDITION, SOURCE_RUNTIME_OUTPUT_OPTIONS, sourceExport, readWorkspacePackages, resolveWorkspaceSource, workspaceSourceCompilerPaths, packageNameOfSpecifier, readCliSourceEntries, createCliSourceProjectionResolver, createWorkspaceSourceResolver, bundleCliSourceSidecars, runtimePackageExports } from '../../../../packages/cli-common/sourceRuntimeEntries.mjs';
export { readWorkspacePackages, resolveWorkspaceSource } from '../../../../packages/cli-common/sourceRuntimeEntries.mjs';

import { buildSourceGuestPayload, readSourceGuestPayloadTargets } from './source_guest_payload.mjs';

const SHARED_SOURCE_INPUT_MANIFEST = '.source-runtime-shared-inputs.json';

/** Finite web builds reuse workspace capture, not a second snapshot engine.
 * Capture authored inputs only; installed third-party tools retain their owner.
 * Later source edits belong to the next explicit build, never this Metro crawl. */
export async function captureSourceRuntimeSharedInputs({ repoDir, outputDir, signal }) {
  repoDir = resolve(repoDir);
  let filesByComponent = {};
  const capture = await captureBuildInputFiles({ sourceDir: repoDir, captureDir: outputDir,
    readPaths: async () => {
      signal?.throwIfAborted();
      filesByComponent = Object.fromEntries(await Promise.all(['server', 'daemon'].map(async component => [
        component,
        (await readSourceComponentBuildInputs({ repoDir, component })).files.filter(isSharedProtocolSourceInput),
      ])));
      return [...new Set(Object.values(filesByComponent).flat())];
    } });
  const captured = new Set(capture.files);
  filesByComponent = Object.fromEntries(Object.entries(filesByComponent)
    .map(([component, files]) => [component, files.filter(path => captured.has(path))]));
  await writeFile(join(outputDir, SHARED_SOURCE_INPUT_MANIFEST), JSON.stringify({ filesByComponent }));
  return { repoDir: outputDir };
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

export async function captureSourceWebBuildInputs({ repoDir, outputDir, component = 'expo', signal, sharedSourceInputs }) {
  repoDir = resolve(repoDir);
  const sharedManifest = await readSharedSourceInputManifest(sharedSourceInputs);
  const { workspaceDirs } = await readSourceComponentBuildInputs({ repoDir, component });
  signal?.throwIfAborted();
  const started = performance.now();
  const capture = await captureBuildInputFiles({ sourceDir: repoDir, captureDir: outputDir,
    readPaths: async () => {
      signal?.throwIfAborted();
      const files = (await readSourceComponentBuildInputs({ repoDir, component })).files;
      if (!sharedSourceInputs) return files;
      return [...files.filter(path => !isSharedProtocolSourceInput(path)), ...(sharedManifest.filesByComponent[component] ?? [])];
    } });
  if (sharedSourceInputs) {
    await rm(join(outputDir, 'packages/protocol/src'), { recursive: true, force: true });
    for (const path of sharedManifest.filesByComponent[component] ?? []) {
      const target = join(outputDir, path);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(sharedSourceInputs.repoDir, path), target, { verbatimSymlinks: true });
    }
  }
  await mountCapturedWorkspaceDependencies({ sourceDir: repoDir, captureDir: outputDir, workspaceDirs });
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
  return { repoDir: outputDir, uiProjectDir: join(outputDir, 'apps/ui'), files: capture.files, capturedAt: capture.capturedAt,
    inputIdentity: await readBuildInputIdentity({ sourceDir: outputDir, files: capture.files }) };
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
  let { files } = await readSourceComponentBuildInputs({ repoDir, component });
  if (sharedSourceInputs) {
    const sharedManifest = await readSharedSourceInputManifest(sharedSourceInputs);
    files = [...files.filter(path => !isSharedProtocolSourceInput(path)),
      ...(sharedManifest.filesByComponent[component] ?? [])].sort();
  }
  const consumed = consumedPaths && new Set(consumedPaths);
  const guestPayloadTargets = component === 'daemon' ? readSourceGuestPayloadTargets(env) : null;
  const fingerprintFiles = consumed && !guestPayloadTargets ? files.filter(path => !isCompilerTracedSource(path) || consumed.has(path)) : files;
  const options = [identityRepoDir, component, serverComponent, dbProvider, process.version, process.platform, process.arch, esbuild.version, files,
    guestPayloadTargets?.map(({ target, relativeDir }) => [target.bunTarget, relativeDir]) ?? null];
  if (!sharedSourceInputs) return await readBuildInputIdentity({ sourceDir: repoDir, files: fingerprintFiles, options });
  const hash = createHash('sha256').update(JSON.stringify(options));
  for (const path of [...new Set(fingerprintFiles)].sort()) {
    const sourceDir = isSharedProtocolSourceInput(path) ? sharedSourceInputs.repoDir : repoDir;
    const absolute = join(sourceDir, path);
    const info = await lstat(absolute, { bigint: true }).catch(error => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    });
    hash.update(JSON.stringify([path, info ? String(info.mode) : null]));
    if (info?.isFile()) hash.update(createHash('sha256').update(await readFile(absolute)).digest('hex'));
    else if (info?.isSymbolicLink()) hash.update(await readlink(absolute));
  }
  return hash.digest('hex');
}

async function readReusableSourceBundle({ bundleRoot, repoDir, component, serverComponent, dbProvider, sharedSourceInputs, env }) {
  if (!existsSync(bundleRoot)) return null;
  for (const entry of await readdir(bundleRoot, {withFileTypes:true})) {
    if (!entry.isDirectory() || (!entry.name.startsWith('bundle-') && !entry.name.startsWith('runtime-'))) continue;
    const outputDir = join(bundleRoot, entry.name);
    const record = await readOptionalJson(join(outputDir, 'source-bundle.json'));
    if (!record?.inputIdentity || !record.sourceInputDigests) continue;
    if (record.inputIdentity !== await sourceBundleFingerprint({ repoDir, component, serverComponent, dbProvider, sharedSourceInputs, env,
      consumedPaths: Object.keys(record.sourceInputDigests) })) continue;
    // A consumed file can change and be undone during preparation. The wide
    // membership fingerprint is only a cache hint; captured load bytes decide
    // whether this emitted graph is reusable for the current source.
    const current = Object.entries(record.sourceInputDigests).every(([path, digest]) => {
      const absolute = resolve(sharedSourceInputs && isSharedProtocolSourceInput(path) ? sharedSourceInputs.repoDir : repoDir, path);
      return digest && existsSync(absolute)
        && readCachedFileDigestSync(absolute, statSync(absolute, {bigint:true})) === digest;
    });
    if (!current) continue;
    const {reuseFingerprint, sourceInputDigests, inputIdentity, ...built} = record;
    return {outputDir, built};
  }
  return null;
}

export function sourceBundleBuildLockPath(bundleRoot, fingerprint) {
  return join(bundleRoot, `build-${fingerprint}.lock`);
}

export async function setBundleReadOnly(directory, readOnly) {
  for (const entry of await readdir(directory, {withFileTypes:true})) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue; // Installed dependencies keep their own lifecycle.
    if (entry.isDirectory()) {
      if (!readOnly) await chmod(path, 0o755);
      await setBundleReadOnly(path, readOnly);
    } else {
      const mode = (await lstat(path)).mode;
      await chmod(path, readOnly ? mode & ~0o222 : mode | 0o200);
    }
  }
  await chmod(directory, readOnly ? 0o555 : 0o755);
}

async function readOptionalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function isFirstPartyBuiltInput(key, workspacePackages) {
  key = key.replaceAll('\\', '/');
  if (!/^(?:packages|apps)\//.test(key)) return false;
  // The innermost installed package owns its files. A third-party dist tree
  // below a workspace (or bundled workspace copy) is not first-party output.
  const installed = key.split('/node_modules/').at(-1);
  if (installed !== key && !workspacePackages.has(packageNameOfSpecifier(installed))
      && !installed.startsWith('@happier-dev/')) return false;
  return /(?:^|\/)(?:dist|package-dist|\.happier-plugin)\//.test(installed);
}

async function emitSourceAuthorPackages({ repoDir, sourceRepoDir, projectDir, runtimeDir, workspacePackages, build,
  sourceInputDigests, readSourceInput, env, signal }) {
  const workDir = await mkdtemp(join(runtimeDir, '.author-emission-'));
  try {
    const { withDistProjectCompilerArgs } = await import('../../../../scripts/workspaces/buildTypeScriptPackageDist.mjs');
    const { resolveTypeScriptCliInvocation, matchesNativeTypeScriptInputVersion } = await import('../../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs');
    // Run the existing package classification, closure and physical copier
    // directly from source, not from a workspace dist prerequisite.
    const ownerPath = join(workDir, 'workspaces.mjs');
    await build({entryPoints:[join(repoDir, 'packages/cli-common/src/workspaces/index.ts')],
      outfile:ownerPath, bundle:true, platform:'node', format:'esm', logLevel:'silent'});
    const owner = await import(pathToFileURL(ownerPath).href);
    const bundles = owner.resolveWorkspaceBundlesFromPackageJson({repoRoot:repoDir,hostPackageDir:projectDir});
    const roots = bundles.filter(bundle => owner.sanitizeBundledPackageJson(
      workspacePackages.get(bundle.packageName).manifest).happier?.publicSdkRelease);
    const closure = new Set(owner.resolveInternalWorkspacePackageNameClosure({repoRoot:repoDir,
      packageNames:roots.map(bundle => bundle.packageName)}));
    const authorRoot = join(runtimeDir, 'authoring/node_modules');
    const codeFiles = [];
    const sourcePaths = workspaceSourceCompilerPaths(workspacePackages);
    for (const bundle of bundles) {
      const destDir = join(authorRoot, ...bundle.packageName.split('/'));
      await mkdir(destDir, {recursive:true});
      if (!closure.has(bundle.packageName)) {
        // The existing author materializer inventories all host bundle names,
        // but only public roots and their declared dependencies are copied.
        await writeFile(join(destDir, 'package.json'), JSON.stringify(workspacePackages.get(bundle.packageName).manifest));
        continue;
      }
      const compilerDir = join(workDir, ...bundle.packageName.split('/'));
      await mkdir(compilerDir, {recursive:true});
      const outputDir = join(compilerDir, 'emitted');
      const buildInfoPath = join(compilerDir, 'build.tsbuildinfo');
      const args = await withDistProjectCompilerArgs(['--outDir',outputDir,'--tsBuildInfoFile',buildInfoPath,
        '--incremental','--noCheck'], {projectPath:join(bundle.srcDir,'tsconfig.json'),workDir:compilerDir,
        compilerOptions:{rootDir:repoDir,customConditions:[SOURCE_CONDITION],paths:sourcePaths,declaration:true,
          noEmit:false,emitDeclarationOnly:false}});
      const invocation = resolveTypeScriptCliInvocation({args,workspaceDir:repoDir,admissionClass:'source-bundle',env});
      await runCapture(invocation.command, [...invocation.argsPrefix,...args], {cwd:repoDir,ownedProcessGroup:true,env,signal});
      const info = JSON.parse(await readFile(buildInfoPath, 'utf8'));
      for (const [index, file] of info.fileNames.entries()) {
        // Native TypeScript records its built-in libraries as bare logical
        // names, not paths relative to this caller-owned compiler directory.
        if (/^lib(?:\.[^/\\]+)?\.d\.ts$/.test(file)) continue;
        const path = realpathSync(resolve(compilerDir, file));
        // These are this build's dependency-first outputs, already traced to
        // consumed source bytes above. Checkout/installed dist stays forbidden.
        if (path.startsWith(realpathSync(authorRoot) + sep)) continue;
        const key = relative(realpathSync(repoDir), path).replaceAll('\\', '/');
        if (!/^(?:packages|apps)\//.test(key)) continue;
        if (isFirstPartyBuiltInput(key, workspacePackages)) {
          throw new Error(`Source author closure consumed first-party built code: ${key}`);
        }
        const contents = await readSourceInput(path);
        const version = typeof info.fileInfos[index] === 'string' ? info.fileInfos[index] : info.fileInfos[index].version;
        // The compiler's consumed input version is the authority. An editor
        // undo during emission cannot cache the graph under restored bytes.
        if (!await matchesNativeTypeScriptInputVersion(contents, version)) sourceInputDigests[relative(repoDir,path).split(sep).join('/')] = null;
      }
      owner.bundleWorkspacePackageWithRuntimeDependencies({...bundle,destDir,
        resolveFromPackageJsonPath: join(sourceRepoDir, relative(repoDir, bundle.srcDir), 'package.json'),
        dereferenceRootDir: sourceRepoDir,
        distDir:join(outputDir, relative(repoDir,bundle.srcDir),'src')});
      // The closure is dependency-first. Later packages consume declarations
      // from this build's physical package, rather than re-inferring and
      // re-emitting every dependency's source graph. Never use checkout dist.
      for (const [specifier, targets] of Object.entries(sourcePaths)) {
        if (packageNameOfSpecifier(specifier) !== bundle.packageName) continue;
        sourcePaths[specifier] = targets.map(source => {
          if (!/\.(?:tsx?|mts|cts)$/.test(source)) return source;
          const declaration = relative(join(bundle.srcDir, 'src'), source)
            .replace(/\.(?:ts|tsx)$/, '.d.ts').replace(/\.mts$/, '.d.mts').replace(/\.cts$/, '.d.cts');
          return join(destDir, 'dist', declaration);
        });
      }
      const visit = async directory => {
        for (const entry of await readdir(directory, {withFileTypes:true})) {
          const path = join(directory,entry.name);
          if (entry.isDirectory()) await visit(path);
          else if (!entry.isSymbolicLink()) codeFiles.push(path);
        }
      };
      await visit(destDir);
    }
    return codeFiles;
  } finally {
    await rm(workDir, {recursive:true,force:true});
  }
}

function privateSourceStackActive(state, pending) {
  return [state?.ownerPid, ...Object.values(state?.processes ?? {}).flat(), pending?.pid]
    .some(pid => Number.isSafeInteger(Number(pid)) && Number(pid) > 1 && observePidLiveness(pid).status !== 'dead')
    || Object.values(state?.remoteTargets ?? {}).some(target => Object.values(target?.services ?? {}).some(Boolean));
}

function readSourceRetentionRecord(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw Object.assign(new Error('Source retention record unavailable'), { code: 'ERETENTIONRECORD' });
  }
}

function sourceRecordReferencePaths(record) {
  return [record?.entrypoint, record?.uiDir, record?.exportDir, record?.runtimeDir]
    .filter(path => typeof path === 'string');
}

function readSourceRetentionStack(stackBaseDir) {
  const sourceRoot = join(stackBaseDir, 'source-runtime');
  const pending = readSourceRetentionRecord(join(sourceRoot, 'start.pending.json'));
  const state = readSourceRetentionRecord(join(stackBaseDir, 'stack.runtime.json'));
  const references = [];
  if (pending && isPidAlive(pending.pid)) references.push(...(pending.preparationDirs ?? []), pending.preparationDir);
  for (const component of ['daemon', 'server', 'ui']) {
    references.push(...sourceRecordReferencePaths(readSourceRetentionRecord(join(sourceRoot, `selected-${component}.json`))));
  }
  if ([state?.ownerPid, state?.processes?.daemonPid, ...(state?.processes?.daemonPids ?? [])].some(isPidAlive)) {
    references.push(...sourceRecordReferencePaths(state?.sourceRuntimeLaunch));
  }
  if ([state?.ownerPid, state?.processes?.serverPid].some(isPidAlive)) {
    references.push(...sourceRecordReferencePaths(state?.sourceUiLaunch));
  }
  return { state, pending, references };
}

function canonicalSourceReferences(references) {
  return references.filter(Boolean).flatMap(path => {
    try { return [realpathSync(path)]; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  });
}

function privateSourceRecordRetains(stackBaseDir, directory, records = readSourceRetentionStack(stackBaseDir)) {
  if (privateSourceStackActive(records.state, records.pending)) return true;
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
  if (!candidates.length) return;
  const retired = [];
  await withSourceBundlePublicationCustody({ bundleRoot, signal, operation: 'retirement' }, () => {
    // Refresh the narrow canonical pin records after expensive qualification.
    // Every publisher/adopter uses this same custody; no await separates its
    // final pin check from the atomic removal of the reusable directory name.
    const stacks = new Map(readdirSync(stacksRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== 'source-bundles')
      .map(entry => [join(stacksRoot, entry.name), readSourceRetentionStack(join(stacksRoot, entry.name))]));
    const references = canonicalSourceReferences([...stacks.values()].flatMap(stack => stack.references));
    for (const candidate of candidates) {
      const info = sourceRetentionStat(candidate.directory);
      const completion = candidate.privateStack ? null : sourceRetentionStat(join(candidate.directory, 'source-bundle.json'));
      const canonicalDirectory = info && realpathSync(candidate.directory);
      const retained = info && (!sameSourceRetentionStat(info, candidate.info)
        || !sameSourceRetentionStat(completion, candidate.completion ?? null)
        || (candidate.fingerprint && isWorkspaceBundleLockActive(sourceBundleBuildLockPath(bundleRoot, candidate.fingerprint), { staleAfterMs: Infinity }))
        || references.some(path => path === canonicalDirectory || path.startsWith(canonicalDirectory + sep))
        || (candidate.privateStack && privateSourceRecordRetains(candidate.privateStack, candidate.directory, stacks.get(candidate.privateStack))));
      if (!info || retained) {
        if (candidate.result) {
          candidate.result.reclaimableRoots--;
          candidate.result.reclaimableBytes -= candidate.bytes;
          if (retained) candidate.result.retainedRoots++;
        }
        continue;
      }
      if (dryRun) continue;
      retired.push({ ...candidate, directory: retireSourceDirectory(candidate.directory) });
    }
  });
  for (const candidate of retired) {
    try {
      await setBundleReadOnly(candidate.directory, false);
      await rm(candidate.directory, { recursive: true, force: true });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (candidate.result) {
      candidate.result.reclaimedRoots++;
      candidate.result.reclaimedBytes += candidate.bytes;
    }
  }
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
    if (!entry.name.startsWith('.retired-') && (!newestBuilt.has(component) || createdMs > newestBuilt.get(component).createdMs)) {
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
    const { pending, state, references: stackReferences } = readSourceRetentionStack(stackBaseDir);
    references.push(...stackReferences);
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
      const active = privateSourceStackActive(state, pending);
      const group = { stack: entry.name, parent: sourceRoot, names, active };
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
  let liveCommands = '';
  try {
    if (process.platform === 'win32') return { observationUnavailable: true, stacks: [] }; // No authoritative process command observation here.
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
    console.error(`[source-bundle] retaining bundles: live process observation unavailable (${error.code ?? error.message})`);
    return { observationUnavailable: true, stacks: [] };
  }
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
  const nominations = (dryRun || !reclaimShared ? [] : candidates)
    .filter(candidate => !isPinned(candidate.directory));
  const stacks = [];
  for (const group of privateWeb) {
    const candidateNames = group.active ? [] : group.names.filter(name => !isPinned(join(group.parent, name)));
    // Private historical outputs retain the canonical historical age boundary,
    // ownership, descendant/inode, binding and immediate process-reference checks.
    const qualified = [];
    const qualification = reapHistoricalTempRoots(group.parent, '/proc', { candidateNames, dryRun: true,
      retainCandidate: (directory, _references, tree) => {
        if (privateSourceRecordRetains(dirname(group.parent), directory)) return true;
        qualified.push({ directory, info: tree.info, bytes: tree.bytes, privateStack: dirname(group.parent) });
        return false;
      } });
    const result = { stack: group.stack, roots: group.names.length, protectedRoots: group.names.length - candidateNames.length,
      active: group.active, ...qualification };
    stacks.push(result);
    nominations.push(...qualified.map(candidate => ({ ...candidate, result })));
  }
  await retireSourceCandidates({ stacksRoot, bundleRoot, candidates: nominations, dryRun, signal });
  return { observationUnavailable: false, stacks };
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
        await setBundleReadOnly(failedRetirement, false);
        await rm(failedRetirement, { recursive: true, force: true });
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

function isSharedProtocolSourceInput(path) {
  return /^packages\/protocol\/src\//.test(path);
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

async function publishSourceRuntimeBundle({stackBaseDir, bundleRoot, component, built, record, signal, reuseSelected, pendingRequestId}) {
  // This is short output-metadata custody, not a workspace producer lease:
  // nobody compiles, acquires build leases or waits for admission underneath
  // it. The existing JSON publication owner can therefore finish an admitted
  // graph without reversing native workspace/admission ordering.
  const outputDir = resolve(built.runtimeDir, '../..');
  return await withSourceBundlePublication({ stackBaseDir, outputDir, record, signal }, () =>
    selectCompletedSourceRuntimeBundle({ stackBaseDir, component, built, signal, reuseSelected, pendingRequestId }));
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

async function adoptReusableSourceRuntimeBundle({ stackBaseDir, bundleRoot, component, repoDir,
  serverComponent, dbProvider, env, signal, reuseSelected, pendingRequestId, sharedSourceInputs }) {
  // Lookup, probe and adoption must exclude other fingerprints' reclamation.
  // No compiler or admission wait runs inside this publication section.
  return await withSourceBundlePublication({ stackBaseDir, signal }, async () => {
    const reusable = await readReusableSourceBundle({ bundleRoot, repoDir, component, serverComponent, dbProvider, sharedSourceInputs, env });
    if (!reusable) return null;
    if (component === 'daemon') await probeCliDistRuntimeImport(reusable.built.entrypoint,
      { cwd: reusable.built.cliDir, env, signal });
    return await selectCompletedSourceRuntimeBundle({ stackBaseDir, component, built: reusable.built,
      signal, reuseSelected, pendingRequestId });
  });
}

/** Build from the execution host's installed source. Stack consumers share one
 * read-only result when source/tool inputs still match; explicit outputDir is the finite
 * producer boundary used by source-bundle tests and probes. A pending Stack
 * request prepares and retains shared candidates; its activation selects them.
 */
export async function buildSourceRuntimeBundle(options) {
  // A pending Stack start/reload is runtime-host startup work, just like dev
  // construction. Select the existing startup admission policy here so every
  // local/remote role shares it; standalone validation keeps capacity admission.
  options = { devStartup: Boolean(options.preparation ?? options.pending), ...options };
  if (options.pending && (!options.stackBaseDir || !options.pending.requestId || options.reuseSelected)) {
    throw new Error('[source-bundle] pending preparation requires a Stack request and current-input lookup');
  }
  const readLastGreen = Boolean(options.devStartup && options.preparation && !options.pending && !options.reuseSelected);
  const selection = options.reuseSelected || (readLastGreen ? 'if-available' : false);
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
    let selectedBundle = await withJsonOwnerFileLock(async () => {
      const selected = await readSelected();
      if (options.requireCoherentSelection === true) {
        await assertSelectedSourceRuntimeInputCoherence({ stackBaseDir });
      }
      return selected;
    }, {
      lockPath: join(dirname(stackBaseDir), 'source-bundles/publication.lock'), timeoutMs: Infinity,
      staleAfterMs: Infinity, signal: options.signal, errorLabel: 'source-bundle publication lock',
    });
    if (selectedBundle && options.component === 'server'
      && ((options.serverComponent && selectedBundle.serverComponent !== options.serverComponent)
        || (options.dbProvider && selectedBundle.dbProvider !== options.dbProvider))) {
      if (selection !== 'if-available') throw new Error('[source-bundle] selected server configuration does not match the requested server');
      selectedBundle = null;
    }
    if (selectedBundle) {
      if (options.component === 'daemon') await probeCliDistRuntimeImport(selectedBundle.entrypoint,
        { cwd: selectedBundle.cliDir, env: options.env, signal: options.signal });
      if (readLastGreen) {
        const { preparation, ...refreshOptions } = options;
        // Publish a shared candidate while preserving the QA selection. Only
        // its existing explicit reload owner activates replacement bytes.
        void preparation.prepareInBackground(async signal => {
          const preparationSignal = options.signal ? AbortSignal.any([signal, options.signal]) : signal;
          try {
            await prepareSourceComponent({ repoDir: resolve(options.repoDir), target: options.component,
              env: options.env, signal: preparationSignal, logger: options.logger,
              prepare: () => buildSourceRuntimeBundleOnce({ ...refreshOptions, pending: undefined,
                reuseSelected: 'if-available', signal: preparationSignal }) });
          } catch (error) {
            if (!preparationSignal.aborted) (options.logger ?? console).error(`[source-bundle] background ${options.component} preparation failed:`, error);
          }
        });
      }
      return options.devStartup ? { ...selectedBundle, lastGreen: true } : selectedBundle;
    }
  }
  if (!options.stackBaseDir) return await buildSourceRuntimeBundleOnce(options);
  const preparation = options.preparation ?? options.pending;
  await preparation?.setPhase({ phase: 'preparing', component: options.component });
  const prepare = () => buildSourceRuntimeBundleOnce(options);
  const built = options.waitForSourceChanges === false ? await prepare() : await prepareSourceComponent({ repoDir: resolve(options.repoDir), target: options.component,
    env: options.env, signal: options.signal, logger: options.logger,
    prepare });
  await preparation?.setPhase({ phase: 'prepared', component: options.component });
  return built;
}

async function buildSourceRuntimeBundleOnce({ repoDir, outputDir, stackBaseDir, component, reuseSelected = false, serverComponent = 'happier-server-light', dbProvider,
  pending, preparation = pending, env = process.env, signal = pending?.signal, devStartup = false, sharedSourceInputs }) {
  repoDir = resolve(repoDir);
  if (component === 'server') {
    const { ensureServerGeneratedProviderOutputs } = await import('../utils/proc/pm.mjs');
    // Prepare before the finite builder takes read custody or captures inputs.
    await ensureServerGeneratedProviderOutputs(join(repoDir, 'apps', 'server'), repoDir, { env, quiet: true, signal });
  }
  if (stackBaseDir) {
    stackBaseDir = resolve(stackBaseDir);
    const bundleRoot = join(dirname(stackBaseDir), 'source-bundles');
    const inputs = {repoDir, component, serverComponent, dbProvider, reuseSelected, devStartup, sharedSourceInputs, pendingRequestId: pending?.requestId,
      preparationRequestId: preparation?.requestId};
    const fingerprint = await sourceBundleFingerprint(inputs);
    const lockPath = sourceBundleBuildLockPath(bundleRoot, fingerprint);
    await preparation?.setPhase({ phase: 'queued', component });
    // Completed lookup and adoption use the publication owner. A producer
    // lease would only serialize these immutable reads with cold compilation
    // and introduce another held resource before metadata acquisition.
    const cached = await adoptReusableSourceRuntimeBundle({stackBaseDir, bundleRoot, ...inputs, env, signal});
    if (cached) return cached;
    // Only a cold fingerprint enters compiler admission. Its canonical lease
    // coalesces identical producers; the native owner releases it before
    // waiting on a busy host. Different fingerprints have independent outputs.
    const prepare = () => runWorkspaceBuildAdmission({ repoDir, dependencyInstallDir: repoDir,
      launcherPath:fileURLToPath(new URL('../../bin/hstack-exec', import.meta.url)),
      command:process.execPath, args:[fileURLToPath(import.meta.url), JSON.stringify({...inputs, stackBaseDir, fingerprint})],
      locks:[{path:lockPath, kind:'workspace', timeoutMs:null, errorLabel:'source-bundle build lock'}],
      cwd:repoDir, env, signal, devStartup, admissionClass:'source-bundle', stdio:['ignore','pipe','pipe'],
      onStderr:chunk => process.stderr.write(chunk) });
    let result = await prepare();
    if (!result.error && !result.signal && result.status === 1
        && /^HSTACK_WORKSPACE_ADMISSION_ORDER:/m.test(result.stderr)) {
      // A queued launcher can outlive an admission-protocol cutover. Its child
      // must not adopt the newer envelope underneath the inherited lease.
      // The terminal attempt has now unwound that lease: follow the admission
      // owner's instruction by invoking the complete joint producer afresh.
      signal?.throwIfAborted();
      process.stderr.write('[source-bundle] re-invoking joint workspace admission after the prior preparation lease was released\n');
      result = await prepare();
    }
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const error = new Error(`Source preparation failed (${result.signal ? `signal ${result.signal}` : `exit ${result.status}`})`);
      error.code = result.status;
      error.signal = result.signal;
      error.sourceDrift = isDevStartupSourceDrift({code:result.status, message:result.stderr}, component);
      throw error;
    }
    const built = JSON.parse(result.stdout);
    if (built.sourceInputsChanged) return await buildSourceRuntimeBundleOnce({ ...inputs, stackBaseDir, pending, preparation, env, signal });
    // The finite producer completed publication before releasing fingerprint
    // custody. No unselected completed graph crosses an unprotected handoff.
    return built;
  }
  outputDir = resolve(outputDir);
  const stdout = await runSourceBuildCommand({ repoDir, scriptPath: fileURLToPath(import.meta.url),
    args: [JSON.stringify({ repoDir, outputDir, component, serverComponent, dbProvider, sharedSourceInputs })], env, signal, devStartup, captureStderr: true, admissionClass:'source-bundle' });
  const {sourceInputDigests, inputIdentity, ...built} = JSON.parse(stdout);
  signal?.throwIfAborted();
  if (component === 'daemon') await probeCliDistRuntimeImport(built.entrypoint, { cwd: built.cliDir, env, signal });
  await writeJsonAtomic(join(outputDir, 'source-bundle.json'), {...built, sourceInputDigests, inputIdentity});
  return built;
}

async function prepareSharedSourceRuntimeBundle({repoDir, stackBaseDir, component, serverComponent, dbProvider, reuseSelected, fingerprint:admittedFingerprint,
  pendingRequestId, preparationRequestId, sharedSourceInputs, env = process.env, signal}) {
  const stacksRoot = dirname(stackBaseDir);
  const bundleRoot = join(stacksRoot, 'source-bundles');
  const inputs = {repoDir, component, serverComponent, dbProvider, reuseSelected, pendingRequestId, sharedSourceInputs};
  // The admitted hint binds this allocation to its actual lease. Capture owns
  // the input identity: source edits (or a loaded caller's earlier tooling)
  // must not discard admission and recursively reselect before construction.
  const fingerprint = admittedFingerprint ?? await sourceBundleFingerprint(inputs);
  const cached = await adoptReusableSourceRuntimeBundle({stackBaseDir, bundleRoot, ...inputs, env, signal});
  if (cached) return cached;
  // The selected graph already has Stack retention. Borrow its inventory only
  // as a candidate; the canonical UI owner revalidates and materializes bytes
  // into this replacement, never leaving a link to the incumbent's output.
  const incumbent = component === 'daemon' ? await withSourceBundlePublication({ stackBaseDir, signal }, () =>
    readSelectedSourceRuntimeBundle({ stackBaseDir, component, required: false })) : null;
  const retainedPluginUiInventoryPath = incumbent && join(incumbent.runtimeDir, 'plugin-ui-inventory.js');
  if (preparationRequestId) await updatePendingSourcePreparationPhase({ stackBaseDir, requestId: preparationRequestId,
    phase: 'building', component, signal });
  await mkdir(bundleRoot, {recursive:true});
  // This allocation is not a claim about checkout bytes. The existing
  // emitted-code identity below describes what this finite build produced.
  // Typed allocation kinds stay in the same store. Already-loaded legacy
  // retainers do not nominate these newly deferred shared candidates.
  const outputDir = await mkdtemp(join(bundleRoot, `runtime-${fingerprint}-`));
  try {
    // This worker inherits dependency custody and owns fingerprint custody and compiler admission.
    // There is no second launch/admission for the same finite graph.
    const {sourceInputDigests, inputIdentity, ...built} = await buildSourceRuntimeBundleInProcess({...inputs, outputDir, retainedPluginUiInventoryPath, env, signal});
    signal?.throwIfAborted();
    if (component === 'daemon') await probeCliDistRuntimeImport(built.entrypoint, { cwd: built.cliDir, env, signal });
    return await publishSourceRuntimeBundle({stackBaseDir, bundleRoot, component, built, signal, reuseSelected, pendingRequestId,
      record:{...built, sourceInputDigests, inputIdentity, reuseFingerprint:fingerprint}});
  } catch (error) {
    if (existsSync(outputDir)) { await setBundleReadOnly(outputDir, false); await rm(outputDir, {recursive:true, force:true}); }
    throw error;
  }
}

/** The source selection owner admits a complete replacement, without claiming
 * that its processes have loaded it. Preparation never writes these pointers.
 */
export async function admitSourceRuntimeReload({ stackBaseDir, components, ui = null, pending, env = process.env }) {
  pending.signal.throwIfAborted();
  if (components.daemon) await probeCliDistRuntimeImport(components.daemon.entrypoint,
    { cwd: components.daemon.cliDir, env, signal: pending.signal });
  if (components.server || ui) {
    // Replacement health smoke is service lifecycle; finite builders own admission.
    const repoDir = env.HAPPIER_STACK_REPO_DIR;
    await run(process.execPath, sourceBuildNodeArgs({ repoDir,
      scriptPath: fileURLToPath(new URL('../runtime/launch/smokeSourceRuntimeReload.mjs', import.meta.url)),
      args: [JSON.stringify({ components, ui })] }),
    { cwd: repoDir, env, signal: pending.signal, ownedProcessGroup: true, captureFailureDiagnostic: true });
  }
  const sourceRoot = join(stackBaseDir, 'source-runtime');
  return { activate: () => pending.publish(() => withJsonOwnerFileLock(async () => {
    const previous = new Map();
    try {
      for (const [component, built] of Object.entries(components)) {
        const record = await readOptionalJson(join(resolve(built.runtimeDir, '../..'), 'source-bundle.json'));
        if (record?.identity !== built.identity || record?.entrypoint !== built.entrypoint || !existsSync(built.entrypoint)) {
          throw new Error(`[source-bundle] cannot select an incomplete ${component} reload graph`);
        }
      }
      const selections = { ...Object.fromEntries(Object.entries(components).map(([component, built]) => [component, { entrypoint: built.entrypoint }])),
        ...(ui ? { ui } : {}) };
      for (const [component, selection] of Object.entries(selections)) {
        const path = join(sourceRoot, `selected-${component}.json`);
        previous.set(path, await readOptionalJson(path));
        await writeJsonAtomic(path, selection);
      }
    } catch (error) {
      for (const [path, selection] of previous) {
        if (selection) await writeJsonAtomic(path, selection);
        else await rm(path, { force: true });
      }
      throw error;
    }
  }, { lockPath: join(dirname(stackBaseDir), 'source-bundles/publication.lock'), timeoutMs: Infinity,
    staleAfterMs: Infinity, signal: pending.signal, errorLabel: 'source-bundle publication lock' })) };
}

async function buildSourceRuntimeBundleInProcess({ repoDir, outputDir, component, serverComponent, dbProvider, retainedPluginUiInventoryPath, sharedSourceInputs, env = process.env, signal }) {
  return await withBuildInputDependencies({ sourceDir: repoDir, env, signal }, async (env, publication) => ({
      ...await consumeSourceRuntimeBuildInputs({ repoDir, outputDir, component, serverComponent, dbProvider, retainedPluginUiInventoryPath, sharedSourceInputs, env, signal }),
      dependencyPublication: { ...publication.state,
        markerPath: resolveDependencyRefreshMarkerPath(resolveDependencyInstallRoot(repoDir)),
        generationPath: `${resolveDependencyRefreshLockPath(resolveDependencyInstallRoot(repoDir), env)}.generation`,
      },
    }));
}

async function consumeSourceRuntimeBuildInputs({ repoDir, outputDir, component, serverComponent, dbProvider, retainedPluginUiInventoryPath, sharedSourceInputs, env, signal }) {
  if (component !== 'daemon' && component !== 'server') throw new Error(`Unsupported source runtime component: ${component}`);
  repoDir = resolve(repoDir);
  outputDir = resolve(outputDir);
  await mkdir(outputDir, { recursive: true });
  if ((await readdir(outputDir)).length > 0) throw new Error(`Source runtime output directory must be empty: ${outputDir}`);
  const sourceRepoDir = repoDir;
  const guestPayloadTargets = component === 'daemon' ? readSourceGuestPayloadTargets(env) : null;
  const captured = await captureSourceWebBuildInputs({ repoDir, component, outputDir: join(outputDir, 'workspace'), signal, sharedSourceInputs });
  const sourceCapture = { inputIdentity: captured.inputIdentity, capturedAt: captured.capturedAt };
  repoDir = captured.repoDir;
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
    const built = await emitSourceRuntimeBundle({ repoDir, sourceRepoDir, capturedFiles: captured.files, guestPayloadTargets,
      outputDir, component, serverComponent, dbProvider, retainedPluginUiInventoryPath, projectDir, runtimeDir, manifest, requireFromProject, esbuild, env, signal });
    if (guestPayloadTargets) {
      built.guestPayload = await buildSourceGuestPayload({ repoDir, sourceRepoDir, outputDir, runtimeDir,
        targets: guestPayloadTargets, sourceCapture, env, signal });
      built.env = { ...built.env, HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: built.guestPayload.root };
    }
    const inputIdentity = await sourceBundleFingerprint({ repoDir, identityRepoDir: sourceRepoDir,
      component, serverComponent, dbProvider, consumedPaths: Object.keys(built.sourceInputDigests), sharedSourceInputs, env });
    return { ...built, inputIdentity, sourceCapture, ...(component === 'server'
      ? { serverComponent, dbProvider: dbProvider ?? (serverComponent === 'happier-server-light' ? 'sqlite' : 'postgres') } : {}) };
  } finally {
    await rm(repoDir, { recursive: true, force: true });
    esbuild.stop();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

// Private finite worker: callers use the public function above so every source
// build goes through the existing host admission owner before graph construction.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = JSON.parse(process.argv[2]);
    let result;
    if (options.stackBaseDir) {
      // Preserve cancellation during fingerprint observation/publication;
      // graph construction also retires its own native esbuild service.
      const cancellation = new AbortController();
      const interrupt = () => cancellation.abort();
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', interrupt);
      try {
        result = await prepareSharedSourceRuntimeBundle({...options, signal:cancellation.signal});
      } finally {
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', interrupt);
      }
    } else result = await buildSourceRuntimeBundleInProcess(options);
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    if (error?.name === 'AbortError') process.exitCode = 130;
    else {
      console.error(error);
      process.exitCode = 1;
    }
  }
}

async function emitSourceRuntimeBundle({ repoDir, sourceRepoDir, capturedFiles, guestPayloadTargets, outputDir, component, serverComponent, dbProvider, retainedPluginUiInventoryPath,
  projectDir, runtimeDir, manifest, requireFromProject, esbuild, env, signal }) {
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
  const build = options => esbuild.build({...options, plugins:[...(options.plugins ?? []), captureInputs]});
  const workspacePackages = await readWorkspacePackages(repoDir);
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
      await run(process.execPath, ['--conditions=happier-source', '--experimental-strip-types',
        generatorPath, '--daemon-projections', '--daemon-output-root', daemonProjectionRoot], {
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
      // Native support has an existing deterministic package-root locator. Keep
      // that support root on the execution host; freeze all of its JS logic.
      builder.onLoad({ filter: /iroh-native[\\/]src[\\/]nodeNative\.ts$/ }, async (args) => ({
        contents: (await readSourceInput(args.path)).toString('utf8').replaceAll('import.meta.url', JSON.stringify(pathToFileURL(join(sourceRepoDir, relative(repoDir, args.path))).href)),
        loader: 'ts', resolveDir: dirname(args.path),
      }));
    },
  };
  const result = await build({
    absWorkingDir: repoDir, entryPoints: entries, outdir: outputDir,
    bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node20',
    ...SOURCE_RUNTIME_OUTPUT_OPTIONS,
    conditions: [SOURCE_CONDITION], tsconfig: join(projectDir, 'tsconfig.json'),
    chunkNames: `${outputPrefix}/src/chunks/[name]-[hash]`,
    banner: { js: "import { createRequire as __sourceCreateRequire } from 'node:module'; import {fileURLToPath as __sourceFileURLToPath} from 'node:url'; import {dirname as __sourcePathDirname} from 'node:path'; const require = __sourceCreateRequire(import.meta.url); const __sourceFilename = __sourceFileURLToPath(import.meta.url); const __sourceDirname = __sourcePathDirname(__sourceFilename);" },
    define: { __dirname: '__sourceDirname', __filename: '__sourceFilename' },
    metafile: true, logLevel: 'silent', plugins: [
      ...(derivesDaemonProjections ? [createCliSourceProjectionResolver({projectionRoot: daemonProjectionRoot})] : []),
      plugin, createWorkspaceSourceResolver({workspacePackages, requireFromProject}),
    ],
  });
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
      await rm(preparationDir, { recursive: true, force: true });
    }
  }
  for (const key of Object.keys(entries).filter((key) => key.startsWith(`${outputPrefix}/`))) {
    const target = join(outputDir, `${key}.mjs`);
    await writeFile(target, `export * from './${key.split('/').at(-1)}.js';\n`);
    retainedCodeFiles.push(target);
  }
  await linkInstalledDirectory(join(sourceRepoDir, 'node_modules'), join(outputDir, 'node_modules'));
  const installedProjectDir = join(sourceRepoDir, 'apps', component === 'daemon' ? 'cli' : 'server');
  await linkInstalledDirectory(join(installedProjectDir, 'node_modules'), join(runtimeDir, 'node_modules'));
  if (component === 'daemon') {
    // Plugin entries live outside apps/cli, but externalize against that same
    // host. Preserve its Node lookup chain before the checkout-root fallback.
    await linkInstalledDirectory(join(installedProjectDir, 'node_modules'), join(outputDir, 'packages/node_modules'));
    // Only hosts declaring public author packages need a physical author
    // closure; tiny source runtime fixtures have no such package inventory.
    if ((manifest.bundledDependencies ?? []).some(name => workspacePackages.get(name)?.manifest.happier?.publicSdkRelease)) {
      retainedCodeFiles.push(...await emitSourceAuthorPackages({repoDir,sourceRepoDir,projectDir,runtimeDir,workspacePackages,
        build,sourceInputDigests,readSourceInput,env,signal}));
    }
    const sidecars = await bundleCliSourceSidecars({repoDir,outputDir:join(runtimeDir,'scripts'),build,workspacePackages,requireFromProject});
    retainedCodeFiles.push(...sidecars.codeFiles);
    Object.assign(result.metafile.inputs,sidecars.metafile.inputs);
    Object.assign(result.metafile.outputs,sidecars.metafile.outputs);
    if (existsSync(join(projectDir, 'assets'))) await cp(join(projectDir, 'assets'), join(runtimeDir, 'assets'), { recursive: true });
    const projectedCli = join(daemonProjectionRoot, 'apps/cli');
    if (derivesDaemonProjections) {
      if (existsSync(join(projectedCli, 'assets'))) await cp(join(projectedCli, 'assets'), join(runtimeDir, 'assets'), { recursive: true });
      const failuresPath = join(runtimeDir, BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH);
      await mkdir(dirname(failuresPath), { recursive: true });
      await cp(join(projectedCli, BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH), failuresPath);
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
          if ((buildsProcessCustody && /^happier-process-custody(?:\.exe)?$/.test(tool.name))
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
          const { stageProcessCustodyRuntime } = await import(pathToFileURL(ownerPath).href);
          const { executablePath } = await stageProcessCustodyRuntime({ repoRoot: preparationDir, payloadDir: runtimeDir, target, runCommand });
          retainedCodeFiles.push(executablePath);
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
      } finally { await rm(preparationDir, { recursive: true, force: true }); }
    } else await linkInstalledDirectory(join(installedProjectDir, 'tools'), join(runtimeDir, 'tools'));
    const assets = join(projectDir, 'src/plugins/projection/registry/static-assets');
    if (existsSync(assets)) await cp(assets, join(runtimeDir, 'package-dist/plugins/projection/registry/static-assets'), { recursive: true });
  } else {
    await linkInstalledDirectory(join(installedProjectDir, 'generated'), join(runtimeDir, 'generated'));
    if (existsSync(join(projectDir, 'sources/app/account/profile/render/publicProfileFonts.ts'))) {
      const { stagePublicProfileAssets } = await import('../../../server/scripts/buildPublicProfileRenderer.mjs');
      retainedCodeFiles.push(...await stagePublicProfileAssets({ projectDir, outDir: runtimeDir }));
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
  const distInputs = Object.keys(result.metafile.inputs).filter(file => isFirstPartyBuiltInput(file, workspacePackages));
  if (distInputs.length) throw new Error(`Source runtime consumed first-party built code: ${distInputs.join(', ')}`);
  const externalFirstParty = Object.values(result.metafile.outputs).flatMap((out) => out.imports)
    .filter((item) => item.external && (item.path.startsWith('@happier-dev/') || workspacePackages.has(packageNameOfSpecifier(item.path))));
  if (externalFirstParty.length) throw new Error(`Source runtime left first-party code external: ${externalFirstParty.map((item) => item.path).join(', ')}`);
  await writeFile(join(runtimeDir, 'metafile.json'), JSON.stringify(result.metafile));
  const hash = createHash('sha256');
  for (const absolute of retainedCodeFiles.sort()) {
    hash.update(relative(runtimeDir, absolute));
    hash.update(await readFile(absolute));
  }
  const identity = hash.digest('hex').slice(0, 16);
  const entrypoint = join(runtimeDir, component === 'daemon' ? 'src/index.mjs' : 'sources/main.mjs');
  // Only installed external imports remain mutable after source emission. Keep
  // the full installation publication for finite build/reload admission, while
  // launch demand compares the closure this retained CLI actually imports.
  // Unbundled sidecars keep relative imports to their retained siblings; those
  // files already participate in the bundle identity above, not the install.
  const runtimeImports = component === 'daemon' ? [...new Map(Object.values(result.metafile.outputs)
    .flatMap(output => output.imports).filter(item => item.external && !item.path.startsWith('.'))
    .map(item => {
      const entry = { path: item.path, resolveFrom: join(sourceRepoDir, 'apps/cli/package.json') };
      return [JSON.stringify(entry), entry];
    })).values()] : null;
  const runtimeDependencyClosure = runtimeImports ? { imports: runtimeImports,
    identity: readSourceRuntimeDependencyIdentity({ imports: runtimeImports, signal }) } : null;
  return {
    identity, entrypoint, runtimeCommand: entrypoint, args: [], runtimeDir, sourceInputDigests,
    ...(runtimeDependencyClosure ? { runtimeDependencyClosure } : {}),
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
}
