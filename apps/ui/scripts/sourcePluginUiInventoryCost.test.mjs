// @happier-test-preparation source
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempFixture } from '../../stack/scripts/testkit/core/temp_fixture.mjs';

test('source inventory discovers every watched input with one compiler graph in flight', async t => {
  const { mock } = await import('node:test');
  const { dirname } = await import('node:path');
  const { runCommandSync } = await import('../../stack/scripts/utils/test/test_process.mjs');
  const file = fileURLToPath(import.meta.url);
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  if (process.env.HAPPIER_UI_GRAPH_COST_CHILD !== '1') {
    const result = runCommandSync(process.execPath, [
      '--experimental-test-module-mocks', '--conditions=happier-source',
      '--import', join(repoRoot, 'packages/cli-common/registerSourceRuntime.mjs'), '--test',
      '--test-name-pattern=source inventory discovers every watched input with one compiler graph in flight', file,
    ], { cwd: repoRoot, env: { ...process.env, NODE_TEST_CONTEXT: undefined, HAPPIER_UI_GRAPH_COST_CHILD: '1' },
      stdio: 'pipe', encoding: 'utf8' });
    t.diagnostic(result.stdout);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return;
  }
  const fixture = await createTempFixture(t, { prefix: 'happier-ui-graph-cost-' });
  const root = fixture.path('source');
  const uiPackageDir = join(root, 'apps/ui');
  const write = async (path, content) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  };
  await write(join(uiPackageDir, 'scripts/prepareSourcePluginUiArtifacts.mjs'), 'export {};');
  await write(join(root, 'apps/cli/package.json'), JSON.stringify({ bundledDependencies: [
    '@happier-dev/plugins-alpha', '@happier-dev/plugins-beta',
  ] }));
  for (const name of ['alpha', 'beta']) {
    await write(join(root, 'packages/plugins', name, 'package.json'), JSON.stringify({
      name: `@happier-dev/plugins-${name}`, exports: {
        './happier-plugin-ui/main': { 'happier-source': './src/ui.ts' },
      },
    }));
    await write(join(root, 'packages/plugins', name, 'src/ui.ts'), 'export const view = 1;');
  }
  let active = 0;
  let peak = 0;
  let completed = 0;
  let finishDiscovery;
  const discovered = new Promise(resolve => { finishDiscovery = resolve; });
  // Observe the external compiler service without replacing its graph logic.
  // Keep the watcher, resolver, graph projection and esbuild compilation real.
  const esbuild = await import('esbuild');
  const graphInputs = new Set();
  const build = async options => {
    active += 1;
    peak = Math.max(peak, active);
    try {
      const result = await esbuild.build(options);
      for (const path of Object.keys(result.metafile.inputs)) graphInputs.add(resolve(options.absWorkingDir, path));
      return result;
    } finally {
      active -= 1;
      completed += 1;
      if (completed === 3) finishDiscovery();
    }
  };
  const boundary = mock.module('esbuild', { namedExports: { ...esbuild, build },
    defaultExport: { ...esbuild.default, build } });
  t.after(() => boundary.restore());
  const { watchUiSourcePluginInventory } = await import('./ensureWorkspacePackagesBuilt.mjs');
  const { EventEmitter } = await import('node:events');
  const watcher = new EventEmitter();
  const metroServer = { getBundler: () => ({ getBundler: () => ({ getWatcher: () => watcher }) }) };
  const subscription = watchUiSourcePluginInventory({ uiPackageDir,
    env: { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root }, metroServer,
    logger: { error(_message, error) { throw error; } },
  });
  t.after(() => subscription.close());
  await discovered;
  assert.equal(completed, 3, 'compiler and both plugin graphs contribute their watched inputs');
  for (const path of ['apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs',
    'packages/plugins/alpha/src/ui.ts', 'packages/plugins/beta/src/ui.ts']) {
    assert.ok(graphInputs.has(join(root, path)), `real compiler graph includes ${path}`);
  }
  const { readSourcePluginUiBuildInputs } = await import('../../stack/scripts/utils/fs/workspaceBuildInputs.mjs');
  await write(join(root, 'packages/plugins/alpha/src/ui.ts'), 'export { view } from "./detail";');
  await write(join(root, 'packages/plugins/alpha/src/detail.ts'), 'export const view = 2;');
  const beforeEdit = completed;
  const changedInputs = await readSourcePluginUiBuildInputs({ repoDir: root, pluginDirectory: 'alpha' });
  assert.equal(completed - beforeEdit, 1, 'one changed plugin needs one graph rediscovery');
  assert.ok(changedInputs.includes('packages/plugins/alpha/src/detail.ts'), 'rediscovery observes the changed import graph');
  assert.equal(peak, 1, 'the serving process must not overlap full compiler graphs');
  t.diagnostic(`graphs=${beforeEdit} peak=${peak} rediscoveries=${completed - beforeEdit}`);
});

test('artifact requests reuse publication admission and admit changed files before serving', async t => {
  const { createRequire, syncBuiltinESMExports } = await import('node:module');
  const { EventEmitter } = await import('node:events');
  const { dirname } = await import('node:path');
  const { rename, rm } = await import('node:fs/promises');
  const fixture = await createTempFixture(t, { prefix: 'happier-ui-admission-cost-' });
  const uiPackageDir = fixture.path('source/apps/ui');
  await mkdir(join(uiPackageDir, 'scripts'), { recursive: true });
  await writeFile(join(uiPackageDir, 'scripts/prepareSourcePluginUiArtifacts.mjs'), 'export {};');
  await mkdir(fixture.path('source/apps/cli'), { recursive: true });
  await writeFile(fixture.path('source/apps/cli/package.json'), JSON.stringify({ bundledDependencies: [] }));
  const inventoryPath = fixture.path('consumer/inventory.js');
  const recordPath = fixture.path('consumer/source-assets.json');
  await mkdir(dirname(inventoryPath), { recursive: true });
  const pluginAssets = Array.from({ length: 12 }, (_, index) => fixture.path(`consumer/plugin-${index}.bundle`));
  const sourceAssets = Array.from({ length: 8 }, (_, index) => fixture.path(`consumer/source-${index}.bundle`));
  const assets = new Set([...pluginAssets, ...sourceAssets]);
  for (const path of assets) await writeFile(path, 'asset');
  const publish = async (path, contents) => {
    await writeFile(`${path}.candidate`, contents);
    await rename(`${path}.candidate`, path);
  };
  const publishInventory = () => publish(inventoryPath, pluginAssets.map((path, index) =>
    `const BUNDLED_PLUGIN_UI_APP_ASSET_${index} = require(${JSON.stringify(path)});`).join('\n') +
    '\nexport const BUNDLED_PLUGIN_UI_APP_ARTIFACTS = [];\n');
  const publishRecord = () => publish(recordPath, JSON.stringify({ assetPaths: sourceAssets }));
  await publishInventory();
  await publishRecord();
  const watcher = new EventEmitter();
  const graph = new EventEmitter();
  const indexed = new Set(assets);
  let fileMapChecks = 0;
  graph.doesFileExist = path => {
    fileMapChecks += 1;
    return indexed.has(path);
  };
  const metroServer = {
    getWatchFolders: () => [],
    getBundler: () => ({ getBundler: () => ({ getWatcher: () => watcher, getDependencyGraph: async () => graph }) }),
  };
  const { watchUiSourcePluginInventory } = await import('./ensureWorkspacePackagesBuilt.mjs');
  const owner = watchUiSourcePluginInventory({ uiPackageDir, metroServer,
    metroConfig: { projectRoot: fixture.root, resolver: { sourceExts: ['js'], assetExts: ['bundle'] },
      watcher: { additionalExts: [] } },
    env: { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: inventoryPath },
    logger: { error() {} },
  });
  t.after(() => owner.close());
  // Observe the real filesystem boundary; keep inventory parsing, admission,
  // publication identity and the owner's existing watcher/queue real.
  const fs = createRequire(import.meta.url)('node:fs/promises');
  const counts = { assetStat: 0, assetRealpath: 0, publicationStat: 0 };
  for (const name of ['stat', 'realpath']) {
    const original = fs[name];
    t.mock.method(fs, name, async (path, ...args) => {
      if (assets.has(path)) counts[name === 'stat' ? 'assetStat' : 'assetRealpath'] += 1;
      if (name === 'stat' && [inventoryPath, recordPath].includes(path)) counts.publicationStat += 1;
      return original(path, ...args);
    });
  }
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const settleAdmission = () => Promise.race([
    owner.ready().then(() => 'served', error => error.code),
    new Promise(resolve => {
      const timer = setTimeout(() => resolve('stalled'), 1000);
      t.after(() => clearTimeout(timer));
    }),
  ]);
  // A cold start can miss plugin artifacts even with no source-assets record.
  await rm(recordPath);
  indexed.delete(pluginAssets[0]);
  assert.equal(await settleAdmission(), 'plugin_ui_inventory_unindexable',
    'an existing plugin artifact absent from Metro must settle without watcher events');
  indexed.add(pluginAssets[0]);
  await publishRecord();
  counts.assetStat = counts.assetRealpath = counts.publicationStat = fileMapChecks = 0;
  await Promise.all(Array.from({ length: 6 }, () => owner.ready()));
  t.diagnostic(`cold admission assets=${assets.size} ${JSON.stringify(counts)} fileMapChecks=${fileMapChecks}`);
  assert.equal(counts.assetStat, assets.size, 'concurrent requests share one admission for the published files');
  assert.equal(counts.assetRealpath, assets.size);
  const beforeWarm = { ...counts };
  const beforeChecks = fileMapChecks;
  await Promise.all(Array.from({ length: 6 }, () => owner.ready()));
  t.diagnostic(`warm admission assetStats=${counts.assetStat - beforeWarm.assetStat} assetRealpaths=${counts.assetRealpath - beforeWarm.assetRealpath} publicationStats=${counts.publicationStat - beforeWarm.publicationStat}`);
  assert.equal(counts.assetStat, beforeWarm.assetStat, 'already admitted artifacts need no per-request asset scan');
  assert.equal(counts.assetRealpath, beforeWarm.assetRealpath);
  assert.equal(fileMapChecks, beforeChecks, 'unchanged publication reuses Metro file-map admission');
  assert.equal(counts.publicationStat - beforeWarm.publicationStat, 12, 'external publication detection costs two metadata reads per request');

  // A one-shot child can atomically publish without this process's callback.
  // Missing Metro entries must fail visibly even when no watcher event arrives.
  const added = fixture.path('consumer/new-source.bundle');
  assets.add(added);
  sourceAssets.push(added);
  await writeFile(added, 'new asset');
  await publishRecord();
  const incumbentInventory = await (await import('node:fs/promises')).readFile(inventoryPath, 'utf8');
  const result = await settleAdmission();
  assert.equal(result, 'plugin_ui_inventory_unindexable',
    'an existing asset absent from Metro must settle without watcher events');
  assert.equal(await (await import('node:fs/promises')).readFile(inventoryPath, 'utf8'), incumbentInventory,
    'failed admission preserves the last-good inventory');
  indexed.add(added);
  await owner.ready(); // A later request retries failed admission after Metro catches up.

  const missing = fixture.path('consumer/missing-source.bundle');
  assets.add(missing);
  sourceAssets.push(missing);
  await publishRecord();
  await assert.rejects(owner.ready(), { code: 'plugin_ui_inventory_unindexable' });
  await writeFile(missing, 'repaired asset');
  indexed.add(missing);
  await owner.ready();
  await rm(missing);
  watcher.emit('change', { eventsQueue: [{ filePath: missing, type: 'delete' }] });
  await assert.rejects(owner.ready(), { code: 'plugin_ui_inventory_unindexable' },
    'removing an admitted asset invalidates readiness through the existing watcher');
  await writeFile(missing, 'repaired again');
  await owner.ready();
  await publishInventory();
  const beforeInventory = counts.assetStat;
  await owner.ready();
  assert.ok(counts.assetStat > beforeInventory, 'external plugin inventory replacement also needs admission');
});
