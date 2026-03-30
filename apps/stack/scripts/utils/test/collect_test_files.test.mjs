import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectTestFiles } from './collect_test_files.mjs';

async function createFixtureRoot(t, prefix = 'hstack-collect-test-files-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('collectTestFiles collects matching suffixes recursively, ignores dot entries, and returns sorted paths', async (t) => {
  const root = await createFixtureRoot(t);
  await mkdir(join(root, 'alpha', 'nested'), { recursive: true });
  await mkdir(join(root, '.hidden-dir'), { recursive: true });
  await writeFile(join(root, 'alpha', 'nested', 'z.test.mjs'), '');
  await writeFile(join(root, 'alpha', 'a.test.mjs'), '');
  await writeFile(join(root, '.hidden-dir', 'ignored.test.mjs'), '');
  await writeFile(join(root, '.ignored.test.mjs'), '');

  const files = await collectTestFiles({ dir: root, includeSuffixes: ['.test.mjs'] });

  assert.deepEqual(files, [
    join(root, 'alpha', 'a.test.mjs'),
    join(root, 'alpha', 'nested', 'z.test.mjs'),
  ]);
});

test('collectTestFiles honors excludeSuffixes for unit-vs-integration separation', async (t) => {
  const root = await createFixtureRoot(t);
  await mkdir(join(root, 'suite'), { recursive: true });
  await writeFile(join(root, 'suite', 'unit.test.mjs'), '');
  await writeFile(join(root, 'suite', 'regular.integration.test.mjs'), '');
  await writeFile(join(root, 'suite', 'real.real.integration.test.mjs'), '');

  const files = await collectTestFiles({
    dir: root,
    includeSuffixes: ['.test.mjs'],
    excludeSuffixes: ['.integration.test.mjs', '.real.integration.test.mjs'],
  });

  assert.deepEqual(files, [
    join(root, 'suite', 'unit.test.mjs'),
  ]);
});

test('collectTestFiles ignores vendored and generated directories', async (t) => {
  const root = await createFixtureRoot(t);
  await mkdir(join(root, 'tests'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(join(root, 'dist'), { recursive: true });
  await mkdir(join(root, 'dist.__sync_tmp__123'), { recursive: true });
  await mkdir(join(root, 'vendor'), { recursive: true });
  await mkdir(join(root, 'generated'), { recursive: true });

  await writeFile(join(root, 'tests', 'owned.test.mjs'), '');
  await writeFile(join(root, 'node_modules', 'pkg', 'vendored.test.mjs'), '');
  await writeFile(join(root, 'dist', 'generated.test.mjs'), '');
  await writeFile(join(root, 'dist.__sync_tmp__123', 'temp-sync.test.mjs'), '');
  await writeFile(join(root, 'vendor', 'vendor.test.mjs'), '');
  await writeFile(join(root, 'generated', 'generated.test.mjs'), '');

  const files = await collectTestFiles({ dir: root, includeSuffixes: ['.test.mjs'] });

  assert.deepEqual(files, [
    join(root, 'tests', 'owned.test.mjs'),
  ]);
});
