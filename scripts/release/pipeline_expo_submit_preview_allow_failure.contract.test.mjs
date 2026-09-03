import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o700 });
}

test('expo submit attempts every requested prerelease platform but reports any submission failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-expo-submit-fail-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const npxPath = path.join(binDir, 'npx');
  writeExecutable(
    npxPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "NPX $*"',
      'exit 1',
      '',
    ].join('\n'),
  );

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    EXPO_TOKEN: 'test-token',
    APPLE_API_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
  };

  for (const environment of ['preview', 'dev']) {
    const result = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'submit.mjs'),
        '--environment',
        environment,
        '--platform',
        'all',
      ],
      { cwd: repoRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
    );

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stdout, /NPX .*submit --platform ios/);
    assert.match(result.stdout, /NPX .*submit --platform android/);
    assert.match(result.stdout, new RegExp(`::warning::Expo submit failed for ios in ${environment}`));
    assert.match(result.stdout, new RegExp(`::warning::Expo submit failed for android in ${environment}`));
  }
});
