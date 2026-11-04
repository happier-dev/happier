import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

import { captureSourceWebBuildInputs, readWorkspacePackages, resolveWorkspaceSource,
  sourceBundleBuildLockPath, setBundleReadOnly, withSourceBundlePublication } from './build_source_runtime.mjs';
import { resolveExpoBin, prepareExpoCommandEnv } from '../utils/expo/command.mjs';
import { applyExpoNodeHeapEnv } from '../utils/expo/expoNodeHeapEnv.mjs';
import { run } from '../utils/proc/proc.mjs';
import { runSourceBuildCommand } from '../utils/proc/runSourceBuildCommand.mjs';
import { prepareSourceComponent } from '../utils/dev/devReloadCoordinator.mjs';
import { buildStackWebExportEnv } from '../utils/ui/ui_export_env.mjs';
import { assertWebArtifactPayload } from '../runtime/shared/web_payload.mjs';
import { precompressUiWebAssets } from './precompress_ui_web_assets.mjs';
import { listBundledPluginUiArtifactExports } from '../../../ui/scripts/generateBundledPluginUiArtifacts.mjs';
import { buildIntoTempThenReplace } from '../utils/fs/atomic_dir_swap.mjs';
import { readSourceComponentBuildInputs } from '../utils/fs/workspaceBuildInputs.mjs';
import { readBuildInputIdentity, withBuildInputDependencies } from '../../../../scripts/workspaces/buildInputConvergence.mjs';
import { runWorkspaceBuildAdmission } from '../utils/proc/workspace_build_admission.mjs';
import { retainPendingSourcePreparation, updatePendingSourcePreparationPhase } from '../runtime/shared/pending_source_start.mjs';
import { readJsonIfExists } from '../utils/fs/json.mjs';
import { readCachedFileDigest } from '../utils/fs/cached_file_digest.mjs';
import { sourceWebExportArgs } from './sourceWebExportArgs.mjs';
import { withJsonOwnerFileLock } from '../utils/proc/jsonOwnerFileLock.mjs';
import { SOURCE_WEB_EXPORT_ADMISSION_CLASS } from '../utils/dev_targets/remote_commands.mjs';

/** Stack starts reuse completed account-free exports through source publication.
 * Explicit outputDir callers keep their private finite producer boundary, used
 * by artifact preparation and older path-based web reloads. */
export async function exportSourceWebUi({ repoDir, baseDir, outputDir, stackBaseDir, pending,
  replaceUiDir = null, env = process.env, signal = pending?.signal, runImpl }) {
  if (stackBaseDir && !pending?.requestId) throw new Error('[source-ui] shared export requires its pending Stack start');
  const preparationStackBaseDir = stackBaseDir;
  await pending?.setPhase({ phase: 'preparing', component: 'ui' });
  // An explicit executable app-local module can consume files outside the
  // authored capture. Preserve that path, without claiming shared reuse proof.
  if (stackBaseDir && String(env.EXPO_APP_LOCAL_CONFIG_PATH ?? '').trim()) {
    await withSourceBundlePublication({ stackBaseDir, signal }, async () => {
      await mkdir(baseDir, { recursive: true });
      outputDir ??= join(await mkdtemp(join(baseDir, 'bundle-web-')), 'export');
      await pending.retainPreparation(dirname(outputDir));
    });
    stackBaseDir = null;
  }
  if (stackBaseDir) {
    const built = await prepareSourceWebComponent({ repoDir, env, signal,
      prepare: () => exportSharedSourceWebUi({ repoDir, baseDir, stackBaseDir, requestId: pending.requestId, env, signal }) });
    await pending.setPhase({ phase: 'prepared', component: 'ui' });
    return built;
  }
  let createdOutput = false;
  const built = await prepareSourceWebComponent({ repoDir, env, signal,
    prepare: async () => {
      // This call's private partial export is never selected or served. A retry
      // must rerun preparation in an empty directory, preserving EEXIST for a
      // directory that predated this call.
      if (createdOutput) await rm(outputDir, { recursive: true, force: true });
      await mkdir(dirname(outputDir), { recursive: true });
      await mkdir(outputDir);
      createdOutput = true;
      await pending?.setPhase({ phase: 'queued', component: 'ui' });
      const built = await exportSourceWebUiOnce({ repoDir, baseDir, outputDir, env, signal, runImpl,
        preparationStackBaseDir, requestId: pending?.requestId });
      if (!replaceUiDir) return built;
      signal?.throwIfAborted();
      // The running server retains this path. Publish only validated output
      // through the existing directory-swap owner after preparation succeeds.
      await buildIntoTempThenReplace(replaceUiDir, async stagedDir => {
        await cp(built.uiDir, stagedDir, { recursive: true });
      });
      return { ...built, uiDir: replaceUiDir };
    } });
  await pending?.setPhase({ phase: 'prepared', component: 'ui' });
  return built;
}

/** A running server retains one Stack-owned path. Change its link, never the
 * immutable shared export (which another Stack may still serve). */
export async function publishSourceWebUi({ built, uiDir, pending }) {
  const exportDir = await realpath(built.exportDir ?? built.uiDir);
  await assertWebArtifactPayload({ payloadDir: exportDir, entrypoint: built.entrypoint ?? 'index.html' });
  await pending.retainPreparation(exportDir);
  return await pending.publishPreparation(async () => {
    await mkdir(dirname(uiDir), { recursive: true });
    await buildIntoTempThenReplace(uiDir, async stagedDir => {
      await rm(stagedDir, { recursive: true });
      await symlink(exportDir, stagedDir, process.platform === 'win32' ? 'junction' : 'dir');
    });
    return { ...built, uiDir, exportDir };
  });
}

function sourceWebExportEnv(env) {
  return { ...buildStackWebExportEnv({ baseEnv: env,
    enableDebugRoutes: env.EXPO_PUBLIC_DEBUG === undefined || env.EXPO_PUBLIC_DEBUG === '1' }), CI: '1' };
}

async function sourceWebBuildOptions({ repoDir, env }) {
  const effective = sourceWebExportEnv(env);
  const options = Object.entries(effective).filter(([key]) =>
    /^(?:EXPO_|HAPPIER_UI_|HAPPIER_APP_|HAPPIER_EXPO_|HAPPIER_TERMINAL_NATIVE_|HAPPIER_ANDROID_|HAPPY_STACKS_|EAS_)/.test(key)
    || ['APP_ENV', 'NODE_ENV', 'BABEL_ENV', 'CI', 'EX_UPDATES_NATIVE_DEBUG', 'HAPPIER_ENABLE_TERMINAL_NATIVE', 'HAPPIER_SYNC_TUNING_JSON'].includes(key))
    .filter(([key]) => key !== 'HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY')
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256').update(JSON.stringify([process.version, process.platform, process.arch, options,
    // Worker fanout is execution policy, not bundle content. Lookup happens
    // before admission and must not need or hash a job's transient CPU budget.
    sourceWebExportArgs({ ...effective, HAPPIER_STACK_EXPO_EXPORT_MAX_WORKERS: '0' })]))
    .digest('hex');
}

async function sourceWebInputIdentity({ repoDir }) {
  const { files } = await readSourceComponentBuildInputs({ repoDir, component: 'expo' });
  return await readBuildInputIdentity({ sourceDir: repoDir, files });
}

async function prepareSourceWebComponent({ repoDir, env, signal, prepare }) {
  return await prepareSourceComponent({ repoDir, target: 'expo', env, signal, prepare: async () => {
    const before = await sourceWebInputIdentity({ repoDir });
    try {
      return await prepare();
    } catch (error) {
      // Diagnostics alone cannot distinguish a missing watch root from source
      // churn. Reuse the canonical input-byte identity for this attempt, across
      // both private and shared subprocess exports, before deciding to retry.
      error.sourceDrift = !signal?.aborted && !error.signal
        && before !== await sourceWebInputIdentity({ repoDir });
      throw error;
    }
  } });
}

async function webOutputDigests(directory, prefix = '') {
  const digests = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(digests, await webOutputDigests(path, key));
    else if (entry.isFile()) {
      const digest = await readCachedFileDigest(path, await lstat(path, { bigint: true }));
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`[source-ui] exported asset is unreadable: ${key}`);
      digests[key] = digest;
    }
    else throw new Error('[source-ui] web output must contain only exported files and directories');
  }
  return Object.fromEntries(Object.entries(digests).sort(([left], [right]) => left.localeCompare(right)));
}

async function readReusableSourceWebUi({ repoDir, bundleRoot, buildOptions }) {
  const inputIdentity = await sourceWebInputIdentity({ repoDir });
  const entries = await readdir(bundleRoot, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return []; throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('web-')) continue;
    const outputDir = join(bundleRoot, entry.name);
    const record = await readJsonIfExists(join(outputDir, 'source-bundle.json'));
    if (record?.component !== 'web' || record.inputIdentity !== inputIdentity || record.buildOptions !== buildOptions
      || record.uiDir !== join(outputDir, 'web') || !record.outputDigests) continue;
    try {
      await assertWebArtifactPayload({ payloadDir: record.uiDir, entrypoint: 'index.html' });
      if (JSON.stringify(await webOutputDigests(record.uiDir)) !== JSON.stringify(record.outputDigests)) continue;
    } catch (error) {
      if (error.code && !['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      continue;
    }
    return { outputDir, built: { uiDir: record.uiDir, entrypoint: 'index.html', runtimeMode: 'source' } };
  }
  return null;
}

async function pinSourceWebUi({ stackBaseDir, requestId, outputDir, signal }) {
  await retainPendingSourcePreparation({ stackBaseDir, requestId, preparationDir: outputDir, signal });
}

async function exportSharedSourceWebUi({ repoDir, baseDir, stackBaseDir, requestId, env, signal }) {
  repoDir = resolve(repoDir);
  stackBaseDir = resolve(stackBaseDir);
  const bundleRoot = join(dirname(stackBaseDir), 'source-bundles');
  const buildOptions = await sourceWebBuildOptions({ repoDir, env });
  const inputs = { repoDir, baseDir, stackBaseDir, requestId, buildOptions };
  await updatePendingSourcePreparationPhase({ stackBaseDir, requestId, phase: 'queued', component: 'ui', signal });
  // Lookup and pending retention share publication custody, without capacity
  // reservation or a producer lease on a completed hit.
  const cached = await withSourceBundlePublication({ stackBaseDir, signal }, async () => {
    const reusable = await readReusableSourceWebUi({ repoDir, bundleRoot, buildOptions });
    if (!reusable) return null;
    await pinSourceWebUi({ stackBaseDir, requestId, outputDir: reusable.outputDir, signal });
    return reusable.built;
  });
  if (cached) return cached;
  await updatePendingSourcePreparationPhase({ stackBaseDir, requestId, phase: 'preparing', component: 'ui', signal });
  const fingerprint = createHash('sha256').update(await sourceWebInputIdentity({ repoDir })).update(buildOptions).digest('hex');
  const lockPath = sourceBundleBuildLockPath(bundleRoot, fingerprint);
  await updatePendingSourcePreparationPhase({ stackBaseDir, requestId, phase: 'queued', component: 'ui', signal });
  const result = await runWorkspaceBuildAdmission({ repoDir, dependencyInstallDir: repoDir,
    launcherPath: fileURLToPath(new URL('../../bin/hstack-exec', import.meta.url)),
    command: process.execPath, args: [fileURLToPath(import.meta.url), JSON.stringify({ ...inputs, fingerprint, shared: true })],
    locks: [{ path: lockPath, kind: 'workspace', timeoutMs: null, errorLabel: 'source-web build lock' }],
    env, signal, cwd: repoDir, admissionClass: SOURCE_WEB_EXPORT_ADMISSION_CLASS, stdio: ['ignore', 'pipe', 'pipe'],
    onStderr: chunk => process.stderr.write(chunk) });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`Source web preparation failed (${result.signal ? `signal ${result.signal}` : `exit ${result.status}`})\n${result.stderr}`);
    error.code = result.status;
    error.signal = result.signal;
    throw error;
  }
  signal?.throwIfAborted();
  return JSON.parse(result.stdout);
}

async function prepareSharedSourceWebUi({ repoDir, baseDir, stackBaseDir, requestId, buildOptions, fingerprint, env, signal }) {
  const bundleRoot = join(dirname(stackBaseDir), 'source-bundles');
  const cached = await withSourceBundlePublication({ stackBaseDir, signal }, async () => {
    const reusable = await readReusableSourceWebUi({ repoDir, bundleRoot, buildOptions });
    if (!reusable) return null;
    await pinSourceWebUi({ stackBaseDir, requestId, outputDir: reusable.outputDir, signal });
    return reusable.built;
  });
  if (cached) return cached;
  await mkdir(bundleRoot, { recursive: true });
  await updatePendingSourcePreparationPhase({ stackBaseDir, requestId, phase: 'building', component: 'ui', signal });
  // Already-loaded runtime retainers enumerate bundle-* without knowing web
  // serving references. Keep web allocations out of that runtime namespace;
  // the shared publication owner still governs both products' custody.
  const outputDir = await mkdtemp(join(bundleRoot, `web-${fingerprint}-`));
  try {
    const { built, captured } = await withBuildInputDependencies({ sourceDir: repoDir, env, signal }, env =>
      consumeSourceWebUiInputs({ repoDir, baseDir, outputDir, env, signal }));
    // The shared product contains only its serving closure. Compiler candidates
    // belong to the export context; captured source has already been retired.
    const record = { ...built, component: 'web', inputIdentity: captured.inputIdentity, buildOptions,
      outputDigests: await webOutputDigests(built.uiDir), reuseFingerprint: fingerprint };
    return await withSourceBundlePublication({ stackBaseDir, outputDir, record, signal }, async () => {
      signal.throwIfAborted();
      await pinSourceWebUi({ stackBaseDir, requestId, outputDir, signal });
      return built;
    });
  } catch (error) {
    const remaining = await lstat(outputDir).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (remaining) {
      await setBundleReadOnly(outputDir, false);
      await rm(outputDir, { recursive: true, force: true });
    }
    throw error;
  }
}

async function exportSourceWebUiOnce({ repoDir, baseDir, outputDir, env, signal, runImpl, preparationStackBaseDir, requestId }) {
  if (!runImpl) {
    const stdout = await runSourceBuildCommand({ repoDir, scriptPath: fileURLToPath(import.meta.url),
      args: [JSON.stringify({ repoDir, baseDir, outputDir, privateExport: true, preparationStackBaseDir, requestId })], env, signal,
      admissionClass: SOURCE_WEB_EXPORT_ADMISSION_CLASS, captureStderr: true });
    return JSON.parse(stdout);
  }
  if (preparationStackBaseDir && requestId) await updatePendingSourcePreparationPhase({ stackBaseDir: preparationStackBaseDir,
    requestId, phase: 'building', component: 'ui', signal });
  const { built } = await withBuildInputDependencies({ sourceDir: repoDir, env, signal }, env =>
    consumeSourceWebUiInputs({ repoDir, baseDir, outputDir, env, signal, runImpl }));
  return built;
}

async function consumeSourceWebUiInputs({ repoDir, baseDir, outputDir, env, signal, runImpl }) {
  return await withSourceWebUiInputs({ repoDir, baseDir, env, signal }, async ({ captured, inventoryPath, uiProjectDir }) => {
    const built = await exportCapturedSourceWebUiInputs({ repoDir, baseDir, outputDir,
      inventoryPath, uiProjectDir, env, signal, runImpl });
    return { built, captured };
  });
}

/** Consume a fresh capture at one context-owned Metro root. Dependency custody
 * belongs to the containing finite producer; capture custody lasts until the
 * consumer has finished reading, while validated compiler candidates remain. */
export async function withSourceWebUiInputs({ repoDir, baseDir, env = process.env, signal,
  stdoutStream = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) ? process.stderr : process.stdout }, consume) {
  // Router embeds the captured project root in transforms. Keep that root and
  // the existing compiler's retained inventory stable for this export context,
  // while serving products remain private immutable outputs. Only one export
  // may replace this context's captured inputs until Metro has finished reading.
  const contextDir = resolve(baseDir, 'source-web');
  return await withJsonOwnerFileLock(async () => {
    const workspace = join(contextDir, 'workspace');
    await rm(workspace, { recursive: true, force: true });
    try {
      const captured = await captureSourceWebBuildInputs({ repoDir, outputDir: workspace, signal });
      await prepareSourcePluginUiInventory({ repoDir, inputRepoDir: captured.repoDir,
        outputDir: contextDir, env, signal, stdoutStream });
      return await consume({ captured, inventoryPath: join(contextDir, 'inputs/inventory.js'), uiProjectDir: captured.uiProjectDir });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, { lockPath: `${contextDir}.lock`, timeoutMs: Infinity, staleAfterMs: Infinity,
    signal, errorLabel: 'source-web capture lock' });
}

async function exportCapturedSourceWebUiInputs({ repoDir, baseDir, outputDir, inventoryPath, uiProjectDir, env, signal, runImpl }) {
  const { env: isolatedEnv } = await prepareExpoCommandEnv({
    baseDir, kind: 'source-web-export', projectDir: join(repoDir, 'apps/ui'),
    baseEnv: sourceWebExportEnv(env),
  });
  const exportEnv = applyExpoNodeHeapEnv({
    ...isolatedEnv, CI: '1', HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: inventoryPath,
  });
  const uiDir = resolve(outputDir, 'web');
  const exportStartedAt = performance.now();
  const expoCommand = await resolveExpoBin(join(repoDir, 'apps/ui'));
  const expoArgs = sourceWebExportArgs(exportEnv, uiDir);
  // The optional runner substitutes only the external Expo boundary in tests.
  // Real finite exports reuse their containing native envelope and dependency
  // custody; injected runners replace only the external Expo boundary.
  if (runImpl) await runImpl(expoCommand, expoArgs, { cwd: uiProjectDir, env: exportEnv, signal });
  else await runSourceBuildCommand({ repoDir, command: expoCommand, args: expoArgs,
    cwd: uiProjectDir, env: exportEnv, signal, captureStdout: false, captureStderr: true,
    admissionClass: SOURCE_WEB_EXPORT_ADMISSION_CLASS, stdoutStream: process.stderr });
  await assertWebArtifactPayload({ payloadDir: uiDir, entrypoint: 'index.html' });
  await precompressUiWebAssets({ dir: uiDir });
  console.log(`[source-ui] phase=web-export elapsedMs=${Math.round(performance.now() - exportStartedAt)}`);
  return { uiDir, entrypoint: 'index.html', runtimeMode: 'source' };
}

/** Live Metro and finite exports share source artifact construction. Only a
 * finite export captures inputs; interactive Expo intentionally reads live source. */
export async function prepareSourcePluginUiInventory({ repoDir, inputRepoDir = repoDir, outputDir, inventoryPath, retainedInventoryPath, artifactStoreDir, env = process.env, signal,
  stdoutStream = process.stdout, devStartup = false }) {
  await runSourceBuildCommand({ repoDir, scriptPath: fileURLToPath(import.meta.url),
    args: [JSON.stringify({ repoDir: inputRepoDir, outputDir, inventoryPath, retainedInventoryPath, artifactStoreDir })], env, signal, captureStdout: false, captureStderr: true, stdoutStream, devStartup });
}

async function prepareSourceWebUiInputs({ repoDir, outputDir, inventoryPath, retainedInventoryPath, artifactStoreDir }) {
  const uiProjectDir = join(repoDir, 'apps/ui');
  const packages = await readWorkspacePackages(repoDir);
  const uiPackage = JSON.parse(await readFile(join(uiProjectDir, 'package.json'), 'utf8'));
  const cliPackage = JSON.parse(await readFile(join(repoDir, 'apps/cli/package.json'), 'utf8'));
  // The canonical membership publisher owns this generated dependency census.
  // Brand-only packages need their manifests, without compiling unrelated UI.
  const bundledPackageNames = new Set(cliPackage.bundledDependencies);
  const plugins = [...packages].filter(([name]) => (
    name.startsWith('@happier-dev/plugins-') && bundledPackageNames.has(name)
  )).sort(([left], [right]) => left.localeCompare(right));
  const inputsDir = join(outputDir, 'inputs');
  await mkdir(inputsDir, { recursive: true });
  const toolsDir = join(outputDir, 'tools');
  await mkdir(toolsDir, { recursive: true });
  // The canonical source loader resolves each manifest on demand inside the
  // compiler's per-plugin failure boundary. A static aggregate import would
  // abort every plugin before that boundary on one malformed declaration.
  const preparationPath = join(toolsDir, 'prepare.mjs');
  const source = [
    `import { prepareSourcePluginUiArtifacts } from ${JSON.stringify(join(uiProjectDir, 'scripts/prepareSourcePluginUiArtifacts.mjs'))};`,
    `import { readWorkspacePackages, resolveWorkspaceSource } from ${JSON.stringify(join(repoDir, 'packages/cli-common/sourceRuntimeEntries.mjs'))};`,
    `import { pathToFileURL } from 'node:url';`,
    `const workspaces = await readWorkspacePackages(${JSON.stringify(repoDir)});`,
    `await prepareSourcePluginUiArtifacts({repoRoot:${JSON.stringify(repoDir)},outputDir:${JSON.stringify(inputsDir)},outputPath:${JSON.stringify(inventoryPath)},retainedInventoryPath:${JSON.stringify(retainedInventoryPath)},artifactStoreDir:${JSON.stringify(artifactStoreDir)},resolveSourceImport(specifier) { const name = specifier.split('/').slice(0,specifier.startsWith('@') ? 2 : 1).join('/'); if (workspaces.has(name) || specifier.startsWith('@happier-dev/')) return resolveWorkspaceSource(workspaces,specifier); },plugins:[${plugins.map(([name]) => (
      `{directory:${JSON.stringify(name.slice('@happier-dev/plugins-'.length))},loadManifest:async()=> (await import(pathToFileURL(resolveWorkspaceSource(workspaces,${JSON.stringify(`${name}/manifest`)})).href)).PLUGIN_MANIFEST,uiArtifacts:${Boolean(uiPackage.dependencies?.[name] && listBundledPluginUiArtifactExports(packages.get(name).manifest).length > 0)}}`
    )).join(',')}]});`,
  ].join('\n');
  await writeFile(preparationPath, source);
  const preparationStartedAt = performance.now();
  await run(process.execPath, ['--import', join(repoDir, 'packages/cli-common/registerSourceRuntime.mjs'), preparationPath],
    { cwd: uiProjectDir, env: process.env });
  console.log(`[source-ui] phase=plugin-ui-preparation elapsedMs=${Math.round(performance.now() - preparationStartedAt)} plugins=${plugins.length}`);
}

// Finite preparation and Expo reuse one containing native admission envelope.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = JSON.parse(process.argv[2]);
  if (options.shared || options.privateExport) {
    const cancellation = new AbortController();
    const interrupt = () => cancellation.abort();
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    console.log = console.error;
    try {
      if (options.privateExport && options.preparationStackBaseDir && options.requestId) {
        await updatePendingSourcePreparationPhase({ stackBaseDir: options.preparationStackBaseDir,
          requestId: options.requestId, phase: 'building', component: 'ui', signal: cancellation.signal });
      }
      const built = options.shared
        ? await prepareSharedSourceWebUi({ ...options, env: process.env, signal: cancellation.signal })
        : (await withBuildInputDependencies({ sourceDir: options.repoDir, env: process.env, signal: cancellation.signal }, env =>
          consumeSourceWebUiInputs({ ...options, env, signal: cancellation.signal }))).built;
      process.stdout.write(JSON.stringify(built));
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
  } else await prepareSourceWebUiInputs(options);
}
