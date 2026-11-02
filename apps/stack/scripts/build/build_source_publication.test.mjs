import assert from 'node:assert/strict';
import fs, { existsSync } from 'node:fs';
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';

async function completedBundle(stacksRoot, name, completedMs = Date.now()) {
  const directory = join(stacksRoot, 'source-bundles', `runtime-${name}`);
  const entrypoint = join(directory, 'entry.mjs');
  await mkdir(directory, { recursive: true });
  await writeFile(entrypoint, 'export const ready = true;');
  const recordPath = join(directory, 'source-bundle.json');
  await writeFile(recordPath, JSON.stringify({ component: 'server', entrypoint }));
  await utimes(recordPath, completedMs / 1000, completedMs / 1000);
  return { directory, entrypoint };
}

test('shared bundle maintenance reclaims obsolete products without changing selections or private outputs',
  { skip: process.platform !== 'linux' }, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-shared-bundle-maintenance-' });
    const stacksRoot = fixture.path('stacks');
    const stackBaseDir = join(stacksRoot, 'consumer');
    const obsolete = await completedBundle(stacksRoot, 'obsolete', Date.now() - 20000);
    const selected = await completedBundle(stacksRoot, 'selected', Date.now() - 10000);
    const newest = await completedBundle(stacksRoot, 'newest');
    const privateOutput = join(stackBaseDir, 'source-runtime/bundle-private/entry.mjs');
    await mkdir(dirname(privateOutput), { recursive: true });
    await writeFile(privateOutput, 'export const retained = true;');
    const selectionPath = join(stackBaseDir, 'source-runtime/selected-server.json');
    const selection = JSON.stringify({ entrypoint: selected.entrypoint });
    await writeFile(selectionPath, selection);
    // Process discovery is the OS boundary; retain the real pin and retirement owners.
    const readdir = fs.promises.readdir;
    t.mock.method(fs.promises, 'readdir', async (path, ...args) =>
      String(path) === '/proc' ? [] : await readdir(path, ...args));
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const { reclaimSourceBundles } = await import('./build_source_runtime.mjs');
    await reclaimSourceBundles({ stacksRoot });
    assert.equal(existsSync(obsolete.entrypoint), true, 'maintenance defaults to dry-run');
    await reclaimSourceBundles({ stacksRoot, dryRun: false });
    assert.equal(existsSync(obsolete.directory), false);
    assert.equal(existsSync(selected.entrypoint), true, 'selected older products remain pinned');
    assert.equal(existsSync(newest.entrypoint), true, 'newest completed fallback remains available');
    assert.equal(existsSync(privateOutput), true, 'shared maintenance does not nominate private products');
    assert.equal(await readFile(selectionPath, 'utf8'), selection);
  });
