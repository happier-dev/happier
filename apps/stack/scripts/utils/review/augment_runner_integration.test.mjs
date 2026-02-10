import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function resolveRepoRoot() {
  // This test must run from anywhere (repo root, package root, CI, etc.).
  // Derive monorepo root from this file path to avoid cwd-sensitive failures.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', '..', '..');
}

test('review script provides a non-empty prompt to augment in normal uncommitted mode', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-review-auggie-'));
  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const auggiePath = path.join(binDir, 'auggie');
  fs.writeFileSync(
    auggiePath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const last = args[args.length - 1] ?? '';
if (!String(last).trim()) {
  console.error('missing instruction');
  process.exit(2);
}
process.stdout.write('ok\\n\\n===FINDINGS_JSON===\\n[]\\n');
`,
    { mode: 0o755 }
  );

  const repoRoot = resolveRepoRoot();
  const env = {
    ...process.env,
    // Ensure our stub is used.
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    // Keep Augment cache writes out of the repo.
    HAPPIER_STACK_AUGMENT_CACHE_DIR: path.join(tmp, 'augment-home'),
    HAPPIER_STACK_REPO_DIR: repoRoot,
  };

  const res = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, 'apps', 'stack', 'scripts', 'review.mjs'),
      'all',
      '--reviewers=augment',
      '--type=uncommitted',
      '--depth=normal',
      '--no-chunks',
      '--no-stream',
      '--run-label=test-augment-normal-uncommitted',
    ],
    { cwd: repoRoot, env, encoding: 'utf8' }
  );

  assert.equal(res.status, 0, `expected exit 0; stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
});

test('review script infers repo dir from cwd even when target positionals are provided', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-review-auggie-'));
  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const auggiePath = path.join(binDir, 'auggie');
  fs.writeFileSync(
    auggiePath,
    `#!/usr/bin/env node
process.stdout.write('ok\\n\\n===FINDINGS_JSON===\\n[]\\n');
`,
    { mode: 0o755 }
  );

  const repoRoot = resolveRepoRoot();
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    HAPPIER_STACK_AUGMENT_CACHE_DIR: path.join(tmp, 'augment-home'),
    // Do NOT set HAPPIER_STACK_REPO_DIR here; we want it inferred from cwd.
  };

  const res = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, 'apps', 'stack', 'scripts', 'review.mjs'),
      'all',
      '--reviewers=augment',
      '--type=uncommitted',
      '--depth=normal',
      '--no-chunks',
      '--run-label=test-augment-repo-infer-with-positionals',
    ],
    { cwd: repoRoot, env, encoding: 'utf8' }
  );

  assert.equal(res.status, 0, `expected exit 0; stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, new RegExp(`\\[review\\] monorepo detected at ${repoRoot.replaceAll('\\', '\\\\')}`));
});
