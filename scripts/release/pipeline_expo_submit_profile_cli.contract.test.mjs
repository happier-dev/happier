import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('pipeline CLI supports --profile for expo-submit (dry-run)', () => {
  const out = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'expo-submit',
      '--environment',
      'preview',
      '--platform',
      'ios',
      '--profile',
      'preview',
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
  assert.match(out, /--profile\b/);
  assert.match(out, /\bpreview\b/);
});

