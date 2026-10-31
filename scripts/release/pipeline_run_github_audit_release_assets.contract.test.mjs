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

test('pipeline release-asset audit accepts a complete envelope and refuses a missing signature', () => {
  const assets = [
    'happier-v1.2.3-preview.123.2-linux-x64.tar.gz',
    'checksums-happier-v1.2.3-preview.123.2.txt',
    'checksums-happier-v1.2.3-preview.123.2.txt.minisig',
  ];
  const args = [
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
  ];
  const res = run([...args, JSON.stringify(assets)]);

  assert.equal(res.status, 0, `expected exit 0, got ${res.status} stderr=${res.stderr}`);
  assert.match(res.stdout, /expected: 3 found: 3/);
  assert.match(res.stdout, /\[pipeline\] OK/);

  const missingSignature = run([...args, JSON.stringify(assets.slice(0, -1))]);
  assert.equal(missingSignature.status, 1, missingSignature.stdout);
  assert.match(missingSignature.stderr, /MISSING assets:/);
  assert.ok(missingSignature.stderr.includes(assets[2]), missingSignature.stderr);
  assert.doesNotMatch(missingSignature.stdout, /\[pipeline\] OK/);
});

