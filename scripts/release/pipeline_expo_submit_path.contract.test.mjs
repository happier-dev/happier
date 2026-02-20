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

function runSubmit({ withPath }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-expo-submit-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const npxPath = path.join(binDir, 'npx');
  writeExecutable(
    npxPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "APP_ENV=${APP_ENV:-}"',
      'echo "NPX $*"',
      'exit 0',
      '',
    ].join('\n'),
  );

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    EXPO_TOKEN: 'test-token',
  };

  const args = [
    path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'submit.mjs'),
    '--environment',
    'preview',
    '--platform',
    'android',
    ...(withPath ? ['--path', path.join(dir, 'app.apk')] : []),
  ];

  return execFileSync(process.execPath, args, {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
}

test('expo submit uses --latest by default (cloud builds)', () => {
  const out = runSubmit({ withPath: false });
  assert.match(out, /NPX --yes eas-cli@/);
  assert.match(out, /\ssubmit\b/);
  assert.match(out, /\s--profile preview\b/);
  assert.match(out, /\s--latest\b/);
});

test('expo submit supports --path for local binaries', () => {
  const out = runSubmit({ withPath: true });
  assert.match(out, /APP_ENV=preview/);
  assert.match(out, /\ssubmit\b/);
  assert.match(out, /\s--path\b/);
  assert.match(out, /\s--profile preview\b/);
  assert.doesNotMatch(out, /\s--latest\b/);
});
