import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { reapExpoPluginUiArtifacts } from './command.mjs';

test('Stack reclaims retired plugin preparations through the UI owner while live or unknown state retains them', { skip: typeof process.getuid !== 'function' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-expo-artifact-retention-' });
  const parent = fixture.path('plugin-ui');
  const inventoryPath = join(parent, 'inventory.js');
  const statePath = fixture.path('expo.state.json');
  const preparation = join(parent, 'preparation-ABC123');
  await mkdir(preparation, { recursive: true });
  await writeFile(join(preparation, 'old.chunk.bundle'), 'old unreferenced graph');
  await writeFile(inventoryPath, 'export const BUNDLED_PLUGIN_UI_APP_ARTIFACTS = {};');
  const historical = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(join(preparation, 'old.chunk.bundle'), historical, historical);
  await utimes(preparation, historical, historical);
  // The complete kernel process list is the OS boundary. The state reader,
  // UI inventory owner, historical policy and deletion path remain real.
  const readdir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (path, ...args) => path === '/proc' ? [] : readdir(path, ...args));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const options = { projectDir: fileURLToPath(new URL('../../../../ui/', import.meta.url)), inventoryPath, statePath };
  await writeFile(statePath, JSON.stringify({ pid: process.pid }));
  assert.equal((await reapExpoPluginUiArtifacts(options)).reclaimedRoots, 0);
  await stat(preparation);
  const previous = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(previous, 'close');
  await writeFile(statePath, JSON.stringify({ pid: previous.pid }));
  const dry = await reapExpoPluginUiArtifacts({ ...options, dryRun: true });
  assert.equal(dry.reclaimableRoots, 1, 'the stopped Expo lifecycle nominates its superseded preparation');
  assert.equal(dry.reclaimedRoots, 0);
  await stat(preparation);
  const retiredState = await readFile(statePath, 'utf8');
  await writeFile(statePath, '{}');
  assert.equal((await reapExpoPluginUiArtifacts(options)).reclaimedRoots, 0, 'unknown lifecycle retains served graphs');
  await stat(preparation);
  await writeFile(statePath, retiredState);
  assert.equal((await reapExpoPluginUiArtifacts(options)).reclaimedRoots, 1);
  await assert.rejects(stat(preparation), { code: 'ENOENT' });
  assert.equal(await readFile(inventoryPath, 'utf8'), 'export const BUNDLED_PLUGIN_UI_APP_ARTIFACTS = {};');
});


test('artifact retirement reads an unchanged inventory once per pass, independent of retired roots', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-expo-retention-cost-' });
  const { reapBundledPluginUiArtifactStore } = await import('../../../../ui/scripts/generateBundledPluginUiArtifacts.mjs');
  const inventoryPath = fixture.path('inventory.js');
  const artifactStoreDir = fixture.path('artifacts');
  const procRoot = fixture.path('empty-proc');
  await mkdir(procRoot);
  const historical = new Date(Date.now() - 48 * 60 * 60 * 1000);
  for (let index = 0; index < 64; index++) {
    const path = join(artifactStoreDir, 'fixture', index.toString(16).padStart(64, '0'));
    await mkdir(path, { recursive: true });
    await utimes(path, historical, historical);
  }
  await writeFile(inventoryPath, 'export const BUNDLED_PLUGIN_UI_APP_ARTIFACTS = {};');
  let inventoryReads = 0;
  const readFile = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (path === inventoryPath) inventoryReads++;
    return readFile(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    const result = reapBundledPluginUiArtifactStore({ artifactStoreDir, inventoryPaths: [inventoryPath],
      procRoot, dryRun: true, retainCandidate: () => false });
    assert.equal(result.reclaimableRoots, 64);
    assert.equal(inventoryReads, 1, 'reference parsing scales with publications, not retired generations');
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
