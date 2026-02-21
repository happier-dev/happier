import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline CLI can promote deploy branch in dry-run', async () => {
  const tmpDir = fs.mkdtempSync(resolve(os.tmpdir(), 'happier-promote-deploy-branch-'));
  const summaryPath = resolve(tmpDir, 'summary.md');

  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'promote-deploy-branch',
      '--deploy-environment',
      'production',
      '--component',
      'server',
      '--source-ref',
      'dev',
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

  assert.match(out, /\[pipeline\] promote deploy branch: deploy\/production\/server <= dev/);
  assert.match(out, /\[dry-run\] gh api /);
  assert.match(out, /deploy%2Fproduction%2Fserver/, 'gh api ref path must URL-encode deploy branch slashes');
  assert.match(out, /-F force=true/, 'gh api PATCH should send boolean force with --field (typed)');
  assert.match(out, /-X PATCH/, 'dry-run should print the intended PATCH update call');

  const summary = fs.readFileSync(summaryPath, 'utf8');
  assert.match(summary, /^## Promote deploy branch/m);
  assert.match(summary, /target: `deploy\/production\/server`/);
});
