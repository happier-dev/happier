import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { inspectDependencyRefresh, withDependencyRefresh } from './dependency_refresh.mjs';

test('dependency admission repairs an exact node_modules self-link without reinstalling', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dependency-self-link-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const nodeModules = join(root, 'node_modules');
  await Promise.all([
    mkdir(nodeModules, { recursive: true }),
    writeFile(join(root, 'package.json'), '{"name":"fixture","private":true}\n', 'utf8'),
    writeFile(join(root, 'yarn.lock'), '# fixture\n', 'utf8'),
  ]);

  let refreshCount = 0;
  await withDependencyRefresh({ installDir: root }, async () => {
    refreshCount += 1;
  });
  assert.equal(refreshCount, 1);
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, false);

  const invalidLink = join(nodeModules, 'node_modules');
  await symlink(nodeModules, invalidLink, 'dir');
  const corrupted = await inspectDependencyRefresh({ installDir: root });
  assert.equal(corrupted.required, true);
  assert.equal(corrupted.selfReferentialNodeModulesLinkPath, invalidLink);

  const repaired = await withDependencyRefresh({ installDir: root }, async () => {
    refreshCount += 1;
  });
  assert.deepEqual(repaired, {
    refreshed: false,
    reason: 'repaired-self-referential-node-modules-link',
  });
  assert.equal(refreshCount, 1, 'repairing the exact self-link must not run a package install');
  await assert.rejects(() => lstat(invalidLink), { code: 'ENOENT' });
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, false);
});
