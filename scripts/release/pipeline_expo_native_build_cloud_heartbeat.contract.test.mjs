import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const PIPELINE_TEST_TIMEOUT_MS = 120_000;

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o700 });
}

test('expo native-build cloud mode emits heartbeat while waiting for EAS response', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-eas-cloud-heartbeat-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const outJson = path.join(dir, 'eas-build.json');

  const npxPath = path.join(binDir, 'npx');
  writeExecutable(
    npxPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'sleep 0.25',
      'printf \'[{"id":"build-123","platform":"android","status":"IN_QUEUE","buildDetailsPageUrl":"https://expo.dev/accounts/happier-dev/projects/happier/builds/build-123"}]\\n\'',
      'exit 0',
      '',
    ].join('\n'),
  );

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    EXPO_TOKEN: 'test-token',
    HAPPIER_PIPELINE_HEARTBEAT_MS: '50',
  };

  const stdout = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'native-build.mjs'),
      '--platform',
      'android',
      '--profile',
      'preview-apk',
      '--out',
      outJson,
      '--dump-view',
      'false',
    ],
    {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PIPELINE_TEST_TIMEOUT_MS,
    },
  );

  assert.match(stdout, /\[pipeline\] waiting on Expo cloud build scheduling/);
  assert.ok(fs.existsSync(outJson), 'expected cloud build json output file');
  const parsed = JSON.parse(fs.readFileSync(outJson, 'utf8'));
  assert.equal(Array.isArray(parsed), true);
  assert.equal(parsed[0]?.id, 'build-123');
});
