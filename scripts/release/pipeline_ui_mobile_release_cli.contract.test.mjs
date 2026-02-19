import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline CLI can orchestrate UI mobile native preview-apk release in dry-run', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'ui-mobile-release',
      '--environment',
      'preview',
      '--action',
      'native',
      '--platform',
      'android',
      '--profile',
      'preview-apk',
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
  assert.match(out, /scripts\/pipeline\/expo\/download-android-apk\.mjs/);
  assert.match(out, /scripts\/pipeline\/expo\/publish-apk-release\.mjs/);
});

