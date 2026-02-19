import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('pipeline CLI supports --path for expo-submit (dry-run)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-expo-submit-cli-'));
  const artifact = path.join(tmp, 'app.ipa');
  fs.writeFileSync(artifact, 'placeholder');

  const out = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'expo-submit',
      '--environment',
      'preview',
      '--platform',
      'ios',
      '--path',
      artifact,
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, EXPO_TOKEN: 'expo-token' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /scripts\/pipeline\/expo\/submit\.mjs/);
  assert.match(out, /\s--path\b/);
});

