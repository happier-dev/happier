import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('ui-mobile-release can skip APK GitHub release publishing when requested', () => {
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
      'preview',
      '--publish-apk-release',
      'false',
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        EXPO_TOKEN: 'expo-token',
        GH_TOKEN: '',
        GH_REPO: '',
        GITHUB_REPOSITORY: '',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] ui-mobile release: environment=preview action=native/);
  assert.match(out, /scripts\/pipeline\/expo\/native-build\.mjs/);
  assert.doesNotMatch(out, /scripts\/pipeline\/expo\/download-android-apk\.mjs/);
  assert.doesNotMatch(out, /scripts\/pipeline\/expo\/publish-apk-release\.mjs/);
});

