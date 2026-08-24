import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const publishedVersionsFixture = JSON.stringify({ github: {}, npm: {} });

test('publish-cli-binaries defaults to run-contracts=auto (skips locally)', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'publish-cli-binaries.mjs'),
      '--channel',
      'preview',
      '--version',
      '0.2.10-preview.1',
      '--allow-stable',
      'false',
      '--check-installers',
      'false',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_ACTIONS: '',
        HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: publishedVersionsFixture,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.doesNotMatch(out, /test:release:contracts/, 'local default should not run release contract tests');
});

test('publish-cli-binaries defaults to run-contracts=auto (runs on GitHub Actions)', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'publish-cli-binaries.mjs'),
      '--channel',
      'preview',
      '--version',
      '0.2.10-preview.1',
      '--allow-stable',
      'false',
      '--check-installers',
      'false',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_ACTIONS: 'true',
        HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: publishedVersionsFixture,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /test:release:contracts/, 'GitHub Actions default should run release contract tests');
});

test('publish-ui-web defaults to run-contracts=auto (skips locally)', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'publish-ui-web.mjs'),
      '--channel',
      'preview',
      '--version',
      '0.2.10-preview.1',
      '--allow-stable',
      'false',
      '--check-installers',
      'false',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_ACTIONS: '',
        HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: publishedVersionsFixture,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.doesNotMatch(out, /test:release:contracts/, 'local default should not run release contract tests');
});
