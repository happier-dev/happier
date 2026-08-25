import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function assertCanonicalCliPublicationBuild(out) {
  const sharedDepsStep = out.indexOf('apps/cli/scripts/buildSharedDeps.mjs --artifact');
  const distStep = out.indexOf('apps/cli/scripts/build.mjs');
  assert.ok(sharedDepsStep >= 0, 'release must run the canonical shared-dependency publication step');
  assert.ok(distStep > sharedDepsStep, 'release must build CLI dist after publication shared dependencies');
}

test('npm release script defaults to skipping tests locally when run-tests=auto', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'npm', 'release-packages.mjs'),
      '--channel',
      'preview',
      '--publish-cli',
      'true',
      '--publish-stack',
      'false',
      '--publish-server',
      'false',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, GITHUB_ACTIONS: '' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assertCanonicalCliPublicationBuild(out);
  assert.doesNotMatch(out, /\byarn prepublishOnly\b/);
});

test('npm release script defaults to running tests in GitHub Actions when run-tests=auto', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'npm', 'release-packages.mjs'),
      '--channel',
      'preview',
      '--publish-cli',
      'true',
      '--publish-stack',
      'false',
      '--publish-server',
      'false',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, GITHUB_ACTIONS: 'true' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assertCanonicalCliPublicationBuild(out);
  assert.match(out, /\byarn prepublishOnly\b/);
});
