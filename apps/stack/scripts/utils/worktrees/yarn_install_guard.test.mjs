import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { shouldRunYarnInstall } from './yarn_install_guard.mjs';

async function touch(path, ms) {
  const d = new Date(ms);
  await utimes(path, d, d);
}

test('shouldRunYarnInstall returns true when node_modules is missing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-yarn-guard-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(dir, 'yarn.lock'), '#\n', 'utf-8');

  assert.equal(await shouldRunYarnInstall({ installDir: dir, componentDir: dir }), true);
});

test('shouldRunYarnInstall returns false when integrity is newer than lock/pkg/patches', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-yarn-guard-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(dir, 'yarn.lock'), '#\n', 'utf-8');
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await writeFile(join(dir, 'node_modules', '.yarn-integrity'), 'x\n', 'utf-8');

  const base = Date.now();
  await touch(join(dir, 'package.json'), base - 10_000);
  await touch(join(dir, 'yarn.lock'), base - 9_000);
  await touch(join(dir, 'node_modules', '.yarn-integrity'), base);

  assert.equal(await shouldRunYarnInstall({ installDir: dir, componentDir: dir }), false);
});

test('shouldRunYarnInstall returns true when yarn.lock is newer than integrity', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-yarn-guard-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(dir, 'yarn.lock'), '#\n', 'utf-8');
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await writeFile(join(dir, 'node_modules', '.yarn-integrity'), 'x\n', 'utf-8');

  const base = Date.now();
  await touch(join(dir, 'node_modules', '.yarn-integrity'), base - 10_000);
  await touch(join(dir, 'yarn.lock'), base);

  assert.equal(await shouldRunYarnInstall({ installDir: dir, componentDir: dir }), true);
});

test('shouldRunYarnInstall returns true when patches are newer than integrity', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-yarn-guard-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(dir, 'yarn.lock'), '#\n', 'utf-8');
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await writeFile(join(dir, 'node_modules', '.yarn-integrity'), 'x\n', 'utf-8');
  await mkdir(join(dir, 'patches'), { recursive: true });
  await writeFile(join(dir, 'patches', 'a.patch'), 'diff\n', 'utf-8');

  const base = Date.now();
  await touch(join(dir, 'node_modules', '.yarn-integrity'), base - 10_000);
  await touch(join(dir, 'patches', 'a.patch'), base);

  assert.equal(await shouldRunYarnInstall({ installDir: dir, componentDir: dir }), true);
});
