import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function createBuildJsonPath(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-ui-mobile-testflight-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  return path.join(tmpDir, 'eas_build.json');
}

test('ui-mobile-release native_submit dry-run plans preview TestFlight distribution without cloud build metadata', (t) => {
  const buildJsonPath = createBuildJsonPath(t);
  const out = execFileSync(
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
        EXPO_TOKEN: 'test-token',
        APPLE_API_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
        APP_STORE_CONNECT_PREVIEW_EXTERNAL_GROUPS: 'preview-group-id',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] ui-mobile release: environment=preview action=native_submit platform=ios/);
  assert.match(out, /scripts\/pipeline\/expo\/testflight-distribute\.mjs/);
  assert.match(out, /--environment"\s+"preview"/);
  assert.match(out, /--external-groups"\s+"preview-group-id"/);
  assert.ok(out.includes(buildJsonPath));
  assert.equal(fs.existsSync(buildJsonPath), false);
});

test('ui-mobile-release native_submit auto-distributes dev iOS builds using the publicdev external TestFlight config', (t) => {
  const buildJsonPath = createBuildJsonPath(t);
  const iosBuildJsonPath = buildJsonPath.replace(/\.json$/, '.ios.json');
  const out = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'ui-mobile-release',
      '--environment',
      'dev',
      '--action',
      'native_submit',
      '--platform',
      'all',
      '--profile',
      'dev',
      '--native-build-mode',
      'local',
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
        EXPO_TOKEN: 'test-token',
        APPLE_API_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
        APP_STORE_CONNECT_PUBLICDEV_EXTERNAL_GROUPS: 'dev-group-id',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] ui-mobile release: environment=dev action=native_submit platform=all/);
  assert.match(out, /scripts\/pipeline\/expo\/submit\.mjs/);
  assert.match(out, /scripts\/pipeline\/expo\/testflight-distribute\.mjs/);
  assert.match(out, /--environment"\s+"dev"/);
  assert.match(out, /--external-groups"\s+"dev-group-id"/);
  assert.ok(out.includes(iosBuildJsonPath));
});

test('ui-mobile-release can validate TestFlight groups without starting a native build', () => {
  const out = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'ui-mobile-release',
      '--environment',
      'dev',
      '--action',
      'native_submit',
      '--platform',
      'ios',
      '--profile',
      'dev',
      '--preflight-only',
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        APPLE_API_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
        APP_STORE_CONNECT_PUBLICDEV_EXTERNAL_GROUPS: 'Happier (dev)',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /scripts\/pipeline\/expo\/testflight-distribute\.mjs/);
  assert.match(out, /--validate-groups-only/);
  assert.doesNotMatch(out, /scripts\/pipeline\/expo\/native-build\.mjs/);
  assert.doesNotMatch(out, /scripts\/pipeline\/expo\/submit\.mjs/);
});
