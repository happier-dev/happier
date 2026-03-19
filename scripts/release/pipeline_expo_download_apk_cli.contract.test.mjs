import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline CLI can download Android APK (dry-run) from EAS build JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'happier-eas-'));
  const buildJsonPath = join(dir, 'eas_build.json');
  writeFileSync(
    buildJsonPath,
    JSON.stringify(
      [
        {
          id: 'build-android-1',
          platform: 'android',
          artifacts: {
            applicationArchiveUrl: 'https://example.com/happier-preview-android.apk',
          },
        },
      ],
      null,
      2,
    ),
  );

  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'expo-download-apk',
      '--environment',
      'preview',
      '--build-json',
      buildJsonPath,
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        EXPO_TOKEN: 'expo-token',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] expo download apk: environment=preview/);
  assert.match(out, /scripts\/pipeline\/expo\/download-android-apk\.mjs/);
});

