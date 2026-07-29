import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline npm release script supports pack-only mode (no publish) in dry-run', async () => {
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
      '--mode',
      'pack',
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
  assert.doesNotMatch(out, /publish-tarball\.mjs/);
});

test('pipeline npm release force-admits every bundled workspace package before ignore-scripts packing', () => {
  const source = readFileSync(
    resolve(repoRoot, 'scripts', 'pipeline', 'npm', 'release-packages.mjs'),
    'utf8',
  );
  const artifactBundleCalls =
    source.match(/\['scripts\/bundleWorkspaceDeps\.mjs',\s*'--artifact'\]/g) ?? [];

  assert.equal(
    artifactBundleCalls.length,
    3,
    'expected CLI, Stack, and server release preparation to invoke their bundlers in artifact mode',
  );
  assert.match(
    source,
    /args:\s*\['pack',\s*'--ignore-scripts'/,
    'expected the release path to retain explicit ignore-scripts packing after artifact preparation',
  );
});
