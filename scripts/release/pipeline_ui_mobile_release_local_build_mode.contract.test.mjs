import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('ui-mobile-release supports local EAS builds (delegates --build-mode local)', () => {
  const out = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'ui-mobile-release',
      '--environment',
      'preview',
      '--action',
      'native',
      '--platform',
      'android',
      '--profile',
      'preview-apk',
      '--native-build-mode',
      'local',
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, EXPO_TOKEN: 'test-token' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] ui-mobile release:/);
  assert.match(out, /scripts\/pipeline\/expo\/native-build\.mjs/);
  assert.match(out, /--build-mode"?\s+"?local\b/);
  assert.match(out, /--artifact-out\b/);
  assert.match(out, /\s--local\b/);
});

test('ui-mobile-release can delegate local Android builds to Dagger runtime', () => {
  const out = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'ui-mobile-release',
      '--environment',
      'preview',
      '--action',
      'native',
      '--platform',
      'android',
      '--profile',
      'preview-apk',
      '--native-build-mode',
      'local',
      '--native-local-runtime',
      'dagger',
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, EXPO_TOKEN: 'test-token' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /--local-runtime"?\s+"?dagger\b/);
});
