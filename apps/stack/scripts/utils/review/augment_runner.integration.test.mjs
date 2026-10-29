import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { buildGitIdentityEnv } from '../../testkit/core/env_scope.mjs';

function resolveRepoRoot() {
  // This test must run from anywhere (repo root, package root, CI, etc.).
  // Derive monorepo root from this file path to avoid cwd-sensitive failures.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', '..', '..');
}

function buildToolStubPath(binDir) {
  const nodeBinDir = path.dirname(process.execPath);
  const existing = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const rest = existing.filter((entry) => entry !== binDir && entry !== nodeBinDir);
  return [binDir, nodeBinDir, ...rest].join(path.delimiter);
}

async function createReviewFixture(t) {
  const fixture = await createTempFixture(t, { prefix: 'happier-review-auggie-' });
  const repoRoot = fixture.path('repo');
  for (const component of ['ui', 'cli', 'server']) {
    const dir = path.join(repoRoot, 'apps', component);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `@happier-dev/${component}` }));
  }
  const userHome = fixture.path('user');
  fs.mkdirSync(userHome);
  const env = buildGitIdentityEnv({ extraEnv: { HOME: userHome, USERPROFILE: userHome } });
  for (const args of [['init', '-b', 'main'], ['add', '.'], ['commit', '-m', 'fixture']]) {
    const result = spawnSync('git', args, { cwd: repoRoot, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  fs.writeFileSync(path.join(repoRoot, 'apps', 'cli', 'changed.txt'), 'review this change\n');
  return { tmp: fixture.root, repoRoot, env };
}

test('review script provides a non-empty prompt to augment in normal uncommitted mode', async (t) => {
  const { tmp, repoRoot, env: fixtureEnv } = await createReviewFixture(t);
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

  const env = {
    ...fixtureEnv,
    // Keep the real Node bin available without letting its real auggie binary shadow our stub.
    PATH: buildToolStubPath(binDir),
    // Keep Augment cache writes out of the repo.
    HAPPIER_STACK_AUGMENT_CACHE_DIR: path.join(tmp, 'augment-home'),
    HAPPIER_STACK_REPO_DIR: repoRoot,
  };

  const res = spawnSync(
    process.execPath,
    [
      path.join(resolveRepoRoot(), 'apps', 'stack', 'scripts', 'review.mjs'),
      'all',
      '--reviewers=augment',
      '--base-ref=HEAD',
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

test('review script infers repo dir from cwd even when target positionals are provided', async (t) => {
  const { tmp, repoRoot, env: fixtureEnv } = await createReviewFixture(t);
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

  const env = {
    ...fixtureEnv,
    PATH: buildToolStubPath(binDir),
    HAPPIER_STACK_AUGMENT_CACHE_DIR: path.join(tmp, 'augment-home'),
    // Do NOT set HAPPIER_STACK_REPO_DIR here; we want it inferred from cwd.
  };

  const res = spawnSync(
    process.execPath,
    [
      path.join(resolveRepoRoot(), 'apps', 'stack', 'scripts', 'review.mjs'),
      'all',
      '--reviewers=augment',
      '--base-ref=HEAD',
      '--type=uncommitted',
      '--depth=normal',
      '--no-chunks',
      '--run-label=test-augment-repo-infer-with-positionals',
    ],
    { cwd: repoRoot, env, encoding: 'utf8' }
  );

  assert.equal(res.status, 0, `expected exit 0; stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const repoRootPattern = repoRoot
    .replaceAll('\\', '\\\\')
    .replace(/^\/private/, '(?:\\/private)?');
  assert.match(res.stdout, new RegExp(`\\[review\\] monorepo detected at ${repoRootPattern}`));
});
