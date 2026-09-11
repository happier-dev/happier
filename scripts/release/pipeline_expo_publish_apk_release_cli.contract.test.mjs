import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const appVersion = String(JSON.parse(readFileSync(resolve(repoRoot, 'apps', 'ui', 'package.json'), 'utf8')).version);

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

test('pipeline CLI publishes the immutable production APK envelope before staged stable projection in dry-run', async () => {
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
        GH_REPO: 'happier-dev/happier',
        GITHUB_REPOSITORY: 'happier-dev/happier',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] ui-mobile apk release: environment=production tag=ui-mobile-stable/);
  assert.match(out, /--tag\s+ui-mobile-v[^\s"]+\b/);
  assert.match(out, /--source-tag\s+ui-mobile-v[^\s"]+\b/);
  assert.match(out, /--rolling-tag\s+ui-mobile-stable\b/);
  assert.match(out, /checksums-happier-ui-mobile-v[^\s"]+\.txt/);
  assert.match(out, /checksums-happier-ui-mobile-v[^\s"]+\.txt\.minisig/);
  assert.ok(
    out.indexOf('--tag ui-mobile-v') < out.indexOf('promote-rolling-release.mjs'),
    'the immutable APK envelope must publish before stable projection',
  );
  assert.doesNotMatch(out, /--tag\s+ui-mobile-stable\b/);
  assert.match(out, new RegExp(String.raw`--assets\s+${apkPath.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\b`));
  assert.match(out, /scripts\/pipeline\/expo\/publish-apk-release\.mjs/);
});

test('pipeline CLI can reproject an existing immutable production APK release without an APK path', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'expo-publish-apk-release',
      '--environment',
      'production',
      '--retry-version',
      appVersion,
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
        GH_REPO: 'happier-dev/happier',
        GITHUB_REPOSITORY: 'happier-dev/happier',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, new RegExp(`--source-tag\\s+ui-mobile-v${appVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
  assert.match(out, /--rolling-tag\s+ui-mobile-stable\b/);
  assert.match(out, /promote-rolling-release\.mjs/);
  assert.doesNotMatch(out, /publish-release\.mjs/);
  assert.doesNotMatch(out, /--apk-path/);
});

test('production APK retry derives its release identity from the requested immutable version', async () => {
  const retryVersion = appVersion === '0.0.1' ? '0.0.2' : '0.0.1';
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'expo-publish-apk-release',
      '--environment', 'production',
      '--retry-version', retryVersion,
      '--target-sha', '0123456789abcdef0123456789abcdef01234567',
      '--dry-run',
      '--secrets-source', 'env',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        GH_TOKEN: '',
        GH_REPO: 'happier-dev/happier',
        GITHUB_REPOSITORY: 'happier-dev/happier',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, new RegExp(`version=${retryVersion.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')}`));
  assert.match(out, /bootstrap-minisign\.sh/);
  assert.match(out, new RegExp(`--source-tag\\s+ui-mobile-v${retryVersion.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')}\\b`));
  assert.doesNotMatch(out, /must match apps\/ui version/);
});

test('production immutable APK publication disables generated notes when approved release notes are supplied', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'happier-apk-notes-'));
  const apkPath = join(dir, 'happier-production-android-v1.2.3.apk');
  writeFileSync(apkPath, 'fake-apk');
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'expo-publish-apk-release',
      '--environment', 'production',
      '--apk-path', apkPath,
      '--target-sha', '0123456789abcdef0123456789abcdef01234567',
      '--release-message', 'Approved exact candidate notes',
      '--dry-run',
      '--secrets-source', 'env',
    ],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  assert.match(out, /--release-message\s+"Approved exact candidate notes"/);
  assert.match(out, /--generate-notes\s+false/);
  assert.doesNotMatch(out, /--tag ui-mobile-v[^\n]*--generate-notes\s+true/);
});

test('trusted publication binds a built APK to its explicit candidate version instead of control package metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'happier-apk-explicit-version-'));
  const apkPath = join(dir, 'happier-production-android-v9.8.7.apk');
  writeFileSync(apkPath, 'fake-apk');
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'expo', 'publish-apk-release.mjs'),
      '--environment', 'production',
      '--apk-path', apkPath,
      '--version', '9.8.7',
      '--target-sha', '0123456789abcdef0123456789abcdef01234567',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, GH_REPO: 'happier-dev/happier', GITHUB_REPOSITORY: 'happier-dev/happier' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /tag=ui-mobile-stable version=9\.8\.7/);
  assert.match(out, /--tag\s+ui-mobile-v9\.8\.7\b/);
  assert.match(out, /--source-tag\s+ui-mobile-v9\.8\.7\b/);
});

test('preview APK publication retains the build filename and the website compatibility alias', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'happier-apk-preview-alias-'));
  const apkPath = join(dir, 'happier-preview-android.apk');
  writeFileSync(apkPath, 'fake-apk');
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'expo', 'publish-apk-release.mjs'),
      '--environment', 'preview',
      '--apk-path', apkPath,
      '--target-sha', '0123456789abcdef0123456789abcdef01234567',
      '--dry-run',
    ],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  assert.match(out, /happier-preview-android\.apk/);
  assert.match(out, /happier-preview\.apk/);
});

test('APK publication accepts release notes from a file without multiline GitHub outputs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'happier-apk-notes-file-'));
  const apkPath = join(dir, 'happier-preview-android.apk');
  const notesPath = join(dir, 'release-notes.md');
  writeFileSync(apkPath, 'fake-apk');
  writeFileSync(notesPath, 'First line\n\n- second line\n');
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'expo', 'publish-apk-release.mjs'),
      '--environment', 'preview',
      '--apk-path', apkPath,
      '--target-sha', '0123456789abcdef0123456789abcdef01234567',
      '--release-message-file', notesPath,
      '--dry-run',
    ],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  assert.match(out, /--release-message\s+"First line\\n\\n- second line"/);
});
