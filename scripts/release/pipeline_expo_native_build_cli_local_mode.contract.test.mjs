import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('pipeline CLI can run Expo native build in local mode in dry-run', () => {
  const out = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'expo-native-build',
      '--platform',
      'android',
      '--profile',
      'preview-apk',
      '--out',
      '/tmp/eas_build.json',
      '--build-mode',
      'local',
      '--artifact-out',
      'dist/ui-mobile/happier-preview-android.apk',
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

  assert.match(out, /scripts\/pipeline\/expo\/native-build\.mjs/);
  assert.match(out, /--build-mode"?\s+"?local\b/);
  assert.match(out, /--artifact-out\b/);
  assert.match(out, /\s--local\b/);
});

test('pipeline CLI can delegate Expo local Android builds to Dagger runtime', () => {
  const out = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'expo-native-build',
      '--platform',
      'android',
      '--profile',
      'preview-apk',
      '--out',
      '/tmp/eas_build.json',
      '--build-mode',
      'local',
      '--local-runtime',
      'dagger',
      '--artifact-out',
      'dist/ui-mobile/happier-preview-android.apk',
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

  assert.match(out, /--local-runtime"?\s+"?dagger\b/);
  // Dagger should export the function result to the requested output directory, rather than exporting inside the module.
  assert.match(out, /\s-o\s+/);
  assert.match(out, /expo-android-local-build/);
  assert.match(out, /--artifact-name\b/);
  assert.match(out, /--out-json-name\b/);
});
