import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const publishedVersionsFixture = JSON.stringify({ github: {}, npm: {} });

function previewVersionFor(packageJsonPath) {
  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, packageJsonPath), 'utf8'));
  assert.equal(typeof packageJson.version, 'string');
  return `${packageJson.version}-preview.1`;
}

test('publish-cli-binaries defaults to run-contracts=auto (runs locally without admitted source proof)', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'publish-cli-binaries.mjs'),
      '--channel',
      'preview',
      '--version',
      previewVersionFor('apps/cli/package.json'),
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
        HAPPIER_RELEASE_SOURCE_CONTRACTS_RESULT: '',
        GITHUB_ACTIONS: '',
        HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: publishedVersionsFixture,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /test:release:contracts/, 'standalone auto must run source contracts when proof is absent');
});

test('publish-cli-binaries defaults to run-contracts=auto (runs on GitHub Actions)', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'publish-cli-binaries.mjs'),
      '--channel',
      'preview',
      '--version',
      previewVersionFor('apps/cli/package.json'),
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
        HAPPIER_RELEASE_SOURCE_CONTRACTS_RESULT: '',
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

test('publish-ui-web defaults to run-contracts=auto (runs locally without admitted source proof)', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'publish-ui-web.mjs'),
      '--channel',
      'preview',
      '--version',
      previewVersionFor('apps/ui/package.json'),
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
        HAPPIER_RELEASE_SOURCE_CONTRACTS_RESULT: '',
        GITHUB_ACTIONS: '',
        HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: publishedVersionsFixture,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /test:release:contracts/, 'standalone auto must run source contracts when proof is absent');
});
