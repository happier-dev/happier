// @happier-test-preparation source
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
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
  const open = (getDependencyGraph, watchFolders = []) => {
    const watcher = new EventEmitter();
    const owner = watchUiSourcePluginInventory({ uiPackageDir,
      metroServer: {
        getWatchFolders: () => watchFolders,
        getBundler: () => ({ getBundler: () => ({ getWatcher: () => watcher, getDependencyGraph }) }),
      },
      metroConfig: { projectRoot: fixture.root,
        resolver: { sourceExts: ['js'], assetExts: ['bundle'] }, watcher: { additionalExts: [] } },
      env: { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root,
        HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: inventoryPath },
      logger: { error() {} },
    });
    t.after(() => owner.close());
    return { ...owner, watcher };
  };
  return { assetPath, fixture, open };
}

test('bundle readiness waits for a source refresh already preparing its successor inventory', async t => {
  const { fixture, open } = await inventoryFixture(t);
  let began;
  const preparing = new Promise(resolve => { began = resolve; });
  let release;
  const graphReady = new Promise(resolve => { release = resolve; });
  let graphReads = 0;
  // Metro is a genuine system boundary. Hold preparation at its initial crawl,
  // before any compiler child starts; subsequent reads can admit the old graph.
  const owner = open(() => {
    if (++graphReads === 1) { began(); return graphReady; }
    return Promise.resolve({ doesFileExist: () => true });
  });
  owner.watcher.emit('change', { eventsQueue: [{ type: 'change',
    filePath: fixture.path('source/apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs') }] });
  await preparing;
  const readiness = owner.ready();
  readiness.catch(() => {});
  try {
    // This is a test observation window, not a product timeout. Serving here
    // gives a freshly reloaded HMR-disabled tab the previous immutable graph.
    assert.equal(await Promise.race([readiness.then(() => 'served'), delay(100, 'pending')]), 'pending');
  } finally {
    const closing = owner.close();
    release({ doesFileExist: () => true });
    await closing;
  }
  await assert.rejects(readiness, { name: 'AbortError' });
});

test('bundle readiness includes source changes still discovering their compiler inputs', async t => {
  const { fixture, open } = await inventoryFixture(t);
  const cliPath = fixture.path('source/apps/cli/package.json');
  let began;
  const discovering = new Promise(resolve => { began = resolve; });
  let release;
  const sourceReady = new Promise(resolve => { release = resolve; });
  const read = fs.promises.readFile;
  t.mock.method(fs.promises, 'readFile', async (path, ...args) => {
    if (path === cliPath) { began(); await sourceReady; }
    return read(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const owner = open(async () => ({ doesFileExist: () => true }));
  await discovering;
  owner.watcher.emit('change', { eventsQueue: [{ type: 'change',
    filePath: fixture.path('source/apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs') }] });
  const readiness = owner.ready();
  readiness.catch(() => {});
  try {
    assert.equal(await Promise.race([readiness.then(() => 'served'), delay(100, 'pending')]), 'pending');
  } finally {
    const closing = owner.close();
    release();
    await closing;
  }
  await assert.rejects(readiness, { name: 'AbortError' });
});

test('retiring an unrelated watch folder does not block valid inventory assets', async t => {
  const { assetPath, fixture, open } = await inventoryFixture(t);
  // Metro retains this startup root after a workspace package is removed.
  const retiredRoot = fixture.path('source/packages/connected-accounts-protocol');
  await mkdir(retiredRoot, { recursive: true });
  const owner = open(async () => ({ doesFileExist: () => true }), [retiredRoot]);
  await rm(retiredRoot, { recursive: true });
  await owner.ready();
  await owner.close();

  await rm(assetPath);
  const missingAsset = open(async () => ({ doesFileExist: () => true }), [retiredRoot]);
  await assert.rejects(missingAsset.ready(), { code: 'plugin_ui_inventory_unindexable' },
    'ignoring a retired root must not admit a missing consumed artifact');
});

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
