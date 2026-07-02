import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const CANONICAL_EMPTY_FINGERPRINT_HASH = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o700 });
}

test('expo ota fingerprint generation captures large EAS JSON output without ENOBUFS', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-eas-ota-large-fingerprint-json-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const envLogPath = path.join(dir, 'env.log');
  const npxLogPath = path.join(dir, 'npx.log');
  const fingerprintJsonPath = path.join(dir, 'fingerprint.json');
  fs.writeFileSync(
    fingerprintJsonPath,
    `${JSON.stringify({
      hash: CANONICAL_EMPTY_FINGERPRINT_HASH,
      sources: [],
      debugInfo: { padding: 'a'.repeat(2 * 1024 * 1024) },
    })}\n`,
    'utf8',
  );

  writeExecutable(
    path.join(binDir, 'git'),
    ['#!/usr/bin/env bash', 'set -euo pipefail', 'exit 0', ''].join('\n'),
  );

  writeExecutable(
    path.join(binDir, 'yarn'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
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
      'if [[ "$*" == *"fingerprint:generate"* ]]; then',
      `  cat ${JSON.stringify(fingerprintJsonPath)}`,
      '  exit 0',
      'fi',
      'if [[ "$*" == *" update "* ]]; then',
      `  echo "HAPPIER_EXPO_RUNTIME_VERSION=${'${HAPPIER_EXPO_RUNTIME_VERSION:-}'}" >> ${JSON.stringify(envLogPath)}`,
      '  exit 0',
      'fi',
      'echo "unexpected npx invocation: $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
  );

  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'ota-update.mjs'),
      '--environment',
      'publicdev',
      '--platform',
      'android',
      '--interactive',
      'true',
      '--message',
      'publicdev OTA large fingerprint contract test',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        EXPO_TOKEN: '',
        SENTRY_AUTH_TOKEN: '',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  const npxLog = fs.readFileSync(npxLogPath, 'utf8');
  const envLog = fs.readFileSync(envLogPath, 'utf8');

  assert.match(npxLog, /fingerprint:generate/);
  assert.match(npxLog, /update --channel dev --platform android/);
  assert.match(envLog, new RegExp(`^HAPPIER_EXPO_RUNTIME_VERSION=${CANONICAL_EMPTY_FINGERPRINT_HASH}$`, 'm'));
});

test('expo ota fingerprint generation tolerates noisy pretty-printed EAS JSON output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-eas-ota-fingerprint-json-noise-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const envLogPath = path.join(dir, 'env.log');
  const npxLogPath = path.join(dir, 'npx.log');

  writeExecutable(
    path.join(binDir, 'git'),
    ['#!/usr/bin/env bash', 'set -euo pipefail', 'exit 0', ''].join('\n'),
  );

  writeExecutable(
    path.join(binDir, 'yarn'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
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
      'if [[ "$*" == *"fingerprint:generate"* ]]; then',
      '  echo "Expo fingerprint cache hit"',
      `  printf '{\\n  "hash": "${CANONICAL_EMPTY_FINGERPRINT_HASH}",\\n  "sources": []\\n}\\n'`,
      '  exit 0',
      'fi',
      'if [[ "$*" == *" update "* ]]; then',
      `  echo "HAPPIER_EXPO_RUNTIME_VERSION=${'${HAPPIER_EXPO_RUNTIME_VERSION:-}'}" >> ${JSON.stringify(envLogPath)}`,
      '  exit 0',
      'fi',
      'echo "unexpected npx invocation: $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
  );

  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'ota-update.mjs'),
      '--environment',
      'publicdev',
      '--platform',
      'android',
      '--interactive',
      'true',
      '--message',
      'publicdev OTA fingerprint noise contract test',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        EXPO_TOKEN: '',
        SENTRY_AUTH_TOKEN: '',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  const npxLog = fs.readFileSync(npxLogPath, 'utf8');
  const envLog = fs.readFileSync(envLogPath, 'utf8');

  assert.match(npxLog, /fingerprint:generate/);
  assert.match(npxLog, /update --channel dev --platform android/);
  assert.match(envLog, new RegExp(`^HAPPIER_EXPO_RUNTIME_VERSION=${CANONICAL_EMPTY_FINGERPRINT_HASH}$`, 'm'));
});
