import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { WORKSPACE_BUILD_MODE_ENV, resolveWorkspaceBuildMode } from '../../../scripts/workspaces/workspaceChildBuildEnv.mjs';
import { buildHostedHtmlGuestBootstrap } from '../../../packages/plugin-sdk/scripts/buildHostedHtmlGuestBootstrap.mjs';

import {
  ensureWorkspacePackagesBuiltForComponent as ensureWorkspacePackagesBuiltForComponentDefault,
  syncSharedDepsForSourceDev as syncSharedDepsForSourceDevDefault,
} from '../../stack/scripts/utils/proc/pm.mjs';
import { verifyUiPatchedDependencies } from '../tools/postinstall/verifyReactNativeEnrichedMarkdownWebStreamingPatch.mjs';
export { verifyUiPatchedDependencies } from '../tools/postinstall/verifyReactNativeEnrichedMarkdownWebStreamingPatch.mjs';
export { retainBundledPluginUiArtifactsInventory } from './generateBundledPluginUiArtifacts.mjs';
import {
  generateBundledPluginUiArtifacts as generateBundledPluginUiArtifactsDefault,
  resolveBundledPluginUiArtifactsOutputPath,
  resolveBundledPluginUiArtifactsInputPaths,
  retainBundledPluginUiArtifactsInventory,
} from './generateBundledPluginUiArtifacts.mjs';

const uiDir = dirname(dirname(fileURLToPath(import.meta.url)));

function isWithin(root, path) {
  const suffix = relative(root, path);
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

async function waitForMetroPluginUiInventory({ metroServer, metroConfig, inventoryPath, artifactStoreDir, signal }) {
  const paths = resolveBundledPluginUiArtifactsInputPaths(inventoryPath)?.slice(1);
  if (!paths) throw new Error(`Invalid source Plugin UI inventory: ${inventoryPath}`);
  const roots = [metroConfig.projectRoot, ...metroServer.getWatchFolders()];
  const realRoots = await Promise.all(roots.map(root => realpath(root)));
  const blockList = [metroConfig.resolver.blacklistRE || metroConfig.resolver.blockList].flat().filter(Boolean);
  const extensions = new Set([...metroConfig.resolver.sourceExts, ...metroConfig.resolver.assetExts,
    ...metroConfig.watcher.additionalExts]);
  for (const path of paths) {
    let reason;
    if (artifactStoreDir && !isWithin(artifactStoreDir, path)) reason = 'outside the consumer artifact store';
    else if (!roots.some(root => isWithin(root, path))) reason = 'outside Metro projectRoot/watchFolders';
    else if (blockList.some(pattern => pattern.test(path))) reason = 'excluded by Metro resolver.blockList';
    else if (!extensions.has(extname(path).slice(1))) reason = 'extension is not indexed by Metro';
    if (!reason) {
      try {
        const target = await realpath(path);
        if (!(await stat(target)).isFile()) reason = 'asset is not a regular file';
        else if (!realRoots.some(root => isWithin(root, target))) reason = `real path is outside Metro projectRoot/watchFolders: ${target}`;
        else if (blockList.some(pattern => pattern.test(target))) reason = `real path is excluded by Metro resolver.blockList: ${target}`;
        else if (!extensions.has(extname(target).slice(1))) reason = `real path extension is not indexed by Metro: ${target}`;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        reason = 'asset does not exist';
      }
    }
    if (reason) throw Object.assign(new Error(`Source Plugin UI inventory ${inventoryPath} cannot index ${path}: ${reason}`),
      { code: 'plugin_ui_inventory_unindexable' });
  }
  const graph = await metroServer.getBundler().getBundler().getDependencyGraph();
  signal?.throwIfAborted();
  await new Promise((resolveReady, reject) => {
    const finish = error => {
      graph.off('change', check);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolveReady();
    };
    const check = () => { if (paths.every(path => graph.doesFileExist(path))) finish(); };
    const abort = () => finish(signal.reason);
    graph.on('change', check);
    signal?.addEventListener('abort', abort, { once: true });
    check();
  });
}

export async function prepareUiSourcePluginInventory({ uiPackageDir = uiDir, env = process.env, signal, metroServer, metroConfig } = {}) {
  const repoRoot = resolve(uiPackageDir, '../..');
  const { prepareSourcePluginUiInventory } = await import('../../stack/scripts/build/build_source_web_ui.mjs');
  const requestedInventory = String(env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY ?? '').trim();
  if (requestedInventory && !isAbsolute(requestedInventory)) {
    throw new Error('HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY must be an absolute path');
  }
  const parent = requestedInventory ? dirname(requestedInventory) : resolve(uiPackageDir, '.expo/hstack/plugin-ui-inputs');
  await mkdir(parent, { recursive: true });
  // Compiler scratch has no serving consumer. Only verified content-addressed
  // assets outlive this call; older browser/native asset URLs still need them.
  // Metro already excludes this canonical staging prefix at its crawl boundary;
  // otherwise deleting finished scratch races the fallback watcher's descent.
  const outputDir = await mkdtemp(resolve(parent, '.happier-plugin-ui-stage-'));
  const outputPath = requestedInventory || resolve(parent, 'inventory.js');
  const candidatePath = resolve(outputDir, 'inputs/inventory.js');
  const artifactStoreDir = resolve(parent, 'artifacts');
  try {
    // The fallback watcher's initial enumeration registers existing files but
    // does not emit additions. Do not publish between Metro's crawl and watch.
    if (metroServer) await metroServer.getBundler().getBundler().getDependencyGraph();
    signal?.throwIfAborted();
    await prepareSourcePluginUiInventory({ repoDir: repoRoot, outputDir, inventoryPath: candidatePath,
      retainedInventoryPath: outputPath, artifactStoreDir, env, signal });
    if (metroServer) await waitForMetroPluginUiInventory({ metroServer, metroConfig,
      inventoryPath: candidatePath, artifactStoreDir, signal });
    signal?.throwIfAborted();
    const candidate = await readFile(candidatePath, 'utf8');
    const current = await readFile(outputPath, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (candidate !== current && !await retainBundledPluginUiArtifactsInventory({ inventoryPath: candidatePath, outputPath })) {
      throw new Error('Source Plugin UI preparation produced an invalid inventory');
    }
    return { ok: true, built: [], skipped: [], outputPath };
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

/** Consume Metro's already-batched changes; do not create another file watcher
 * or debounce clock. The canonical compiler reuses unchanged plugin entries. */
export function watchUiSourcePluginInventory({ metroServer, metroConfig, uiPackageDir = uiDir, env = process.env, logger = console }) {
  env = { ...env };
  const inventoryPath = String(env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY ?? '').trim();
  const repoRoot = resolve(uiPackageDir, '../..');
  const watcher = metroServer.getBundler().getBundler().getWatcher();
  const cancellation = new AbortController();
  let closed = false;
  let queued = false;
  let pending = Promise.resolve();
  let inputsPromise;
  const report = error => { if (!closed) logger.error('[plugin-ui] source inventory refresh failed:', error); };
  const inputs = () => inputsPromise ??= (async () => {
    const { readWorkspacePackages } = await import('../../../packages/cli-common/sourceRuntimeEntries.mjs');
    const { readSourcePluginUiBuildInputs } = await import('../../stack/scripts/utils/fs/workspaceBuildInputs.mjs');
    const packages = await readWorkspacePackages(repoRoot);
    const cli = JSON.parse(await readFile(resolve(repoRoot, 'apps/cli/package.json'), 'utf8'));
    const groups = await Promise.all([
      readSourcePluginUiBuildInputs({ repoDir: repoRoot, compiler: true, packages, includeDirectories: true }),
      ...(cli.bundledDependencies ?? []).filter(name => name.startsWith('@happier-dev/plugins-'))
        .map(name => readSourcePluginUiBuildInputs({ repoDir: repoRoot,
          pluginDirectory: name.slice('@happier-dev/plugins-'.length), packages, includeDirectories: true })),
    ]);
    return new Set([...groups.flat(), 'apps/cli/package.json', 'apps/ui/package.json'].map(path => resolve(repoRoot, path)));
  })().catch(error => { inputsPromise = null; throw error; });
  const onChange = ({ eventsQueue }) => {
    void inputs().then(async paths => {
      const { isWorkspaceBuildInputIgnoredPath } = await import('../../stack/scripts/utils/fs/workspaceBuildInputs.mjs');
      const changed = eventsQueue.some(({ filePath }) => {
        let path = resolve(filePath);
        if (paths.has(path)) return true;
        if (isWorkspaceBuildInputIgnoredPath(relative(repoRoot, path))) return false;
        while (dirname(path) !== path) {
          path = dirname(path);
          if (paths.has(path)) return true;
        }
        return false;
      });
      if (closed || !changed || queued) return;
      queued = true;
      pending = pending.then(async () => {
        queued = false;
        if (closed) return;
        await prepareUiSourcePluginInventory({ uiPackageDir, env, signal: cancellation.signal, metroServer, metroConfig });
        inputsPromise = null;
      }).catch(report);
    }).catch(report);
  };
  watcher.on('change', onChange);
  void inputs().catch(report);
  return { async ready() {
    // A one-shot preparer or warm-start parent can publish outside this process.
    // Bundle/asset admission consumes the same file-map readiness as live refresh.
    await waitForMetroPluginUiInventory({ metroServer, metroConfig,
      inventoryPath, signal: cancellation.signal });
  }, async close() {
    closed = true;
    watcher.off('change', onChange);
    cancellation.abort();
    await pending;
  } };
}

export async function publishBundledPluginProjectionWithFailures({ repoRoot, env, pluginFailures, publicationMode = 'live' }) {
  const { runCanonicalBundledPluginArtifactPublisher } = await import('../../cli/scripts/buildSharedDeps.mjs');
  await runCanonicalBundledPluginArtifactPublisher({
    repoRoot,
    env,
    mode: 'write',
    publicationMode,
    pluginFailures,
    // Failure admission updates the existing scoped inventory; it cannot replace
    // the complete shared Agent projection with an incomplete package set.
    ...(publicationMode === 'live' && pluginFailures.length > 0 ? {
      workspaceNames: pluginFailures.map((failure) => failure.packageName.replace(/^@happier-dev\//, '')),
      targetOwnedOnly: String(env?.HAPPIER_DEV_TARGET_EXECUTION ?? '').trim() === '1',
    } : {}),
  });
}

export function resolveUiWorkspaceStartupOutputs({
  uiPackageDir = uiDir,
  env = process.env,
} = {}) {
  const repoRoot = resolve(uiPackageDir, '../..');
  const inventoryPath = env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY || resolveBundledPluginUiArtifactsOutputPath(repoRoot);
  return resolveBundledPluginUiArtifactsInputPaths(inventoryPath) ?? [];
}

function readRebuiltBundledPluginWorkspaceNames(result) {
  const out = [];
  const seen = new Set();
  for (const rawPackageName of Array.isArray(result?.built) ? result.built : []) {
    if (typeof rawPackageName !== 'string') continue;
    const workspaceName = rawPackageName.trim().replace(/^@happier-dev\//, '');
    if (!workspaceName.startsWith('plugins-') || seen.has(workspaceName)) continue;
    seen.add(workspaceName);
    out.push(workspaceName);
  }
  return out;
}

export async function ensureUiWorkspacePackagesBuilt({
  env = process.env,
  publicationMode = 'live',
  uiPackageDir = uiDir,
  source = false,
  ensureWorkspacePackagesBuiltForComponent = ensureWorkspacePackagesBuiltForComponentDefault,
  syncSharedDepsForSourceDev = syncSharedDepsForSourceDevDefault,
  generateBundledPluginUiArtifacts = generateBundledPluginUiArtifactsDefault,
  publishBundledPluginProjectionWithFailuresImpl = publishBundledPluginProjectionWithFailures,
  verifyPatchedDependencies = verifyUiPatchedDependencies,
} = {}) {
  const repoRoot = resolve(uiPackageDir, '../..');
  if (publicationMode !== 'live' && publicationMode !== 'artifact') {
    throw new Error(`Unknown UI workspace publication mode: ${publicationMode}`);
  }
  env = { ...env, [WORKSPACE_BUILD_MODE_ENV]: resolveWorkspaceBuildMode({
    env,
    buildMode: publicationMode === 'artifact' ? 'strict' : env[WORKSPACE_BUILD_MODE_ENV] ?? 'source-dev',
  }) };
  verifyPatchedDependencies({ uiPackageDir });
  await buildHostedHtmlGuestBootstrap({
    packageRoot: resolve(repoRoot, 'packages/plugin-sdk'),
    outputFile: resolve(uiPackageDir, 'sources/components/plugins/hostedWeb/guestBootstrap.generated.ts'),
  });
  if (source) {
    if (publicationMode !== 'live') throw new Error('Source Expo preparation cannot publish package artifacts');
    // Source worker compilation owns freshness and retained outputs separately
    // from installed dependency admission.
    const { resolveUiPostinstallTasks } = await import('../tools/resolveUiPostinstallTasks.mjs');
    const tasks = resolveUiPostinstallTasks({ env });
    const retainLastGreen = env[WORKSPACE_BUILD_MODE_ENV] !== 'strict';
    const { buildPasswordKdfWorker } = await import('../tools/password/buildPasswordKdfWorker.mjs');
    const { buildCryptoWorker } = await import('../tools/crypto/buildCryptoWorker.mjs');
    const { buildAtmosphereRenderers } = await import('../tools/atmosphere/buildAtmosphereRenderers.mjs');
    if (tasks.includes('vendor-password-kdf-worker')) await buildPasswordKdfWorker({ uiDirectory: uiPackageDir, retainLastGreen });
    if (tasks.includes('vendor-crypto-worker')) await buildCryptoWorker({ uiDirectory: uiPackageDir, retainLastGreen });
    if (tasks.includes('prepare-atmosphere-renderers')) await buildAtmosphereRenderers({ uiDirectory: uiPackageDir,
      web: tasks.includes('vendor-password-kdf-worker'), retainLastGreen });
    const { buildUiSourceAsset } = await import('../tools/sourceAsset.mjs');
    if (tasks.includes('vendor-tiptap-webview-bundle')) {
      const { buildTiptapWebViewBundle } = await import('../tools/tiptap/buildTiptapWebViewBundle.mjs');
      await buildUiSourceAsset({ retainLastGreen,
        outputs: [resolve(uiPackageDir, 'sources/components/ui/markdown/editor/bridge/tiptapWebViewBundle.generated.ts')],
        build: () => buildTiptapWebViewBundle({ expoAppDir: uiPackageDir, repoRootDir: repoRoot }) });
    }
    if (tasks.includes('vendor-mermaid-webview-bundle')) {
      const { buildMermaidWebViewBundle } = await import('../tools/mermaid/buildMermaidWebViewBundle.mjs');
      await buildUiSourceAsset({ retainLastGreen,
        outputs: [resolve(uiPackageDir, 'sources/components/markdown/mermaidWebViewBundle.generated.ts')],
        build: () => buildMermaidWebViewBundle({ expoAppDir: uiPackageDir }) });
    }
    if (tasks.includes('vendor-pdfjs-webview-bundle')) {
      const { buildPdfjsWebViewBundle } = await import('../tools/pdfjs/buildPdfjsWebViewBundle.mjs');
      await buildUiSourceAsset({ retainLastGreen,
        outputs: [resolve(uiPackageDir, 'sources/components/ui/media/pdf/pdfjsWebViewBundle.generated.ts')],
        build: () => buildPdfjsWebViewBundle({ expoAppDir: uiPackageDir }) });
    }
    return await prepareUiSourcePluginInventory({ uiPackageDir, env });
  }
  const result = await ensureWorkspacePackagesBuiltForComponent(uiPackageDir, {
    quiet: false,
    env,
    publicationMode,
    isolatePluginFailures: publicationMode === 'live',
  });
  const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
  if (skipped.includes('not-monorepo')) {
    throw new Error('[ui] ensure:workspace:built failed (not-monorepo): apps/ui must be run from inside the Happier monorepo checkout.');
  }
  const rebuiltPluginWorkspaceNames = readRebuiltBundledPluginWorkspaceNames(result);
  if (publicationMode === 'artifact' && result.pluginFailures?.length > 0) {
    throw new Error(`UI artifact publication failed for ${result.pluginFailures.map((failure) => failure.packageName).join(', ')}`);
  }
  if (rebuiltPluginWorkspaceNames.length > 0 || result.pluginFailures?.length > 0) {
    // Expo adoption happens after this preflight returns. Feed the canonical
    // publisher only E2's actual rebuilt plugin set so it validates and
    // publishes one matching registry/artifact pair before Expo can resolve
    // those new package bytes.
    if (publicationMode === 'artifact') {
      await publishBundledPluginProjectionWithFailuresImpl({ repoRoot, env, pluginFailures: [], publicationMode });
    } else await syncSharedDepsForSourceDev(repoRoot, {
      env,
      includeRuntimeDependencies: true,
      quiet: false,
      workspaceNames: rebuiltPluginWorkspaceNames,
      ...(result.pluginFailures?.length ? { pluginFailures: result.pluginFailures } : {}),
    });
  }
  const uiArtifacts = await generateBundledPluginUiArtifacts({
    repoRoot,
    mode: 'write',
    publicationMode,
    ...(result.pluginFailures?.length ? { pluginFailures: result.pluginFailures } : {}),
  });
  const inheritedFailures = result.pluginFailures ?? [];
  if (publicationMode === 'artifact' && (uiArtifacts?.pluginFailures?.length ?? 0) > 0) {
    throw new Error(`UI artifact publication failed for ${uiArtifacts.pluginFailures.map((failure) => failure.packageName).join(', ')}`);
  }
  const newlyFailedUiPlugins = (uiArtifacts?.pluginFailures ?? []).filter((failure) => (
    !inheritedFailures.some((inherited) => inherited.packageName === failure.packageName)
  ));
  if (newlyFailedUiPlugins.length > 0) {
    // The artifact reader runs after installed package publication. Reproject
    // every generated consumer, not only the manifest-only aggregate, before
    // the UI bundle can load static plugin imports.
    await publishBundledPluginProjectionWithFailuresImpl({
      repoRoot,
      env,
      pluginFailures: [...inheritedFailures, ...newlyFailedUiPlugins],
    });
  }
  return result;
}

async function run() {
  const expoIndex = process.argv.indexOf('--expo');
  if (expoIndex !== -1) {
    const { expoExec } = await import('../../stack/scripts/utils/expo/command.mjs');
    await expoExec({ dir: uiDir, args: process.argv.slice(expoIndex + 1), env: process.env });
    return;
  }
  await ensureUiWorkspacePackagesBuilt({
    publicationMode: process.argv.includes('--artifact') ? 'artifact' : 'live',
    source: !process.argv.includes('--artifact'),
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
