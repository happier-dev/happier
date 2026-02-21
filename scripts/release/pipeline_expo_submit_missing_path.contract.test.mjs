import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('expo submit fails fast with a helpful message when --path does not exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-expo-submit-missing-'));
  const missing = path.join(dir, 'missing.ipa');

  /** @type {unknown} */
  let caught = null;
  try {
    execFileSync(
      process.execPath,
      [
        path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'submit.mjs'),
        '--environment',
        'production',
        '--platform',
        'ios',
        '--path',
        missing,
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, EXPO_TOKEN: 'test-token' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );
  } catch (err) {
    caught = err;
  }

  assert.ok(caught, 'expected execFileSync to throw');
  const stderr = String(/** @type {any} */ (caught).stderr ?? '');
  assert.match(stderr, /doesn't exist/);
  assert.match(stderr, /happier-production-ios-v<uiVersion>\.ipa/);
});

