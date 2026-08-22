import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

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
