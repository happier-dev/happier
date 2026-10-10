import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { buildReleaseNotesBundle } from '../pipeline/release/release-notes/project-release-notes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('non-production Android entry points preserve the EAS profile release status', () => {
  for (const [subcommand, args] of [
    ['expo-submit', ['--id', '123e4567-e89b-12d3-a456-426614174000']],
    ['ui-mobile-release', ['--action', 'native_submit', '--profile', 'preview', '--native-build-mode', 'local']],
  ]) {
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts/pipeline/run.mjs'), subcommand,
      '--environment', 'preview', '--platform', 'android', '--dry-run', '--secrets-source', 'env', ...args,
    ], { cwd: repoRoot, encoding: 'utf8', timeout: 30_000, env: { ...process.env, EXPO_TOKEN: 'test-token' } });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /set .*android\.releaseStatus=/);
  }
});

test('production native submission requires bound store notes before preflight or build', () => {
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts/pipeline/run.mjs'), 'ui-mobile-release',
    '--environment', 'production', '--action', 'native_submit', '--platform', 'ios', '--profile', 'production',
    '--preflight-only', '--dry-run', '--secrets-source', 'env',
  ], {
    cwd: repoRoot,
    env: { ...process.env, APP_STORE_CONNECT_PRODUCTION_EXTERNAL_GROUPS: '' },
    encoding: 'utf8', timeout: 30_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release-notes-json/);
  assert.doesNotMatch(result.stdout, /native-build\.mjs|submit\.mjs/);
});

function createBuildJsonPath(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-ui-mobile-testflight-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  return path.join(tmpDir, 'eas_build.json');
}

function productionNotes(t, overrides = {}) {
  const buildJson = createBuildJsonPath(t);
  const releaseId = '2026-10-09.1';
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const appVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/ui/package.json'), 'utf8')).version;
  const changelog = `## Release ${releaseId} - 2026-10-09\n\n<!-- happier-release-note-projections:v1\n${JSON.stringify({
    expo: { message: 'Approved Expo notes.' }, appStore: { whatsNew: 'Approved App Store notes.' },
    playStore: { whatsNew: 'Approved Play notes.' },
  })}\n-->\n\nApproved public release notes.\n`;
  const bundle = buildReleaseNotesBundle(changelog, { releaseId, sourceSha, componentVersions: { ui: appVersion }, ...overrides });
  const bundlePath = path.join(path.dirname(buildJson), 'release-notes.json');
  fs.writeFileSync(bundlePath, JSON.stringify(bundle));
  return { buildJson, args: ['--release-notes-json', bundlePath, '--source-sha', sourceSha, '--release-id', releaseId, '--app-version', appVersion] };
}

function productionRun(args, env = {}) {
  return spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts/pipeline/run.mjs'), 'ui-mobile-release',
    '--environment', 'production', '--action', 'native_submit', '--platform', 'ios', '--profile', 'production',
    '--dry-run', '--secrets-source', 'env', ...args,
  ], {
    cwd: repoRoot, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, EXPO_TOKEN: 'test-token', APPLE_API_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
      APP_STORE_CONNECT_PRODUCTION_EXTERNAL_GROUPS: '', GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: '', ...env },
  });
}

test('production iOS preflight validates its notes without requiring Play credentials or optional TestFlight groups', (t) => {
  const notes = productionNotes(t);
  const result = productionRun([...notes.args, '--preflight-only'], {
    APPLE_API_PRIVATE_KEY: '', APP_STORE_CONNECT_PRODUCTION_EXTERNAL_GROUPS: 'Optional beta group',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /native-build\.mjs|submit\.mjs|testflight-distribute\.mjs/);
});

test('production preflight rejects notes projected from another source before native build', (t) => {
  const notes = productionNotes(t, { sourceSha: 'a'.repeat(40) });
  const result = productionRun(notes.args);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exact release, source SHA and UI version/);
  assert.doesNotMatch(result.stdout, /native-build\.mjs|submit\.mjs/);
});

test('production Android requires a Play publishing credential before native build', (t) => {
  const notes = productionNotes(t);
  const result = productionRun([...notes.args, '--platform', 'android']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GOOGLE_PLAY_SERVICE_ACCOUNT_JSON/);
  assert.doesNotMatch(result.stdout, /native-build\.mjs|submit\.mjs/);
});

for (const nativeBuildMode of ['local', 'cloud']) {
  test(`production Android ${nativeBuildMode} submission waits for its exact binary and carries bound notes`, (t) => {
    const notes = productionNotes(t);
    const buildId = '123e4567-e89b-12d3-a456-426614174000';
    if (nativeBuildMode === 'cloud') fs.writeFileSync(notes.buildJson, JSON.stringify({ id: buildId, platform: 'ANDROID' }));
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const result = productionRun([...notes.args, '--platform', 'android', '--build-json', notes.buildJson, '--native-build-mode', nativeBuildMode], {
      GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: 'service_account', client_email: 'publisher@example.test',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }),
    });
    assert.equal(result.status, 0, result.stderr);
    if (nativeBuildMode === 'cloud') {
      const nativeBuildCommand = result.stdout.split('\n').find((line) => line.includes('exec: node') && line.includes('native-build.mjs'));
      assert.match(nativeBuildCommand ?? '', /--wait" "true"/);
    }
    const submitCommand = result.stdout.split('\n').find((line) => line.includes('exec: node') && line.includes('/submit.mjs'));
    assert.match(submitCommand ?? '', /--wait" "true"/);
    assert.match(submitCommand ?? '', /--release-notes-json/);
    assert.ok((submitCommand ?? '').includes(notes.args[3]));
    if (nativeBuildMode === 'cloud') assert.ok((submitCommand ?? '').includes(buildId));
    else assert.match(submitCommand ?? '', /--path/);
    assert.doesNotMatch(submitCommand ?? '', /--latest/);
  });
}

for (const nativeBuildMode of ['local', 'cloud']) {
  test(`production iOS ${nativeBuildMode} publication is independent of external TestFlight groups`, (t) => {
    const notes = productionNotes(t);
    const buildId = '123e4567-e89b-12d3-a456-426614174001';
    if (nativeBuildMode === 'cloud') fs.writeFileSync(notes.buildJson, JSON.stringify({ id: buildId, platform: 'IOS' }));
    const result = productionRun([...notes.args, '--build-json', notes.buildJson, '--native-build-mode', nativeBuildMode]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /store-publish\.mjs/);
    assert.ok(result.stdout.includes(notes.buildJson));
    assert.match(result.stdout, /--release-notes-json/);
    assert.ok(result.stdout.indexOf('/submit.mjs') < result.stdout.indexOf('/store-publish.mjs'));
    if (nativeBuildMode === 'cloud') assert.ok(result.stdout.includes(`"--id" "${buildId}"`));
    assert.doesNotMatch(result.stdout, /testflight-distribute\.mjs/);
  });
}

test('production iOS defers store publication even when no TestFlight groups are configured', (t) => {
  const notes = productionNotes(t);
  const result = productionRun([...notes.args, '--build-json', notes.buildJson, '--testflight-distribution-mode', 'deferred']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /App Store publication deferred/);
  assert.doesNotMatch(result.stdout, /store-publish\.mjs|testflight-distribute\.mjs/);
});

for (const nativeBuildMode of ['local', 'cloud']) {
  test(`ui-mobile-release defers TestFlight processing after ${nativeBuildMode} submission`, (t) => {
    const buildJson = createBuildJsonPath(t);
    const candidateRoot = path.join(path.dirname(buildJson), 'candidate');
    // A separate candidate root exercises the current control entrypoint's actual root override
    // without copying a checkout or replacing any internal build/submission logic.
    fs.symlinkSync(repoRoot, candidateRoot, 'junction');
    const out = execFileSync(process.execPath, [
      path.join(repoRoot, 'scripts/pipeline/run.mjs'), 'ui-mobile-release',
      '--environment', 'dev', '--action', 'native_submit', '--platform', 'ios', '--profile', 'dev',
      '--native-build-mode', nativeBuildMode, '--build-json', buildJson,
      '--testflight-distribution-mode', 'deferred', '--dry-run', '--secrets-source', 'env',
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HAPPIER_PIPELINE_REPO_ROOT: candidateRoot,
        EXPO_TOKEN: 'test-token',
        APPLE_API_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
        APP_STORE_CONNECT_PUBLICDEV_EXTERNAL_GROUPS: 'dev-group-id',
      },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    });
    assert.match(out, /scripts\/pipeline\/expo\/native-build\.mjs/);
    assert.ok(out.includes(path.join(candidateRoot, 'scripts/pipeline/expo/native-build.mjs')));
    if (nativeBuildMode === 'local') assert.match(out, /scripts\/pipeline\/expo\/submit\.mjs/);
    assert.match(out, /TestFlight external distribution deferred/i);
    assert.doesNotMatch(out, /scripts\/pipeline\/expo\/testflight-distribute\.mjs/);
  });
}

test('ui-mobile-release native_submit triggers TestFlight distribution in dry-run when groups are configured', () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'ui-mobile-release',
      '--environment',
      'dev',
      '--action',
      'native_submit',
      '--platform',
      'ios',
      '--profile',
      'dev',
      '--native-build-mode',
      'local',
      '--native-local-runtime',
      'host',
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        EXPO_TOKEN: 'expo-token',
        APPLE_API_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----',
        APP_STORE_CONNECT_PUBLICDEV_EXTERNAL_GROUPS: 'beta-a,beta-b',
        APP_STORE_CONNECT_PUBLICDEV_SUBMIT_BETA_REVIEW: 'false',
        APP_STORE_CONNECT_PUBLICDEV_WAIT_PROCESSING: 'false',
        APP_STORE_CONNECT_PUBLICDEV_PROCESSING_TIMEOUT_SECONDS: '123',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /scripts\/pipeline\/expo\/native-build\.mjs/);
  assert.match(out, /scripts\/pipeline\/expo\/submit\.mjs/);
  assert.match(out, /scripts\/pipeline\/expo\/testflight-distribute\.mjs/);
  assert.match(out, /--external-groups"?\s+"?beta-a,beta-b/);
  assert.match(out, /--submit-beta-review"?\s+"?false/);
  assert.match(out, /--wait-processing"?\s+"?false/);
  assert.match(out, /--processing-timeout-seconds"?\s+"?123/);
  assert.match(out, /--build-json"?\s+"?\/tmp\/eas_build\.json/);
});

test('ui-mobile-release validates TestFlight groups without starting a native build', () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
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
        APPLE_API_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----',
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

test('ui-mobile-release current control defers distribution after scheduling the candidate build', (t) => {
  const tmpDir = fs.mkdtempSync(resolve(os.tmpdir(), 'happier-testflight-candidate-root-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const candidateRoot = resolve(tmpDir, 'candidate');
  fs.symlinkSync(repoRoot, candidateRoot, 'junction');
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'ui-mobile-release',
      '--environment',
      'dev',
      '--action',
      'native_submit',
      '--platform',
      'ios',
      '--profile',
      'dev',
      '--testflight-distribution-mode',
      'deferred',
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        EXPO_TOKEN: 'expo-token',
        APPLE_API_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----',
        APP_STORE_CONNECT_PUBLICDEV_EXTERNAL_GROUPS: 'beta-a',
        HAPPIER_PIPELINE_REPO_ROOT: candidateRoot,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /TestFlight external distribution deferred/i);
  assert.ok(out.includes(resolve(candidateRoot, 'scripts/pipeline/expo/native-build.mjs')));
  assert.doesNotMatch(out, /scripts\/pipeline\/expo\/testflight-distribute\.mjs/);
});
