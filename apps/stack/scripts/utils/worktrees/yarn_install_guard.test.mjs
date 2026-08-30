import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, unlink, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { shouldRunYarnInstall, withYarnInstallGuard } from './yarn_install_guard.mjs';

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

test('shouldRunYarnInstall bootstraps the canonical snapshot even when legacy integrity is newer', async (t) => {
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

  assert.equal(await shouldRunYarnInstall({ installDir: dir, componentDir: dir }), true);
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

test('dependency refresh marker invalidates on root patch additions and deletions but ignores caller component patches', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-yarn-guard-input-set-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const previousHome = process.env.HAPPIER_STACK_HOME_DIR;
  process.env.HAPPIER_STACK_HOME_DIR = join(root, '.hstack-home');
  t.after(() => {
    if (previousHome === undefined) delete process.env.HAPPIER_STACK_HOME_DIR;
    else process.env.HAPPIER_STACK_HOME_DIR = previousHome;
  });

  const componentDir = join(root, 'apps', 'server');
  await mkdir(componentDir, { recursive: true });
  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"private":true}\n', 'utf-8');
  await writeFile(join(root, 'yarn.lock'), '# yarn\n', 'utf-8');
  await writeFile(join(componentDir, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'node_modules', '.yarn-integrity'), 'old\n', 'utf-8');

  const base = Date.now();
  await touch(join(root, 'node_modules', '.yarn-integrity'), base - 20_000);
  await touch(join(root, 'yarn.lock'), base);
  let refreshes = 0;
  await withYarnInstallGuard({ installDir: root, componentDir }, async () => {
    refreshes += 1;
  });
  assert.equal(await shouldRunYarnInstall({ installDir: root, componentDir }), false);

  await mkdir(join(componentDir, 'patches'), { recursive: true });
  await writeFile(join(componentDir, 'patches', 'caller.patch'), 'caller only\n', 'utf-8');
  assert.equal(
    await shouldRunYarnInstall({ installDir: root, componentDir }),
    false,
    'root installs must not vary by whichever component happened to call them',
  );

  await mkdir(join(root, 'patches'), { recursive: true });
  const rootPatch = join(root, 'patches', 'root.patch');
  await writeFile(rootPatch, 'root patch\n', 'utf-8');
  assert.equal(await shouldRunYarnInstall({ installDir: root, componentDir }), true);
  await withYarnInstallGuard({ installDir: root, componentDir }, async () => {
    refreshes += 1;
  });
  assert.equal(await shouldRunYarnInstall({ installDir: root, componentDir }), false);

  await unlink(rootPatch);
  assert.equal(
    await shouldRunYarnInstall({ installDir: root, componentDir }),
    true,
    'deleting a previously recorded input must invalidate the refresh marker',
  );
  assert.equal(refreshes, 2);
});

test('dependency refresh marker detects content changes when mtimes are preserved', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-yarn-guard-metadata-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const previousHome = process.env.HAPPIER_STACK_HOME_DIR;
  process.env.HAPPIER_STACK_HOME_DIR = join(dir, '.hstack-home');
  t.after(() => {
    if (previousHome === undefined) delete process.env.HAPPIER_STACK_HOME_DIR;
    else process.env.HAPPIER_STACK_HOME_DIR = previousHome;
  });

  const packageJson = join(dir, 'package.json');
  await writeFile(packageJson, '{}\n', 'utf-8');
  await writeFile(join(dir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await writeFile(join(dir, 'node_modules', '.yarn-integrity'), 'old\n', 'utf-8');
  const base = Date.now();
  await touch(join(dir, 'node_modules', '.yarn-integrity'), base - 20_000);
  await touch(packageJson, base);

  await withYarnInstallGuard({ installDir: dir, componentDir: dir }, async () => {});
  assert.equal(await shouldRunYarnInstall({ installDir: dir, componentDir: dir }), false);

  await writeFile(packageJson, '{"dependencies":{}}\n', 'utf-8');
  await touch(packageJson, base);
  assert.equal(await shouldRunYarnInstall({ installDir: dir, componentDir: dir }), true);
});

test('canonical guard detects declared directory additions, changes, and deletions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-yarn-guard-declared-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const previousHome = process.env.HAPPIER_STACK_HOME_DIR;
  process.env.HAPPIER_STACK_HOME_DIR = join(dir, '.hstack-home');
  t.after(() => {
    if (previousHome === undefined) delete process.env.HAPPIER_STACK_HOME_DIR;
    else process.env.HAPPIER_STACK_HOME_DIR = previousHome;
  });

  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ happier: { installFreshnessInputs: ['install-inputs'] } }) + '\n',
    'utf-8',
  );
  await writeFile(join(dir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await writeFile(join(dir, 'node_modules', '.yarn-integrity'), 'old\n', 'utf-8');
  const input = join(dir, 'install-inputs', 'a.txt');

  let refreshes = 0;
  const refresh = async () => {
    refreshes += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
  };
  await Promise.all([
    withYarnInstallGuard({ installDir: dir, componentDir: dir }, refresh),
    withYarnInstallGuard({ installDir: dir, componentDir: dir }, refresh),
  ]);
  assert.equal(await shouldRunYarnInstall({ installDir: dir, componentDir: dir }), false);

  await mkdir(join(dir, 'install-inputs'), { recursive: true });
  await writeFile(input, 'a\n', 'utf-8');
  assert.equal(await shouldRunYarnInstall({ installDir: dir, componentDir: dir }), true);
  await withYarnInstallGuard({ installDir: dir, componentDir: dir }, refresh);

  const added = join(dir, 'install-inputs', 'b.txt');
  await writeFile(added, 'b\n', 'utf-8');
  assert.equal(await shouldRunYarnInstall({ installDir: dir, componentDir: dir }), true);
  await withYarnInstallGuard({ installDir: dir, componentDir: dir }, refresh);

  await writeFile(input, 'changed-size\n', 'utf-8');
  assert.equal(await shouldRunYarnInstall({ installDir: dir, componentDir: dir }), true);
  await withYarnInstallGuard({ installDir: dir, componentDir: dir }, refresh);

  await unlink(added);
  assert.equal(await shouldRunYarnInstall({ installDir: dir, componentDir: dir }), true);
  await withYarnInstallGuard({ installDir: dir, componentDir: dir }, refresh);
  assert.equal(refreshes, 5);
});
