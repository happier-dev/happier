import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('ui-mobile-release can bump the UI marketing version before native builds (dry-run)', () => {
  const out = execFileSync(
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
      'production-preview',
      '--ui-version-bump',
      'patch',
      '--allow-dirty',
      'true',
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

  assert.match(out, /scripts\/pipeline\/expo\/bump-ui-version\.mjs/);
  assert.match(out, /--bump/);
  assert.match(out, /patch/);
});

test('ui-mobile-release rejects --ui-version-bump outside production environment', () => {
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
          'ui-mobile-release',
          '--environment',
          'preview',
          '--action',
          'native_submit',
          '--platform',
          'ios',
          '--profile',
          'preview',
          '--ui-version-bump',
          'patch',
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
      assert.match(stderr, /ui-version-bump/i);
      assert.match(stderr, /production/i);
      return true;
    },
  );
});

test('ui-mobile-release rejects --ui-version and --ui-version-bump together', () => {
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
          'native_submit',
          '--platform',
          'ios',
          '--profile',
          'production-preview',
          '--ui-version-bump',
          'patch',
          '--ui-version',
          '0.1.1',
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
      assert.match(stderr, /ui-version/i);
      assert.match(stderr, /ui-version-bump/i);
      return true;
    },
  );
});
