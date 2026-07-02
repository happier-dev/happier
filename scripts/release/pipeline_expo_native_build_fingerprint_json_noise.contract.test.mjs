import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const PIPELINE_TEST_TIMEOUT_MS = 120_000;
const CANONICAL_EMPTY_FINGERPRINT_HASH = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o700 });
}

test('expo native-build fingerprint mode tolerates noisy EAS build:list JSON output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-eas-fingerprint-json-noise-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const outJson = path.join(dir, 'eas-build.json');
  const logPath = path.join(dir, 'npx.log');
  const npxPath = path.join(binDir, 'npx');
  writeExecutable(
    npxPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "$*" >> ${JSON.stringify(logPath)}`,
      'if [[ "$*" == *"fingerprint:generate"* ]]; then',
      '  echo "Expo fingerprint cache hit"',
      `  printf '{"hash":"${CANONICAL_EMPTY_FINGERPRINT_HASH}","sources":[],"fileHookTransformConfig":{}}\\n'`,
      '  exit 0',
      'fi',
      'if [[ "$*" == *"build:list"* && "$*" == *"--fingerprint-hash "* ]]; then',
      '  echo "Querying builds by fingerprint"',
      `  printf '[{"id":"old-build","platform":"android","status":"CANCELED","createdAt":"2024-01-01T00:00:00.000Z","fingerprint":{"hash":"${CANONICAL_EMPTY_FINGERPRINT_HASH}"}}]\\n'`,
      '  exit 0',
      'fi',
      'if [[ "$*" == *"build:list"* && "$*" == *"--status finished"* ]]; then',
      '  echo "Resolved latest finished build"',
      `  printf '[{"id":"finished-build","platform":"android","status":"FINISHED","createdAt":"2099-01-01T00:00:00.000Z","fingerprint":{"hash":"${CANONICAL_EMPTY_FINGERPRINT_HASH}"}}]\\n'`,
      '  exit 0',
      'fi',
      'echo "unexpected npx invocation: $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
  );

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
      '--interactive',
      'false',
      '--fingerprint-mode',
      'if-changed',
      '--dump-view',
      'false',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        EXPO_TOKEN: 'test-token',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PIPELINE_TEST_TIMEOUT_MS,
    },
  );

  const npxLog = fs.readFileSync(logPath, 'utf8');
  assert.match(npxLog, /build:list .* --fingerprint-hash [^ ]+ .* --json --non-interactive/);
  assert.match(npxLog, /build:list .* --status finished .* --json --non-interactive/);
  assert.match(stdout, /expo native fingerprint: platform=android .* changed=false/);

  const parsed = JSON.parse(fs.readFileSync(outJson, 'utf8'));
  assert.equal(parsed.mode, 'cloud');
  assert.equal(parsed.platform, 'android');
  assert.equal(parsed.profile, 'preview-apk');
  assert.equal(parsed.fingerprintMode, 'if-changed');
  assert.equal(parsed.skipped, true);
  assert.equal(parsed.reason, 'fingerprint unchanged (no native build needed)');
});
