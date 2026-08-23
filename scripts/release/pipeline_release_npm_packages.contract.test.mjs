import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline npm release script supports dry-run for CLI tarball publish', async () => {
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
      env: { ...process.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /apps\/cli/);
  assert.match(out, /scripts\/pipeline\/npm\/publish-tarball\.mjs/);
});

test('pipeline npm release script supports dev channel prerelease versions in dry-run', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'npm', 'release-packages.mjs'),
      '--channel',
      'dev',
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
      env: { ...process.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /version: [\d.]+ -> [\d.]+-dev\./);
  assert.match(out, /publish-tarball\.mjs --channel preview .* --tag dev\b/);
});

test('pipeline npm release script prepares the plugin SDK lockstep pair through the sandbox without patching source manifests', () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'npm', 'release-packages.mjs'),
      '--channel',
      'preview',
      '--publish-cli',
      'false',
      '--publish-stack',
      'false',
      '--publish-server',
      'false',
      '--publish-plugin-sdk',
      'true',
      '--publish-sdk',
      'false',
      '--plugin-sdk-version',
      '0.1.0-preview.7',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({ github: {}, npm: {
          '@happier-dev/plugin-sdk': [],
          '@happier-dev/plugin-ui': [],
        } }),
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /packages\/plugin-sdk \(plugin_sdk\)/);
  assert.match(out, /packages\/plugin-ui \(plugin_ui\)/);
  assert.match(out, /pack sandbox packages\/plugin-sdk/);
  assert.match(out, /pack sandbox packages\/plugin-ui/);
  assert.doesNotMatch(out, /patch packages\/(?:plugin-sdk|plugin-ui)\/package\.json/);
});
