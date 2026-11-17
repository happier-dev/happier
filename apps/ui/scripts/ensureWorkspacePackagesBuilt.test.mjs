// @happier-test-preparation source-condition
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { resolveDependencyRefreshLockPath } from '../../stack/scripts/utils/proc/dependency_refresh.mjs';
import { computeSourceDevSharedDepsSignature } from '../../cli/scripts/buildSharedDeps.mjs';
import { resolveBundledPluginUiArtifactsOutputPath } from './generateBundledPluginUiArtifacts.mjs';
import { captureSourceWebBuildInputs } from '../../stack/scripts/build/build_source_runtime.mjs';
import { createTempFixture } from '../../stack/scripts/testkit/core/temp_fixture.mjs';
import { runNodeCapture } from '../../stack/scripts/testkit/core/run_node_capture.mjs';
import { sourceBuildNodeArgs } from '../../stack/scripts/utils/proc/runSourceBuildCommand.mjs';

test('a failed dependency publication does not strand later source inventory refreshes', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-ui-refresh-recovery-' });
  const repoRoot = fixture.path('source');
  const uiPackageDir = join(repoRoot, 'apps/ui');
  const cliManifestPath = join(repoRoot, 'apps/cli/package.json');
  await mkdir(uiPackageDir, { recursive: true });
  await mkdir(join(repoRoot, 'apps/cli'), { recursive: true });
  await writeFile(cliManifestPath, JSON.stringify({ bundledDependencies: [] }));
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root };
  const generationPath = `${resolveDependencyRefreshLockPath(repoRoot, env)}.generation`;
  await mkdir(join(generationPath, '..'), { recursive: true });
  // Metro and the dependency publication are external boundaries. Keep the
  // watcher, input discovery and admission/recovery logic real beneath them.
  const watcher = new EventEmitter();
  const metroServer = { getBundler: () => ({ getBundler: () => ({ getWatcher: () => watcher }) }) };
  const { watchUiSourcePluginInventory } = await import('./ensureWorkspacePackagesBuilt.mjs');
  let firstFailure;
  const failed = new Promise(resolve => { firstFailure = resolve; });
  let nextRefresh;
  const recovered = new Promise(resolve => { nextRefresh = resolve; });
  let refreshes = 0;
  let subscription;
  subscription = watchUiSourcePluginInventory({ uiPackageDir, env, metroServer, logger: {
    info() {
      refreshes += 1;
      if (refreshes === 1) {
        writeFileSync(generationPath, JSON.stringify({ generation: 'failed-install', completedGeneration: 'before',
          installationFailure: { pnpmErrorCode: 'ERR_PNPM_LOCKFILE_CONFIG_MISMATCH' } }));
      } else {
        // The next edit has been admitted. Stop before invoking the compiler;
        // this regression concerns recovery of the containing refresh queue.
        void subscription.close();
        nextRefresh();
      }
    },
    error(_message, error) { firstFailure(error); },
  } });
  t.after(() => subscription.close());
  for (let edit = 0; edit < 10; edit += 1) {
    watcher.emit('change', { eventsQueue: [{ filePath: cliManifestPath, type: 'change' }] });
  }
  assert.equal((await failed).code, 'HAPPIER_DEPENDENCY_REFRESH_FAILED');
  assert.equal(refreshes, 1, 'edits waiting for dependency admission share one refresh');
  await writeFile(generationPath, JSON.stringify({ generation: 'repaired', completedGeneration: 'repaired' }));
  watcher.emit('change', { eventsQueue: [{ filePath: cliManifestPath, type: 'change' }] });
  let deadline;
  try {
    await Promise.race([recovered, new Promise((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('the next source edit was stranded after dependency repair')), 2000);
    })]);
  } finally { clearTimeout(deadline); }
  assert.equal(refreshes, 2);
});

test('source preparation retains last-green assets while refreshing healthy plugin bytes in non-strict modes', async context => {
  const fixture = await createTempFixture(context, { prefix: 'happier-ui-source-retention-' });
  const sourceRepo = fileURLToPath(new URL('../../../', import.meta.url));
  const repoRoot = fixture.path('source');
  await captureSourceWebBuildInputs({ repoDir: sourceRepo, outputDir: repoRoot });
  // Reuse the composed source-only checkout harness. Postinstall tools are not
  // served inputs, but the real callable preflight needs their verification.
  await cp(join(sourceRepo, 'apps/ui/tools'), join(repoRoot, 'apps/ui/tools'), { recursive: true });
  await cp(join(sourceRepo, 'apps/stack/bin'), join(repoRoot, 'apps/stack/bin'), { recursive: true });
  const uiPackageDir = join(repoRoot, 'apps/ui');
  // Enter the captured checkout through its source-tool authority, as live
  // Expo does. Importing it into this test process would resolve excluded dist.
  const preflight = join(repoRoot, 'apps/stack/scripts/ui_asset_retention_preflight.mjs');
  await writeFile(preflight, String.raw`
  import assert from 'node:assert/strict';
  import { mock } from 'node:test';
  import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
  import { join } from 'node:path';
  import { pathToFileURL } from 'node:url';
  import { SOURCE_UI_ASSET_OUTPUT_PATHS } from '../../ui/scripts/sourceUiAssetPaths.mjs';
  const repoRoot = ${JSON.stringify(repoRoot)};
  const uiPackageDir = ${JSON.stringify(uiPackageDir)};
  const cliManifestPath = join(repoRoot, 'apps/cli/package.json');
  const cliManifest = JSON.parse(await readFile(cliManifestPath, 'utf8'));
  for (const output of Object.values(SOURCE_UI_ASSET_OUTPUT_PATHS)) {
    await assert.rejects(readFile(join(uiPackageDir, output)), { code: 'ENOENT' },
      'source capture must exclude prepared inventories before the canonical prep generates them');
  }
  await writeFile(cliManifestPath, JSON.stringify({ ...cliManifest, bundledDependencies: ['@happier-dev/plugins-inspector'] }));
  const pluginSource = join(repoRoot, 'packages/plugins/inspector/src/ui/renderSurface.tsx');
  await writeFile(pluginSource, 'export function renderSurface() { return "healthy-plugin-before"; }\n');
  const { ensureUiWorkspacePackagesBuilt, resolveUiWorkspaceStartupOutputs } = await import(pathToFileURL(join(uiPackageDir, 'scripts/ensureWorkspacePackagesBuilt.mjs')));
  const { hasUsableWorkspaceLastGreen } = await import('../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs');
  const env = { ...process.env,
    HAPPIER_UI_VENDOR_WEB_ASSETS: '0',
    HAPPIER_STACK_DEV_AUTO_REFRESH_DEPS: '1',
    HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: ${JSON.stringify(fixture.path('consumer/inventory.js'))},
  };
  delete env.HAPPIER_WORKSPACE_BUILD_MODE;
  delete env.HAPPIER_STACK_DEV_READ_ONLY_DEPENDENCIES;
  delete env.HAPPIER_UI_POSTINSTALL_DEPENDENCIES_ONLY;
  delete env.npm_lifecycle_event;
  const prepare = async overrides => ensureUiWorkspacePackagesBuilt({ uiPackageDir, source: true, env: { ...env, ...overrides } });
  const pluginBytes = async inventory => {
    const entry = inventory.match(/require\(("(?:[^"\\]|\\.)*inspector-app-native\/entry\.cjs\.bundle")\)/);
    assert.ok(entry, 'the source compiler must publish the Inspector artifact');
    return readFile(JSON.parse(entry[1]), 'utf8');
  };
  await prepare();
  const preparedOutputs = resolveUiWorkspaceStartupOutputs({ uiPackageDir, env });
  assert.ok(preparedOutputs.includes(join(uiPackageDir, 'sources/text/localeAssets.generated.js')),
    'source startup must require the locale inventory consumed by web');
  assert.ok(preparedOutputs.some(path => path.endsWith('.locale.bundle')),
    'source startup must require its compiled locale bytes');
  assert.ok(preparedOutputs.includes(join(uiPackageDir, 'sources/components/ui/code/highlighting/shiki/generatedShikiGrammarAssets.js')),
    'source startup must require the grammar inventory consumed by web');
  assert.ok(preparedOutputs.some(path => path.endsWith('.json.bundle')),
    'source startup must require its compiled grammar bytes');
  const compiledLocalePath = preparedOutputs.find(path => path.endsWith('.locale.bundle'));
  const compiledLocale = await readFile(compiledLocalePath, 'utf8');
  await rm(compiledLocalePath);
  await prepare();
  assert.equal(await readFile(compiledLocalePath, 'utf8'), compiledLocale,
    'same-input reuse must regenerate a missing consumed locale asset');
  const assetPath = join(uiPackageDir, 'sources/components/atmosphere/backdropWorkletCore.generated.js');
  const lastGreen = await readFile(assetPath, 'utf8');
  assert.ok(lastGreen.length > 0);
  const originalInventory = await readFile(env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY, 'utf8');
  assert.match(await pluginBytes(originalInventory), /healthy-plugin-before/);

  await writeFile(join(repoRoot, 'packages/brand/atmosphere.mjs'), 'export const brokenAsset = ;\n');
  await writeFile(pluginSource, 'export function renderSurface() { return "healthy-plugin-after"; }\n');
  const diagnostics = [];
  mock.method(console, 'warn', (...args) => diagnostics.push(args.join(' ')));
  // An explicit strict mode and publication lifecycle must still reject the
  // real compiler error even when a usable previous source asset exists.
  for (const overrides of [{ HAPPIER_WORKSPACE_BUILD_MODE: 'strict' }, { npm_lifecycle_event: 'prepack' }]) {
    await assert.rejects(prepare(overrides), error => Array.isArray(error.errors) && error.errors.length > 0);
    assert.equal(await readFile(env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY, 'utf8'), originalInventory);
    assert.equal(await readFile(assetPath, 'utf8'), lastGreen);
  }
  await prepare();
  assert.equal(await readFile(assetPath, 'utf8'), lastGreen);
  assert.ok(diagnostics.some(message => message.includes(assetPath) && /Unexpected/u.test(message)),
    'retention must keep the compiler diagnostic visible');
  const refreshedInventory = await readFile(env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY, 'utf8');
  assert.match(await pluginBytes(refreshedInventory), /healthy-plugin-after/);
  assert.doesNotMatch(await pluginBytes(refreshedInventory), /healthy-plugin-before/);
  assert.match(await pluginBytes(originalInventory), /healthy-plugin-before/,
    'previous consumer bytes remain available after inventory replacement');

  await writeFile(pluginSource, 'export function renderSurface() { return "healthy-plugin-qa"; }\n');
  await prepare({ HAPPIER_WORKSPACE_BUILD_MODE: 'qa-runtime' });
  assert.equal(await readFile(assetPath, 'utf8'), lastGreen);
  assert.match(await pluginBytes(await readFile(env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY, 'utf8')), /healthy-plugin-qa/);
  await rm(assetPath);
  const completeInventory = await readFile(env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY, 'utf8');
  await assert.rejects(prepare(), error => Array.isArray(error.errors) && error.errors.length > 0);
  assert.equal(await readFile(env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY, 'utf8'), completeInventory,
    'a missing asset must not be treated as usable last-green output');

  // Exercise startup admission against the real producer's inventory, rather
  // than a handwritten require that can drift from its emitted graph format.
  const startupInputs = () => resolveUiWorkspaceStartupOutputs({ uiPackageDir, env });
  const startupIsUsable = () => hasUsableWorkspaceLastGreen(uiPackageDir, { requiredFiles: startupInputs() });
  assert.equal(await startupIsUsable(), true);
  const pluginEntry = startupInputs().find(path => path.endsWith('entry.cjs.bundle'));
  assert.ok(pluginEntry, 'the inventory must retain its compiled plugin entry');
  await rm(pluginEntry);
  assert.equal(await startupIsUsable(), false, 'an inventory without its consumed asset graph is not last-green');
  `);
  const result = await runNodeCapture(sourceBuildNodeArgs({ repoDir: repoRoot, scriptPath: preflight }), { cwd: repoRoot });
  assert.equal(result.code, 0, result.stderr);
});

test('workspace startup admits Metro inputs independently of workspace dist publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-ui-last-green-'));
  const uiPackageDir = join(root, 'apps', 'ui');
  try {
    await mkdir(uiPackageDir, { recursive: true });
    const { resolveUiWorkspaceStartupOutputs } = await import('./ensureWorkspacePackagesBuilt.mjs');
    const { hasUsableWorkspaceLastGreen } = await import('../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs');
    const lastGreen = () => hasUsableWorkspaceLastGreen(uiPackageDir, { requiredFiles: resolveUiWorkspaceStartupOutputs({ uiPackageDir }) });
    await mkdir(join(root, 'apps', 'cli', 'scripts'), { recursive: true });
    await writeFile(join(root, 'apps', 'cli', 'scripts', 'buildSharedDeps.mjs'),
      `export { inspectUsableSourceDevSharedDepsLastGreen } from ${JSON.stringify(new URL('../../cli/scripts/buildSharedDeps.mjs', import.meta.url).href)};\n`);
    const sdkDir = join(root, 'packages', 'plugin-sdk');
    await mkdir(join(sdkDir, 'dist'), { recursive: true });
    await writeFile(join(sdkDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/plugin-sdk', type: 'module', exports: { '.': './dist/index.js' },
    }));
    await writeFile(join(sdkDir, 'dist', 'index.js'), 'export {};\n');
    const signature = computeSourceDevSharedDepsSignature({ repoRoot: root, workspaceNames: ['plugin-sdk'] });
    await mkdir(join(root, '.project', 'tmp'), { recursive: true });
    await writeFile(join(root, '.project', 'tmp', 'cli-source-dev-shared-deps-sync.json'), JSON.stringify({
      version: signature.version, entries: { sdk: { signature, syncedAtMs: 1 } },
    }));
    assert.equal(await lastGreen(), false);
    const outputPath = resolveBundledPluginUiArtifactsOutputPath(root);
    await mkdir(join(outputPath, '..'), { recursive: true });
    await writeFile(outputPath, 'export const BUNDLED_PLUGIN_UI_APP_ARTIFACTS = [];\n');
    // Source asset admission is independent of workspace dist publication too.
    await writeFile(join(outputPath, '../source-assets.json'), JSON.stringify({ inputPaths: [], outputPaths: [], assetPaths: [] }));
    assert.equal(await lastGreen(), true);
    await rm(join(sdkDir, 'dist', 'index.js'));
    assert.equal(await lastGreen(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ensureUiWorkspacePackagesBuilt publishes rebuilt plugin artifacts before Expo can adopt their bytes', async () => {
  const calls = [];
  const verifyPatchedDependencies = (options) => {
    calls.push(['verify', options]);
  };
  const ensureWorkspacePackagesBuiltForComponent = async (componentDir, options) => {
    calls.push(['build', componentDir, options]);
    return { ok: true, built: ['@happier-dev/plugins-inspector'], skipped: [] };
  };
  const syncSharedDepsForSourceDev = async (repoRoot, options) => {
    calls.push(['publish', repoRoot, options]);
    return { synced: true, stamped: true };
  };
  const generateBundledPluginUiArtifacts = async (options) => {
    calls.push(['preseed', options]);
  };

  const { ensureUiWorkspacePackagesBuilt } = await import('./ensureWorkspacePackagesBuilt.mjs');

  const env = { CI: '1' };
  await ensureUiWorkspacePackagesBuilt({
    env,
    verifyPatchedDependencies,
    syncSharedDepsForSourceDev,
    generateBundledPluginUiArtifacts,
    ensureWorkspacePackagesBuiltForComponent,
  });

  assert.equal(calls.length, 4);
  assert.equal(calls[0][0], 'verify');
  assert.match(String(calls[0][1].uiPackageDir), /apps\/ui$/);
  assert.equal(calls[1][0], 'build');
  assert.match(String(calls[1][1]), /apps\/ui$/);
  assert.deepEqual(calls[1][2], {
    quiet: false,
    env: { ...env, HAPPIER_WORKSPACE_BUILD_MODE: 'source-dev' },
    publicationMode: 'live',
    isolatePluginFailures: true,
  });
  assert.equal(calls[2][0], 'publish');
  assert.equal(calls[2][1], resolve(String(calls[1][1]), '../..'));
  assert.deepEqual(calls[2][2], {
    env: { ...env, HAPPIER_WORKSPACE_BUILD_MODE: 'source-dev' },
    includeRuntimeDependencies: true,
    quiet: false,
    workspaceNames: ['plugins-inspector'],
  });
  assert.deepEqual(calls[3], ['preseed', {
    repoRoot: resolve(String(calls[1][1]), '../..'),
    mode: 'write',
    publicationMode: 'live',
  }]);
});

test('UI artifact preflight keeps plugin builds strict and rejects a missing UI bundle', async () => {
  const failure = Object.freeze({
    packageName: '@happier-dev/plugins-broken',
    pluginId: 'happier.broken',
    diagnostic: Object.freeze({ code: 'plugin_ui_artifact_invalid', message: 'missing UI bundle' }),
  });
  const calls = [];
  const { ensureUiWorkspacePackagesBuilt } = await import('./ensureWorkspacePackagesBuilt.mjs');
  await assert.rejects(() => ensureUiWorkspacePackagesBuilt({
    publicationMode: 'artifact',
    verifyPatchedDependencies: () => {},
    ensureWorkspacePackagesBuiltForComponent: async (_dir, options) => {
      calls.push(options);
      return { ok: true, built: [], pluginFailures: [], skipped: [] };
    },
    syncSharedDepsForSourceDev: async () => { throw new Error('release must not invoke live source sync'); },
    generateBundledPluginUiArtifacts: async () => ({ pluginFailures: [failure] }),
  }), /UI artifact publication failed.*plugins-broken/u);
  assert.equal(calls[0].publicationMode, 'artifact');
  assert.equal(calls[0].isolatePluginFailures, false);
});

test('ensureUiWorkspacePackagesBuilt leaves complete remote publication policy with the canonical publisher', async () => {
  const calls = [];
  const { ensureUiWorkspacePackagesBuilt } = await import('./ensureWorkspacePackagesBuilt.mjs');
  const env = { HAPPIER_DEV_TARGET_EXECUTION: '1' };

  await ensureUiWorkspacePackagesBuilt({
    env,
    verifyPatchedDependencies: () => {},
    ensureWorkspacePackagesBuiltForComponent: async () => ({
      ok: true,
      built: ['@happier-dev/plugins-inspector'],
      skipped: [],
    }),
    syncSharedDepsForSourceDev: async (_repoRoot, options) => {
      calls.push(options);
      return { synced: true, stamped: true };
    },
    generateBundledPluginUiArtifacts: async () => {},
  });

  assert.deepEqual(calls, [{
    env: { ...env, HAPPIER_WORKSPACE_BUILD_MODE: 'source-dev' },
    includeRuntimeDependencies: true,
    quiet: false,
    workspaceNames: ['plugins-inspector'],
  }]);
});

test('ensureUiWorkspacePackagesBuilt does not republish a plugin projection when the UI build rebuilt no plugin package', async () => {
  const calls = [];
  const { ensureUiWorkspacePackagesBuilt } = await import('./ensureWorkspacePackagesBuilt.mjs');

  await ensureUiWorkspacePackagesBuilt({
    env: { CI: '1' },
    verifyPatchedDependencies: () => calls.push('verify'),
    ensureWorkspacePackagesBuiltForComponent: async () => {
      calls.push('build');
      return { ok: true, built: ['@happier-dev/plugin-sdk'], skipped: [] };
    },
    syncSharedDepsForSourceDev: async () => calls.push('publish'),
    generateBundledPluginUiArtifacts: async (options) => calls.push(['preseed', options.mode]),
  });

  assert.deepEqual(calls, ['verify', 'build', ['preseed', 'write']]);
});

test('UI preflight carries a failed plugin into byte publication while keeping a healthy rebuilt plugin', async () => {
  const failure = Object.freeze({
    packageName: '@happier-dev/plugins-broken',
    pluginId: 'happier.broken',
    diagnostic: Object.freeze({ code: 'plugin_package_build_failed', message: 'missing staged export' }),
  });
  const calls = [];
  const { ensureUiWorkspacePackagesBuilt } = await import('./ensureWorkspacePackagesBuilt.mjs');
  await ensureUiWorkspacePackagesBuilt({
    verifyPatchedDependencies: () => {},
    ensureWorkspacePackagesBuiltForComponent: async () => ({
      ok: true, built: ['@happier-dev/plugins-healthy'], pluginFailures: [failure], skipped: [],
    }),
    syncSharedDepsForSourceDev: async (_root, options) => { calls.push(['publish', options]); },
    generateBundledPluginUiArtifacts: async (options) => { calls.push(['preseed', options]); },
  });
  assert.equal(calls[0][0], 'publish');
  assert.deepEqual(calls[0][1].workspaceNames, ['plugins-healthy']);
  assert.equal(calls[1][0], 'preseed');
  assert.equal(calls[1][1].pluginFailures[0], failure);
});

test('UI artifact failure republishes the catalog projection without the failed plugin', async () => {
  const failure = Object.freeze({
    packageName: '@happier-dev/plugins-broken',
    pluginId: 'happier.broken',
    diagnostic: Object.freeze({ code: 'plugin_ui_artifact_invalid', message: 'missing UI bundle' }),
  });
  const published = [];
  const reprojected = [];
  const { ensureUiWorkspacePackagesBuilt } = await import('./ensureWorkspacePackagesBuilt.mjs');
  await ensureUiWorkspacePackagesBuilt({
    verifyPatchedDependencies: () => {},
    ensureWorkspacePackagesBuiltForComponent: async () => ({
      ok: true, built: ['@happier-dev/plugins-healthy'], pluginFailures: [], skipped: [],
    }),
    syncSharedDepsForSourceDev: async (_root, options) => { published.push(options); },
    generateBundledPluginUiArtifacts: async () => ({ pluginFailures: [failure] }),
    publishBundledPluginProjectionWithFailuresImpl: async (options) => { reprojected.push(options); },
  });
  assert.equal(published.length, 1);
  assert.deepEqual(published[0].workspaceNames, ['plugins-healthy']);
  assert.equal(reprojected.length, 1);
  assert.equal(reprojected[0].pluginFailures[0], failure);
});

test('ensureUiWorkspacePackagesBuilt throws when apps/ui is not inside a Happier monorepo checkout', async () => {
  const ensureWorkspacePackagesBuiltForComponent = async () => ({ ok: true, built: [], skipped: ['not-monorepo'] });
  const { ensureUiWorkspacePackagesBuilt } = await import('./ensureWorkspacePackagesBuilt.mjs');

  await assert.rejects(
    () => ensureUiWorkspacePackagesBuilt({
      env: { CI: '1' },
      verifyPatchedDependencies: () => {},
      syncSharedDepsForSourceDev: async () => ({ synced: false, stamped: true }),
      generateBundledPluginUiArtifacts: async () => {},
      ensureWorkspacePackagesBuiltForComponent,
    }),
    /\bnot-monorepo\b/i
  );
});

test('live UI failure publication uses scoped target-owned artifacts on execution replicas', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-ui-failure-publication-'));
  try {
    const scriptDir = join(root, 'apps', 'cli', 'scripts');
    await mkdir(join(scriptDir, 'build-owned'), { recursive: true });
    await writeFile(join(scriptDir, 'build-owned', 'generateBundledPluginEntries.ts'), 'export {};');
    // The child executable is the OS boundary; the UI owner and publisher stay real.
    await writeFile(join(scriptDir, 'withNodeHeapLimit.mjs'),
      "import { readFileSync, writeFileSync } from 'node:fs'; writeFileSync(process.env.PUBLISHER_CAPTURE, JSON.stringify({args:process.argv.slice(2), failures:JSON.parse(readFileSync(0,'utf8'))}));");
    const failure = { packageName: '@happier-dev/plugins-broken', pluginId: 'happier.broken',
      diagnostic: { code: 'plugin_ui_artifact_invalid', message: 'missing UI bundle' } };
    const capture = join(root, 'captured.json');
    const { publishBundledPluginProjectionWithFailures } = await import('./ensureWorkspacePackagesBuilt.mjs');
    await publishBundledPluginProjectionWithFailures({ repoRoot: root,
      env: { ...process.env, HAPPIER_DEV_TARGET_EXECUTION: '1', PUBLISHER_CAPTURE: capture },
      pluginFailures: [failure] });
    const published = JSON.parse(await readFile(capture, 'utf8'));
    assert.deepEqual(published.failures, [failure]);
    assert.equal(published.args.includes('--target-owned-only'), true);
    assert.equal(published.args[published.args.indexOf('--workspace') + 1], 'plugins-broken');
    await publishBundledPluginProjectionWithFailures({ repoRoot: root,
      env: { ...process.env, HAPPIER_DEV_TARGET_EXECUTION: '0', PUBLISHER_CAPTURE: capture },
      pluginFailures: [failure] });
    const local = JSON.parse(await readFile(capture, 'utf8'));
    assert.equal(local.args.includes('--target-owned-only'), false);
    assert.equal(local.args[local.args.indexOf('--workspace') + 1], 'plugins-broken');
    await publishBundledPluginProjectionWithFailures({ repoRoot: root,
      env: { ...process.env, HAPPIER_DEV_TARGET_EXECUTION: '1', PUBLISHER_CAPTURE: capture },
      publicationMode: 'artifact', pluginFailures: [failure] });
    const artifact = JSON.parse(await readFile(capture, 'utf8'));
    assert.equal(artifact.args.includes('--workspace'), false);
    assert.equal(artifact.args.includes('--target-owned-only'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('source inventory refreshes compile only when their observed inputs changed', async t => {
  const { default: childProcess } = await import('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  const { basename, dirname } = await import('node:path');
  const fixture = await createTempFixture(t, { prefix: 'happier-ui-refresh-identity-' });
  const repoRoot = fixture.path('source');
  const uiPackageDir = join(repoRoot, 'apps/ui');
  const write = async (path, contents) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  };
  const cliManifestPath = join(repoRoot, 'apps/cli/package.json');
  const localeSource = join(uiPackageDir, 'sources/text/_all.ts');
  await write(cliManifestPath, JSON.stringify({ bundledDependencies: [] }));
  await write(join(repoRoot, 'package.json'), JSON.stringify({ private: true }));
  await write(join(uiPackageDir, 'package.json'), JSON.stringify({ name: '@fixture/ui' }));
  await write(localeSource, 'export const en = 1;\n');
  await mkdir(join(uiPackageDir, '.expo/hstack/locales'), { recursive: true });
  const inventoryPath = fixture.path('consumer/inventory.js');
  // The published source-assets record names checkout-root inputs, as the
  // live record does (root package.json, app manifests, locale sources).
  const record = JSON.stringify({ inputPaths: [join(repoRoot, 'package.json'), join(uiPackageDir, 'package.json'), localeSource],
    assetPaths: [], publications: [] });
  await write(join(dirname(inventoryPath), 'source-assets.json'), record);
  await write(inventoryPath, 'export const BUNDLED_PLUGIN_UI_APP_ARTIFACTS = [];\n');
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: inventoryPath };
  // The compiler process is the boundary: replace only its spawned payload
  // with one that publishes a valid candidate. Discovery, matching, admission
  // waits, publication and the refresh queue stay real.
  let compilations = 0;
  let pluginCompilations = 0;
  let published;
  const compiler = `const options = JSON.parse(process.argv[1]);
    const { mkdirSync, writeFileSync } = require('node:fs');
    const { dirname, join } = require('node:path');
    mkdirSync(dirname(options.inventoryPath), { recursive: true });
    writeFileSync(options.inventoryPath, 'export const BUNDLED_PLUGIN_UI_APP_ARTIFACTS = []; // ' + process.argv[2] + '\\n');
    writeFileSync(join(dirname(options.inventoryPath), 'source-assets.json'), ${JSON.stringify(record)});`;
  const nativeFork = childProcess.fork;
  t.mock.method(childProcess, 'fork', (modulePath, args, options) => {
    if (basename(modulePath) === 'proc.mjs' && typeof args?.[1] === 'string') {
      const invocation = JSON.parse(args[1]);
      const index = invocation.args?.findIndex(arg => typeof arg === 'string' && basename(arg) === 'build_source_web_ui.mjs') ?? -1;
      if (index >= 0) {
        compilations += 1;
        if (JSON.parse(invocation.args[index + 1]).preparePlugins !== false) pluginCompilations += 1;
        args = [args[0], JSON.stringify({ ...invocation, command: process.execPath,
          args: ['-e', compiler, invocation.args[index + 1], String(compilations)] })];
      }
    }
    return nativeFork(modulePath, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const watcher = new EventEmitter();
  const graph = { doesFileExist: () => true };
  const metroServer = { getWatchFolders: () => [],
    getBundler: () => ({ getBundler: () => ({ getWatcher: () => watcher, getDependencyGraph: async () => graph }) }) };
  const metroConfig = { projectRoot: fixture.root, resolver: { sourceExts: ['js'], assetExts: ['bundle'] },
    watcher: { additionalExts: [] } };
  const failures = [];
  const { watchUiSourcePluginInventory } = await import('./ensureWorkspacePackagesBuilt.mjs');
  const owner = watchUiSourcePluginInventory({ uiPackageDir, env, metroServer, metroConfig,
    logger: { info(line) { if (line === '[source-ui] phase=plugin-ui-published') published?.(); }, error: (_message, error) => failures.push(error) } });
  t.after(() => owner.close());
  const observe = async (path, type, prepares = false) => {
    const publication = prepares ? new Promise(resolve => { published = resolve; }) : null;
    watcher.emit('change', { eventsQueue: [{ filePath: path, type }] });
    await owner.ready();
    if (publication) await publication;
    assert.deepEqual(failures, []);
    return compilations;
  };
  assert.equal(await observe(cliManifestPath, 'change', true), 1, 'the first observed input event prepares');
  // Events that leave every observed input unchanged: a generated locale
  // bundle, an unrelated file beneath an input directory's subtree, and a
  // same-bytes rewrite of an input.
  const localeBundle = join(uiPackageDir, '.expo/hstack/locales/0123.locale.bundle');
  await write(localeBundle, 'bundle');
  assert.equal(await observe(localeBundle, 'add'), 1, 'a published locale bundle is not a Plugin UI input');
  const unrelated = join(repoRoot, 'apps/server/sources/changes/page.ts');
  await write(unrelated, 'export {};\n');
  assert.equal(await observe(unrelated, 'add'), 1, 'an addition outside every input directory is not an input change');
  await write(localeSource, 'export const en = 1;\n');
  assert.equal(await observe(localeSource, 'change'), 1, 'a same-bytes rewrite is not an input change');
  // Asset inputs refresh without compiling Plugin UI.
  const beforeLocaleEdit = pluginCompilations;
  await write(localeSource, 'export const en = 2;\n');
  assert.equal(await observe(localeSource, 'change', true), 2, 'an edited input prepares');
  assert.equal(pluginCompilations, beforeLocaleEdit, 'translation changes must not compile Plugin UI');
  const added = join(uiPackageDir, 'sources/text/es.ts');
  await write(added, 'export const es = 1;\n');
  assert.equal(await observe(added, 'add', true), 3, 'a new member of an input directory prepares');
  assert.equal(pluginCompilations, beforeLocaleEdit, 'translation additions must not compile Plugin UI');
  await owner.close();
  assert.equal(compilations, 3, 'unrelated arrivals and same-byte rewrites add no preparation');
});


test('bundle admission serves the last-green inventory while refresh waits for dependency publication', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-ui-last-green-request-' });
  const repoRoot = fixture.path('source');
  const uiPackageDir = join(repoRoot, 'apps/ui');
  await mkdir(uiPackageDir, { recursive: true });
  await mkdir(join(repoRoot, 'apps/cli'), { recursive: true });
  const manifest = join(repoRoot, 'apps/cli/package.json');
  await writeFile(manifest, JSON.stringify({ bundledDependencies: [] }));
  const inventoryPath = fixture.path('consumer/inventory.js');
  await mkdir(join(inventoryPath, '..'), { recursive: true });
  const artifactPath = fixture.path('consumer/artifacts/last-green/entry.cjs.bundle');
  await mkdir(join(artifactPath, '..'), { recursive: true });
  await writeFile(artifactPath, 'module.exports = { lastGreen: true };');
  const lastGreen = `const BUNDLED_PLUGIN_UI_APP_ASSET_0 = require(${JSON.stringify(artifactPath)});\nexport const BUNDLED_PLUGIN_UI_APP_ARTIFACTS = [];\n`;
  await writeFile(inventoryPath, lastGreen);
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: inventoryPath };
  const watcher = new EventEmitter();
  let releaseGraph;
  const graphWait = new Promise(resolve => { releaseGraph = resolve; });
  let graphHeld = false;
  const metroServer = { getWatchFolders: () => [], getBundler: () => ({ getBundler: () => ({
    getWatcher: () => watcher,
    getDependencyGraph: async () => { if (graphHeld) await graphWait; return { doesFileExist: () => true }; },
  }) }) };
  const metroConfig = { projectRoot: fixture.root, resolver: { sourceExts: ['js'], assetExts: ['bundle'] }, watcher: { additionalExts: [] } };
  const { watchUiSourcePluginInventory } = await import('./ensureWorkspacePackagesBuilt.mjs');
  let started;
  const refreshing = new Promise(resolve => { started = resolve; });
  const owner = watchUiSourcePluginInventory({ uiPackageDir, env, metroServer, metroConfig,
    logger: { info(line) { if (line.includes('phase=plugin-ui-refresh')) { graphHeld = true; started(); } }, error() {} } });
  t.after(async () => { releaseGraph(); await owner.close(); });
  await owner.ready(); // The same last-green publication is already admitted.
  watcher.emit('change', { eventsQueue: [{ filePath: manifest, type: 'change' }] });
  await refreshing;
  let deadline;
  try {
    await Promise.race([owner.ready(), new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('bundle admission waited for the in-flight refresh')), 1000);
    })]);
    assert.equal(await readFile(inventoryPath, 'utf8'), lastGreen);
    assert.equal(await readFile(artifactPath, 'utf8'), 'module.exports = { lastGreen: true };');
  } finally { clearTimeout(deadline); }
});
