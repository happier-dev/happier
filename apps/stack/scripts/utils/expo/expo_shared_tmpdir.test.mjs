import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveExpoTmpDir } from './expo.mjs';
import { withExpoPreparationEnv } from './command.mjs';

test('preparation keeps child IPC paths within sun_path even with a long workspace tmpdir', async (t) => {
  const workspaceTmp = await mkdtemp(join(tmpdir(), 'workspace-preparation-'));
  t.after(() => rm(workspaceTmp, { recursive: true, force: true }));
  const inheritedTmp = join(workspaceTmp, 'long-workspace-directory-'.repeat(5), 'tmp');
  await mkdir(inheritedTmp, { recursive: true });
  const sourceEnv = { TMPDIR: inheritedTmp, TMP: inheritedTmp, TEMP: inheritedTmp };
  let preparationTmp;
  await withExpoPreparationEnv(sourceEnv, async (env) => {
    preparationTmp = env.TMPDIR;
    assert.equal(env.TMP, preparationTmp);
    assert.equal(env.TEMP, preparationTmp);
    if (process.platform === 'win32') {
      assert.equal(preparationTmp.startsWith(inheritedTmp), true);
    } else {
      // tsx's observed uid/pid suffix; sun_path needs one byte for its NUL.
      const ipcPath = join(preparationTmp, 'tsx-501', '98970.pipe');
      const usableBytes = process.platform === 'darwin' ? 103 : 107;
      assert.ok(Buffer.byteLength(ipcPath) <= usableBytes,
        `child IPC path is ${Buffer.byteLength(ipcPath)} bytes; maximum ${usableBytes}`);
    }
    assert.equal((await stat(preparationTmp)).isDirectory(), true);
  });
  assert.equal(sourceEnv.TMPDIR, inheritedTmp);
  await assert.rejects(stat(preparationTmp), { code: 'ENOENT' });
});

function sha1_12(s) {
  return createHash('sha1').update(String(s ?? '')).digest('hex').slice(0, 12);
}

test('resolveExpoTmpDir returns default when shared tmpdir is not configured', () => {
  const def = '/tmp/default';
  const got = resolveExpoTmpDir({
    env: {},
    defaultTmpDir: def,
    kind: 'expo-dev',
    projectDir: '/proj/apps/ui',
  });
  assert.equal(got, def);
});

test('resolveExpoTmpDir uses shared base dir + key when configured', () => {
  const base = '/cache/expo';
  const key = 'happier-dev/happier';
  const kind = 'expo-dev';
  const expected = join(base, 'tmp', kind, sha1_12(key));
  const got = resolveExpoTmpDir({
    env: {
      HAPPIER_STACK_EXPO_SHARED_TMPDIR_BASE_DIR: base,
      HAPPIER_STACK_EXPO_SHARED_TMPDIR_KEY: key,
    },
    defaultTmpDir: '/tmp/default',
    kind,
    projectDir: '/proj/apps/ui',
  });
  assert.equal(got, expected);
});

test('withExpoPreparationEnv isolates concurrent one-shot tools from the persistent Metro tmpdir', async (t) => {
  const persistentTmpDir = await mkdtemp(join(tmpdir(), 'hstack-expo-persistent-'));
  t.after(async () => {
    await rm(persistentTmpDir, { recursive: true, force: true });
  });
  const sourceEnv = { TMPDIR: persistentTmpDir, TMP: persistentTmpDir, TEMP: persistentTmpDir };
  const observed = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const runs = [1, 2].map(() => withExpoPreparationEnv(sourceEnv, async (env) => {
    observed.push({
      tmpdir: env.TMPDIR,
      tmp: env.TMP,
      temp: env.TEMP,
    });
    await gate;
    return env.TMPDIR;
  }));

  while (observed.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.notEqual(observed[0].tmpdir, observed[1].tmpdir);
  for (const entry of observed) {
    assert.notEqual(entry.tmpdir, persistentTmpDir);
    assert.equal(entry.tmp, entry.tmpdir);
    assert.equal(entry.temp, entry.tmpdir);
    assert.equal((await stat(entry.tmpdir)).isDirectory(), true);
  }
  assert.equal(sourceEnv.TMPDIR, persistentTmpDir);

  release();
  const returnedPaths = await Promise.all(runs);
  for (const path of returnedPaths) {
    await assert.rejects(() => stat(path), { code: 'ENOENT' });
  }
});

test('preparation reaps abandoned historical scratch but preserves active preparation and unrelated data', { skip: process.platform !== 'linux' }, async t => {
  const persistentTmpDir = await mkdtemp(join(tmpdir(), 'hstack-expo-retention-'));
  t.after(() => rm(persistentTmpDir, { recursive: true, force: true }));
  // The kernel's process inventory is the OS boundary. All candidate selection,
  // age, tree identity and deletion behavior beneath it remains real.
  const readdir = fs.readdirSync;
  const realpath = fs.realpathSync;
  t.mock.method(fs, 'realpathSync', (path, ...args) => path === '/tmp' ? persistentTmpDir : realpath(path, ...args));
  t.mock.method(fs, 'readdirSync', (path, ...args) => path === '/proc' ? [] : readdir(path, ...args));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const historical = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const abandoned = join(persistentTmpDir, 'happier-expo-preparation-ABC123');
  const unrelated = join(persistentTmpDir, 'happier-other-work-ABC123');
  for (const directory of [abandoned, unrelated]) {
    await mkdir(directory);
    await writeFile(join(directory, 'data'), 'retained fixture');
    await utimes(join(directory, 'data'), historical, historical);
    await utimes(directory, historical, historical);
  }
  await withExpoPreparationEnv({ TMPDIR: persistentTmpDir }, async active => {
    await utimes(active.TMPDIR, historical, historical);
    await withExpoPreparationEnv({ TMPDIR: persistentTmpDir }, async () => {
      await assert.rejects(stat(abandoned), { code: 'ENOENT' });
      assert.equal((await stat(active.TMPDIR)).isDirectory(), true);
      assert.equal((await stat(unrelated)).isDirectory(), true);
    });
  });
});

test('unavailable historical scratch observation retains data and permits current preparation', async t => {
  const persistentTmpDir = await mkdtemp(join(tmpdir(), 'hstack-expo-retention-unavailable-'));
  t.after(() => rm(persistentTmpDir, { recursive: true, force: true }));
  const readdir = fs.readdirSync;
  const realpath = fs.realpathSync;
  t.mock.method(fs, 'realpathSync', (path, ...args) => path === '/tmp' ? persistentTmpDir : realpath(path, ...args));
  t.mock.method(fs, 'readdirSync', (path, ...args) => {
    if (path === persistentTmpDir) throw Object.assign(new Error('read denied'), { code: 'EACCES' });
    return readdir(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await withExpoPreparationEnv({ TMPDIR: persistentTmpDir }, async () => 'prepared');
  assert.equal(result, 'prepared');
});
