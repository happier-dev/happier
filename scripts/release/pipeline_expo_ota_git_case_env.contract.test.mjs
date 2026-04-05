import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o700 });
}

function createExpoOtaStubEnvironment(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const paths = {
    dir,
    binDir,
    npxLogPath: path.join(dir, 'npx.log'),
    yarnLogPath: path.join(dir, 'yarn.log'),
    gitLogPath: path.join(dir, 'git.log'),
  };

  writeExecutable(
    path.join(binDir, 'git'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "$*" >> ${JSON.stringify(paths.gitLogPath)}`,
      'if [[ "$1" == "config" && "$2" == "--get" && "$3" == "core.ignorecase" ]]; then',
      '  echo "true"',
      '  exit 0',
      'fi',
      'if [[ "$1" == "config" && "$2" == "core.ignorecase" && "$3" == "false" ]]; then',
      '  exit 0',
      'fi',
      'echo "unexpected git invocation: $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
  );

  writeExecutable(
    path.join(binDir, 'yarn'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "$*" >> ${JSON.stringify(paths.yarnLogPath)}`,
      'exit 0',
      '',
    ].join('\n'),
  );

  writeExecutable(
    path.join(binDir, 'npx'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "$*" >> ${JSON.stringify(paths.npxLogPath)}`,
      `echo "NODE_OPTIONS=${'${NODE_OPTIONS:-}'}" >> ${JSON.stringify(paths.npxLogPath)}`,
      `env | grep '^GIT_CONFIG_' | sort >> ${JSON.stringify(paths.npxLogPath)} || true`,
      'if [[ "$*" == *" eas-cli@"*" update --channel "* ]]; then',
      '  exit 0',
      'fi',
      'echo "unexpected npx invocation: $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
  );

  return paths;
}

function runExpoOtaUpdateWithStubbedCommands({
  environment = 'internaldev',
  message = 'internaldev OTA case env test',
  extraEnv = {},
  prefix,
}) {
  const stub = createExpoOtaStubEnvironment(prefix);
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'ota-update.mjs'),
      '--environment',
      environment,
      '--interactive',
      'true',
      '--message',
      message,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${stub.binDir}:${process.env.PATH ?? ''}`,
        EXPO_TOKEN: '',
        // Keep the contract test hermetic: when SENTRY_AUTH_TOKEN is set in the outer environment
        // (for example from Keychain-loaded pipeline secrets), ota-update will attempt a best-effort
        // `npx sentry-expo-upload-sourcemaps` run which this stub intentionally rejects.
        SENTRY_AUTH_TOKEN: '',
        ...extraEnv,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );
  return stub;
}

test('expo ota update passes case-sensitive git config to EAS on macOS', () => {
  const stub = runExpoOtaUpdateWithStubbedCommands({
    prefix: 'happier-pipeline-eas-ota-git-env-',
  });

  const npxLog = fs.readFileSync(stub.npxLogPath, 'utf8');
  assert.match(npxLog, /update --channel internaldev/);
  if (process.platform === 'darwin') {
    const gitLog = fs.existsSync(stub.gitLogPath) ? fs.readFileSync(stub.gitLogPath, 'utf8') : '';
    assert.equal(gitLog, '');
    assert.match(npxLog, /GIT_CONFIG_KEY_\d+=core\.ignorecase/);
    assert.match(npxLog, /GIT_CONFIG_VALUE_\d+=false/);
  }
});

test('expo ota update raises the Node heap limit for EAS update by default', () => {
  const stub = runExpoOtaUpdateWithStubbedCommands({
    prefix: 'happier-pipeline-eas-ota-heap-default-',
  });

  const npxLog = fs.readFileSync(stub.npxLogPath, 'utf8');
  assert.match(npxLog, /NODE_OPTIONS=.*--max-old-space-size=8192/);
});

test('expo ota update respects explicit Expo heap overrides for EAS update', () => {
  const stub = runExpoOtaUpdateWithStubbedCommands({
    prefix: 'happier-pipeline-eas-ota-heap-override-',
    extraEnv: {
      HAPPIER_PIPELINE_EXPO_MAX_OLD_SPACE_SIZE_MB: '4096',
      NODE_OPTIONS: '--trace-warnings --max-old-space-size=2048',
    },
  });

  const npxLog = fs.readFileSync(stub.npxLogPath, 'utf8');
  assert.match(npxLog, /NODE_OPTIONS=.*--trace-warnings.*--max-old-space-size=4096/);
  assert.doesNotMatch(npxLog, /NODE_OPTIONS=.*--max-old-space-size=2048/);
});

test('expo ota update publishes production directly through EAS update instead of the legacy app script wrapper', () => {
  const stub = runExpoOtaUpdateWithStubbedCommands({
    environment: 'production',
    message: 'production OTA direct publish contract test',
    prefix: 'happier-pipeline-eas-ota-production-direct-',
    extraEnv: {
      EXPO_TOKEN: 'contract-test',
    },
  });

  const npxLog = fs.readFileSync(stub.npxLogPath, 'utf8');
  const yarnLog = fs.readFileSync(stub.yarnLogPath, 'utf8');

  assert.match(npxLog, /update --channel production/);
  assert.doesNotMatch(yarnLog, /ota:production/);
});
