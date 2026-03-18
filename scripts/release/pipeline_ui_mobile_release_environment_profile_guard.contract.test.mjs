import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('ui-mobile-release rejects environment/profile mismatches (production env with preview profile)', () => {
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
          'ui-mobile-release',
          '--environment',
          'production',
          '--action',
          'native',
          '--platform',
          'ios',
          '--profile',
          'preview',
          '--native-build-mode',
          'local',
          '--dry-run',
          '--secrets-source',
          'env',
        ],
        {
          cwd: repoRoot,
          env: { ...process.env, EXPO_TOKEN: '' },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30_000,
        },
      ),
    (err) => {
      assert.equal(typeof err, 'object');
      const stderr = /** @type {any} */ (err).stderr?.toString?.() ?? '';
      assert.match(stderr, /--profile/i);
      assert.match(stderr, /production/i);
      assert.match(stderr, /preview/i);
      return true;
    },
  );
});

test('ui-mobile-release accepts development and canary native profiles in dry-run', () => {
  for (const [environment, profile] of [
    ['development', 'development'],
    ['canary', 'canary-apk'],
  ]) {
    const out = execFileSync(
      process.execPath,
      [
        path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
        'ui-mobile-release',
        '--environment',
        environment,
        '--action',
        'native',
        '--platform',
        'android',
        '--profile',
        profile,
        '--dry-run',
        '--secrets-source',
        'env',
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, EXPO_TOKEN: 'expo-token' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );

    assert.match(out, new RegExp(`\\[pipeline\\] ui-mobile release: environment=${environment} action=native`));
  }
});

test('ui-mobile-release forwards explicit interactive setting to delegated Expo commands', () => {
  const out = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'ui-mobile-release',
      '--environment',
      'development',
      '--action',
      'ota',
      '--platform',
      'all',
      '--interactive',
      'false',
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, EXPO_TOKEN: 'expo-token' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] ui-mobile release: environment=development action=ota platform=all/);
  assert.match(out, /scripts\/pipeline\/expo\/ota-update\.mjs/);
  assert.match(out, /--interactive"?\s+"?false\b/);
});

test('ui-mobile-release rejects native_submit outside preview and production', () => {
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
          'ui-mobile-release',
          '--environment',
          'canary',
          '--action',
          'native_submit',
          '--platform',
          'ios',
          '--profile',
          'canary',
          '--dry-run',
          '--secrets-source',
          'env',
        ],
        {
          cwd: repoRoot,
          env: { ...process.env, EXPO_TOKEN: 'expo-token' },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30_000,
        },
      ),
    (err) => {
      const stderr = /** @type {any} */ (err).stderr?.toString?.() ?? '';
      assert.match(stderr, /native_submit/i);
      assert.match(stderr, /preview/i);
      assert.match(stderr, /production/i);
      return true;
    },
  );
});
