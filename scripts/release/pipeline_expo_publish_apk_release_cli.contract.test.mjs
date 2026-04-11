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

test('pipeline CLI can publish the dev UI mobile APK rolling release in dry-run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'happier-apk-'));
  const apkPath = join(dir, 'happier-dev-android.apk');
  writeFileSync(apkPath, 'fake-apk');

  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'expo-publish-apk-release',
      '--environment',
      'dev',
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

  assert.match(out, /\[pipeline\] ui-mobile apk release: environment=dev tag=ui-mobile-dev/);
  assert.match(out, /scripts\/pipeline\/expo\/publish-apk-release\.mjs/);
});

test('pipeline CLI can publish the production UI mobile APK rolling stable release plus immutable version tag in dry-run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'happier-apk-'));
  const apkPath = join(dir, 'happier-production-android-v1.2.3.apk');
  writeFileSync(apkPath, 'fake-apk');

  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'expo-publish-apk-release',
      '--environment',
      'production',
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

  assert.match(out, /\[pipeline\] ui-mobile apk release: environment=production tag=ui-mobile-stable/);
  assert.match(out, /--tag\s+ui-mobile-stable\b/);
  assert.match(out, /--tag\s+ui-mobile-v[^\s"]+\b/);
  assert.match(out, new RegExp(String.raw`--assets\s+${apkPath.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\b`));
  assert.match(out, new RegExp(String.raw`--assets\s+${join(dir, 'happier-production-android.apk').replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\b`));
  assert.match(out, /scripts\/pipeline\/expo\/publish-apk-release\.mjs/);
});
