import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('expo submit allows local interactive auth when EXPO_TOKEN is missing (dry-run)', () => {
  const out = execFileSync(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'submit.mjs'), '--environment', 'preview', '--platform', 'android', '--dry-run'],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        CI: '',
        EXPO_TOKEN: '',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] expo submit: environment=preview platform=android/);
  assert.match(out, /\[dry-run\].*\bnpx\b/);
  assert.doesNotMatch(out, /\s--non-interactive\b/);
});

test('expo submit allows local interactive setup when PIPELINE_INTERACTIVE=1 (even with EXPO_TOKEN) (dry-run)', () => {
  const out = execFileSync(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'submit.mjs'), '--environment', 'preview', '--platform', 'android', '--dry-run'],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        CI: '',
        EXPO_TOKEN: 'test-token',
        PIPELINE_INTERACTIVE: '1',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] expo submit: environment=preview platform=android/);
  assert.match(out, /\[dry-run\].*\bnpx\b/);
  assert.doesNotMatch(out, /\s--non-interactive\b/);
});

test('expo submit requires EXPO_TOKEN in CI (even in dry-run)', () => {
  let err;
  try {
    execFileSync(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'submit.mjs'), '--environment', 'preview', '--platform', 'android', '--dry-run'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CI: 'true',
          EXPO_TOKEN: '',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );
  } catch (e) {
    err = e;
  }

  assert.ok(err, 'expected script to fail without EXPO_TOKEN in CI');
  assert.match(String(err?.stderr ?? ''), /EXPO_TOKEN is required/);
});
