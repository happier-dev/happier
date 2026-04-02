import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

const ENV_KEYS = [
  'APP_ENV',
  'EXPO_UPDATES_CHANNEL',
  'EXPO_APP_NAME',
  'EXPO_APP_BUNDLE_ID',
  'EXPO_ANDROID_PACKAGE',
  'EXPO_APP_SCHEME',
  'HAPPIER_EXPO_DEVCLIENT_LAUNCH_MODE',
  'HAPPIER_EXPO_DEVCLIENT_SILENT_LAUNCH',
  'HAPPIER_EXPO_USE_NATIVE_DEBUG',
  'EX_UPDATES_NATIVE_DEBUG',
];

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o700 });
}

function createStubBin(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const envLogPath = path.join(dir, 'env.log');
  const npxLogPath = path.join(dir, 'npx.log');
  const yarnLogPath = path.join(dir, 'yarn.log');

  writeExecutable(
    path.join(binDir, 'git'),
    ['#!/usr/bin/env bash', 'set -euo pipefail', 'exit 0', ''].join('\n'),
  );

  writeExecutable(
    path.join(binDir, 'yarn'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "$*" >> ${JSON.stringify(yarnLogPath)}`,
      'exit 0',
      '',
    ].join('\n'),
  );

  writeExecutable(
    path.join(binDir, 'npx'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "$*" >> ${JSON.stringify(npxLogPath)}`,
      `env | grep -E '^(${ENV_KEYS.join('|')})=' | sort >> ${JSON.stringify(envLogPath)} || true`,
      'exit 0',
      '',
    ].join('\n'),
  );

  return { dir, binDir, envLogPath, npxLogPath, yarnLogPath };
}

function buildCleanEnv(extraEnv) {
  const env = { ...process.env };
  for (const key of ENV_KEYS) {
    delete env[key];
  }
  return {
    ...env,
    EXPO_TOKEN: '',
    SENTRY_AUTH_TOKEN: '',
    ...extraEnv,
  };
}

test('expo ota update passes the canonical EAS build-profile env that affects fingerprint for internaldev', () => {
  const stub = createStubBin('happier-pipeline-eas-ota-env-internaldev-');
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'ota-update.mjs'),
      '--environment',
      'internaldev',
      '--interactive',
      'true',
      '--message',
      'internaldev env contract test',
    ],
    {
      cwd: repoRoot,
      env: {
        ...buildCleanEnv(),
        PATH: `${stub.binDir}:${process.env.PATH ?? ''}`,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  const envLog = fs.readFileSync(stub.envLogPath, 'utf8').replace(/\r/g, '');
  assert.match(envLog, /^APP_ENV=internaldev$/m);
  assert.match(envLog, /^EXPO_UPDATES_CHANNEL=internaldev$/m);
  assert.match(envLog, /^EXPO_APP_NAME=Happier \(internal dev\)$/m);
  assert.ok(envLog.split('\n').includes('EXPO_APP_BUNDLE_ID=dev.happier.app.dev.internal'));
  assert.ok(envLog.split('\n').includes('EXPO_ANDROID_PACKAGE=dev.happier.app.internaldev'));
  assert.match(envLog, /^EXPO_APP_SCHEME=happier-internaldev$/m);
  assert.match(envLog, /^HAPPIER_EXPO_DEVCLIENT_LAUNCH_MODE=most-recent$/m);
  assert.match(envLog, /^HAPPIER_EXPO_DEVCLIENT_SILENT_LAUNCH=true$/m);
  assert.match(envLog, /^HAPPIER_EXPO_USE_NATIVE_DEBUG=true$/m);
  assert.match(envLog, /^EX_UPDATES_NATIVE_DEBUG=1$/m);
});

test('expo ota update passes identity env for publicdev without forcing internaldev-only native debug flags', () => {
  const stub = createStubBin('happier-pipeline-eas-ota-env-publicdev-');
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'ota-update.mjs'),
      '--environment',
      'publicdev',
      '--interactive',
      'true',
      '--message',
      'publicdev env contract test',
    ],
    {
      cwd: repoRoot,
      env: {
        ...buildCleanEnv(),
        PATH: `${stub.binDir}:${process.env.PATH ?? ''}`,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  const envLog = fs.readFileSync(stub.envLogPath, 'utf8').replace(/\r/g, '');
  assert.match(envLog, /^APP_ENV=publicdev$/m);
  assert.match(envLog, /^EXPO_UPDATES_CHANNEL=dev$/m);
  assert.match(envLog, /^EXPO_APP_NAME=Happier \(dev\)$/m);
  assert.ok(envLog.split('\n').includes('EXPO_APP_BUNDLE_ID=dev.happier.app.publicdev'));
  assert.ok(envLog.split('\n').includes('EXPO_ANDROID_PACKAGE=dev.happier.app.publicdev'));
  assert.match(envLog, /^EXPO_APP_SCHEME=happier-dev$/m);
  assert.doesNotMatch(envLog, /^HAPPIER_EXPO_DEVCLIENT_LAUNCH_MODE=/m);
  assert.doesNotMatch(envLog, /^HAPPIER_EXPO_DEVCLIENT_SILENT_LAUNCH=/m);
  assert.doesNotMatch(envLog, /^HAPPIER_EXPO_USE_NATIVE_DEBUG=/m);
  assert.doesNotMatch(envLog, /^EX_UPDATES_NATIVE_DEBUG=/m);
});
