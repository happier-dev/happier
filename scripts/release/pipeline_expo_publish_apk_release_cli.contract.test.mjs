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

test('pipeline CLI can publish UI mobile APK release in dry-run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'happier-apk-'));
  const apkPath = join(dir, 'happier-preview-android.apk');
  writeFileSync(apkPath, 'fake-apk');

  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'expo-publish-apk-release',
      '--environment',
      'preview',
      '--apk-path',
      apkPath,
      '--target-sha',
      '0123456789abcdef0123456789abcdef01234567',
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        GH_TOKEN: '',
        GH_REPO: '',
        GITHUB_REPOSITORY: '',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] ui-mobile apk release: environment=preview tag=ui-mobile-preview/);
  assert.match(out, /scripts\/pipeline\/expo\/publish-apk-release\.mjs/);
});

