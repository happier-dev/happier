import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveExpoTmpDir } from './expo.mjs';
import { withExpoPreparationEnv } from './command.mjs';

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
