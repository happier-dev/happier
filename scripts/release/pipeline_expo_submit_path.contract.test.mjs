import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createAndroidAabFixture } from '../pipeline/expo/fixtures/android-elf.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o700 });
}

function runSubmit(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-expo-submit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const artifactPath = createAndroidAabFixture(dir);

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
    'dev',
    '--platform',
    'android',
    '--path', artifactPath,
  ];

  return execFileSync(process.execPath, args, {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
}

test('expo submit validates local AABs and uses the publicdev submit profile for dev', (t) => {
  const out = runSubmit(t);
  assert.match(out, /APP_ENV=dev/);
  assert.match(out, /\ssubmit\b/);
  assert.match(out, /\s--path\b/);
  assert.match(out, /\s--profile publicdev\b/);
  assert.doesNotMatch(out, /\s--latest\b/);
  assert.match(out, /\[pipeline\] expo submit: environment=dev platform=android/);
});
