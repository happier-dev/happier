import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { reapExpoPluginUiArtifacts } from './command.mjs';

test('a live Metro releases superseded plugin graphs by reference and keeps only graphs in use', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-expo-artifact-retention-' });
  const parent = fixture.path('plugin-ui');
  const inventoryPath = join(parent, 'inventory.js');
  const statePath = fixture.path('expo.state.json');
  const preparation = join(parent, 'preparation-ABC123');
  const superseded = join(parent, 'artifacts/fixture', 'a'.repeat(64));
  const inUse = join(parent, 'artifacts/fixture', 'b'.repeat(64));
  for (const root of [preparation, superseded, inUse]) {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'old.chunk.bundle'), 'old unreferenced graph');
  }
  await writeFile(inventoryPath, 'export const BUNDLED_PLUGIN_UI_APP_ARTIFACTS = {};');
  const historical = new Date(Date.now() - 48 * 60 * 60 * 1000);
  for (const root of [preparation, superseded, inUse]) {
    await utimes(join(root, 'old.chunk.bundle'), historical, historical);
    await utimes(root, historical, historical);
  }
  // A real live process stands in for Metro: bound to the inventory like the
  // dev server, with its cwd inside one graph. Only the /proc listing is
  // narrowed to it (OS boundary); state, inventory and deletion stay real.
  const metro = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: inUse, stdio: 'ignore',
    env: { ...process.env, HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: inventoryPath } });
  t.after(() => metro.kill('SIGKILL'));
  await writeFile(statePath, JSON.stringify({ pid: metro.pid }));
  const readdir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (path, ...args) => path === '/proc' ? [String(metro.pid)] : readdir(path, ...args));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const options = { projectDir: fileURLToPath(new URL('../../../../ui/', import.meta.url)), inventoryPath, statePath };
  const dry = await reapExpoPluginUiArtifacts({ ...options, dryRun: true });
  assert.equal(dry.reclaimableRoots, 2, 'superseded graphs are nominated while Metro lives');
  await stat(superseded);
  const result = await reapExpoPluginUiArtifacts(options);
  assert.equal(result.reclaimedRoots, 2, 'a live Metro no longer pins every graph it ever served');
  await assert.rejects(stat(superseded), { code: 'ENOENT' });
  await assert.rejects(stat(preparation), { code: 'ENOENT' });
  await stat(inUse); // a graph a live process uses is never deleted
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
