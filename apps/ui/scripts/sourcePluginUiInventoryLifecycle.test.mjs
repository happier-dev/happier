// @happier-test-preparation source
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { createTempFixture } from '../../stack/scripts/testkit/core/temp_fixture.mjs';
import { watchUiSourcePluginInventory } from './ensureWorkspacePackagesBuilt.mjs';

async function inventoryFixture(t) {
  const fixture = await createTempFixture(t, { prefix: 'happier-ui-inventory-lifecycle-' });
  const uiPackageDir = fixture.path('source/apps/ui');
  await mkdir(join(uiPackageDir, 'scripts'), { recursive: true });
  await writeFile(join(uiPackageDir, 'scripts/prepareSourcePluginUiArtifacts.mjs'), 'export {};');
  await mkdir(fixture.path('source/apps/cli'), { recursive: true });
  await writeFile(fixture.path('source/apps/cli/package.json'), JSON.stringify({ bundledDependencies: [] }));
  const inventoryPath = fixture.path('inventory.js');
  const assetPath = fixture.path('entry.cjs.bundle');
  await writeFile(assetPath, 'module.exports = {};');
  // This is the filesystem publication consumed by Metro readiness. The real
  // parser and admission owner run beneath the external Metro boundary.
  await writeFile(inventoryPath,
    `const BUNDLED_PLUGIN_UI_APP_ASSET_0 = require(${JSON.stringify(assetPath)});\n` +
    'export const BUNDLED_PLUGIN_UI_APP_ARTIFACTS = [];\n');
  const open = getDependencyGraph => {
    const watcher = new EventEmitter();
    const owner = watchUiSourcePluginInventory({ uiPackageDir,
      metroServer: {
        getWatchFolders: () => [],
        getBundler: () => ({ getBundler: () => ({ getWatcher: () => watcher, getDependencyGraph }) }),
      },
      metroConfig: { projectRoot: fixture.root,
        resolver: { sourceExts: ['js'], assetExts: ['bundle'] }, watcher: { additionalExts: [] } },
      env: { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root,
        HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: inventoryPath },
      logger: { error() {} },
    });
    t.after(() => owner.close());
    return owner;
  };
  return { assetPath, open };
}

test('a restarted Metro owner re-admits retained inventory against its new file map', async t => {
  const { assetPath, open } = await inventoryFixture(t);
  const first = open(async () => ({ doesFileExist: () => true }));
  await first.ready();
  await first.close();

  const indexed = new Set();
  const restarted = open(async () => ({ doesFileExist: path => indexed.has(path) }));
  await assert.rejects(restarted.ready(), { code: 'plugin_ui_inventory_unindexable' },
    'a previous process admission cannot stand in for the restarted Metro crawl');
  indexed.add(assetPath);
  await restarted.ready();
});

test('closing Metro cancels in-flight inventory admission before late graph readiness can serve it', async t => {
  const { open } = await inventoryFixture(t);
  let graphRequested;
  const requested = new Promise(resolve => { graphRequested = resolve; });
  let releaseGraph;
  const graphReady = new Promise(resolve => { releaseGraph = resolve; });
  const owner = open(() => { graphRequested(); return graphReady; });
  const readiness = assert.rejects(owner.ready(), { name: 'AbortError' },
    'an admission already waiting on Metro must observe close before it serves');
  await requested;
  await owner.close();
  releaseGraph({ doesFileExist: () => true });
  await readiness;
  await assert.rejects(owner.ready(), { name: 'AbortError' },
    'new requests cannot reuse a closed serving lifetime');
});
