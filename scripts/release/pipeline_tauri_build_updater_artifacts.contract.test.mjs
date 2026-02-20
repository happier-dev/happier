import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('tauri build-updater-artifacts script supports preview dry-run', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'tauri', 'build-updater-artifacts.mjs'),
      '--environment',
      'preview',
      '--build-version',
      '1.2.3-preview.123',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\byarn tauri build\b/);
  assert.match(out, /tauri\.preview\.conf\.json/);
  assert.match(out, /tauri\.version\.override\.json/);
});

test('tauri build-updater-artifacts script supports production dry-run', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'tauri', 'build-updater-artifacts.mjs'),
      '--environment',
      'production',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\byarn tauri build\b/);
  assert.doesNotMatch(out, /tauri\.preview\.conf\.json/);
});

