import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, utimes, symlink, access, rm, link, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { reapHistoricalTempRoots } from './historical_temp_roots.mjs';

test('historical sweep reclaims only old known roots with no cwd, fd or mapped-file users', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-historical-' });
  const temp = join(root, 'tmp'), proc = join(root, 'proc');
  await mkdir(temp);
  await mkdir(join(proc, '42', 'fd'), { recursive: true });
  // procfs is the genuine OS boundary; directory fixtures model cwd/fds/maps.
  await writeFile(join(proc, '42', 'status'), 'State:\tS (sleeping)\n');
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  for (const name of ['happier-old', 'hstack-old', 'docs-check-old', 'happier-cwd', 'happier-fd', 'happier-mapped', 'happier-recent-child', 'happier-collision', 'happier-weird\\name', 'random-name']) {
    const dir = join(temp, name);
    await mkdir(dir);
    await writeFile(join(dir, 'data'), 'retained or reclaimed');
    await utimes(join(dir, 'data'), old, old);
    await utimes(dir, old, old);
  }
  await symlink(join(temp, 'happier-cwd'), join(proc, '42', 'cwd'));
  await symlink(join(temp, 'happier-fd', 'data'), join(proc, '42', 'fd', '9'));
  await symlink(join(temp, 'happier-collision') + '2/data', join(proc, '42', 'fd', '10'));
  await writeFile(join(proc, '42', 'maps'), `1-2 r--p 0 00:00 1 ${join(temp, 'happier-mapped', 'data')}\n`);
  await utimes(join(temp, 'happier-recent-child', 'data'), new Date(), new Date());
  await symlink(join(temp, 'random-name'), join(temp, 'happier-symlink'));
  const result = reapHistoricalTempRoots(temp, proc);
  assert.equal(result.reclaimedRoots, 4);
  assert.ok(result.reclaimedBytes > 0);
  for (const name of ['happier-old', 'hstack-old', 'docs-check-old', 'happier-collision']) {
    await assert.rejects(access(join(temp, name)), { code: 'ENOENT' });
  }
  for (const name of ['happier-cwd', 'happier-fd', 'happier-mapped', 'happier-recent-child', 'happier-weird\\name', 'random-name', 'happier-symlink']) await access(join(temp, name));
  assert.equal(reapHistoricalTempRoots(temp, proc).reclaimedRoots, 0);
});

test('historical sweep retains old roots when live process observation is unavailable', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-historical-unknown-' });
  const temp = join(root, 'tmp'), proc = join(root, 'proc');
  const dir = join(temp, 'happier-old');
  await mkdir(dir, { recursive: true });
  await mkdir(join(proc, '42'), { recursive: true });
  await writeFile(join(proc, '42', 'status'), 'State:\tS (sleeping)\n');
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(dir, old, old);
  const result = reapHistoricalTempRoots(temp, proc);
  assert.equal(result.reclaimedRoots, 0);
  assert.equal(result.retainedRoots, 1);
  await access(dir);
  await rm(join(proc, '42'), { recursive: true });
  assert.equal(reapHistoricalTempRoots(temp, proc).reclaimedRoots, 1);
});

test('owner-supplied staging candidates reuse historical custody and retain mapped hard links and symlinks', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-staging-retention-' });
  const parent = join(root, 'runtime-build'), proc = join(root, 'proc');
  await mkdir(parent);
  await mkdir(join(proc, '42', 'fd'), { recursive: true });
  await writeFile(join(proc, '42', 'status'), 'State:\tS (sleeping)\n');
  await symlink(root, join(proc, '42', 'cwd'));
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  for (const name of ['linux-arm64', 'darwin-arm64', 'unknown']) {
    await mkdir(join(parent, name));
    await writeFile(join(parent, name, 'output'), 'regenerable');
    await utimes(join(parent, name, 'output'), old, old);
    await utimes(join(parent, name), old, old);
  }
  await link(join(parent, 'darwin-arm64', 'output'), join(root, 'mapped-output'));
  await writeFile(join(proc, '42', 'maps'), `1-2 r--p 0 00:00 1 ${join(root, 'mapped-output')}\n`);
  await symlink(join(parent, 'unknown'), join(parent, 'linux-x64'));
  const result = reapHistoricalTempRoots(parent, proc, { candidateNames: ['linux-arm64', 'darwin-arm64', 'linux-x64'] });
  assert.equal(result.reclaimedRoots, 1);
  await assert.rejects(access(join(parent, 'linux-arm64')), { code: 'ENOENT' });
  for (const name of ['darwin-arm64', 'unknown', 'linux-x64']) await access(join(parent, name));
  assert.throws(() => reapHistoricalTempRoots(parent, proc, { candidateNames: ['../mapped-output'] }), /candidate/);
});

test('count-retention owners can reclaim recent unheld candidates while retaining another uid', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-count-retention-' });
  const parent = join(root, 'cache'), proc = join(root, 'proc');
  await mkdir(join(parent, 'obsolete'), { recursive: true });
  await mkdir(proc);
  await writeFile(join(parent, 'obsolete', 'data'), 'x'.repeat(8192));
  await link(join(parent, 'obsolete', 'data'), join(parent, 'obsolete', 'alias'));
  const allocatedBytes = ((await stat(join(parent, 'obsolete'))).blocks + (await stat(join(parent, 'obsolete', 'data'))).blocks) * 512;
  const options = { candidateNames: ['obsolete'], minimumAgeMs: 0 };
  assert.equal(reapHistoricalTempRoots(parent, proc, { ...options, ownerUid: process.getuid() + 1 }).reclaimedRoots, 0);
  const result = reapHistoricalTempRoots(parent, proc, options);
  assert.equal(result.reclaimedRoots, 1);
  assert.equal(result.reclaimedBytes, allocatedBytes, 'hard-linked Cargo outputs occupy storage once');
});
