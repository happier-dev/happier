import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function run(args) {
  return spawnSync(process.execPath, [resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

test('pipeline run exposes github-audit-release-assets', async () => {
  const res = run([
    'github-audit-release-assets',
    '--tag',
    'cli-preview',
    '--kind',
    'cli',
    '--version',
    '1.2.3-preview.123.2',
    '--targets',
    'linux-x64',
    '--assets-json',
    JSON.stringify([
      'happier-v1.2.3-preview.123.2-linux-x64.tar.gz',
      'checksums-happier-v1.2.3-preview.123.2.txt',
      'checksums-happier-v1.2.3-preview.123.2.txt.minisig',
    ]),
  ]);

  assert.equal(res.status, 0, `expected exit 0, got ${res.status} stderr=${res.stderr}`);
});

