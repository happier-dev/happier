import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { resolveExpoTmpDir } from './expo.mjs';

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
