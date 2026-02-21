import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline CLI can promote branch in dry-run (uses local gh auth)', async () => {
  const tmpDir = fs.mkdtempSync(resolve(os.tmpdir(), 'happier-promote-branch-cli-'));
  const summaryPath = resolve(tmpDir, 'summary.md');

  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'promote-branch',
      '--source',
      'dev',
      '--target',
      'main',
      '--mode',
      'fast_forward',
      '--confirm',
      'promote main from dev',
      '--summary-file',
      summaryPath,
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, GH_TOKEN: '', GH_REPO: '', GITHUB_REPOSITORY: '' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] promote branch: dev -> main/);
  assert.match(out, /\[dry-run\] gh api /);

  const summary = fs.readFileSync(summaryPath, 'utf8');
  assert.match(summary, /## Promote Branch/);
  assert.match(summary, /- source: `dev`/);
  assert.match(summary, /- target: `main`/);
  assert.match(summary, /- mode: `fast_forward`/);
});
