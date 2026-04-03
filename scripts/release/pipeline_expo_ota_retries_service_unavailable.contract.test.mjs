import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o700 });
}

function createStubBin(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const attemptsPath = path.join(dir, 'attempts.txt');
  const npxLogPath = path.join(dir, 'npx.log');

  writeExecutable(
    path.join(binDir, 'git'),
    ['#!/usr/bin/env bash', 'set -euo pipefail', 'exit 0', ''].join('\n'),
  );

  writeExecutable(
    path.join(binDir, 'yarn'),
    ['#!/usr/bin/env bash', 'set -euo pipefail', 'exit 0', ''].join('\n'),
  );

  writeExecutable(
    path.join(binDir, 'npx'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "$*" >> ${JSON.stringify(npxLogPath)}`,
      `count="$(cat ${JSON.stringify(attemptsPath)} 2>/dev/null || echo 0)"`,
      'count="$((count + 1))"',
      `echo "$count" > ${JSON.stringify(attemptsPath)}`,
      'if [[ "$count" -eq 1 ]]; then',
      '  echo "Service Unavailable" >&2',
      '  echo "Error: GraphQL request failed." >&2',
      '  exit 1',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  );

  return { dir, binDir, attemptsPath, npxLogPath };
}

test('expo ota update retries when EAS update fails with Service Unavailable', () => {
  const stub = createStubBin('happier-pipeline-expo-ota-retry-');

  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'ota-update.mjs'),
      '--environment',
      'dev',
      '--interactive',
      'false',
      '--message',
      'retry contract test',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${stub.binDir}:${process.env.PATH ?? ''}`,
        // Non-interactive OTA publishes require a token; a stub value is enough because `npx` is stubbed.
        EXPO_TOKEN: 'contract-test',
        SENTRY_AUTH_TOKEN: '',
        // Keep the test fast and deterministic.
        HAPPIER_PIPELINE_EXPO_OTA_MAX_RETRIES: '1',
        HAPPIER_PIPELINE_EXPO_OTA_RETRY_DELAY_MS: '0',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  const attempts = fs.readFileSync(stub.attemptsPath, 'utf8').trim();
  assert.equal(attempts, '2');
});
