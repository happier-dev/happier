import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function writeJson(dir, rel, value) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(dir, rel) {
  return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
}

test('pipeline run exposes npm-set-preview-versions (write=false compute-only)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'happier-preview-versions-'));
  writeJson(dir, 'apps/cli/package.json', { name: '@happier-dev/cli', version: '1.2.3' });

  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'npm-set-preview-versions',
      '--repo-root',
      dir,
      '--publish-cli',
      'true',
      '--publish-stack',
      'false',
      '--publish-server',
      'false',
      '--write',
      'false',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, GITHUB_RUN_NUMBER: '123', GITHUB_RUN_ATTEMPT: '2' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  ).trim();

  const parsed = JSON.parse(out);
  assert.equal(parsed.cli, '1.2.3-preview.123.2');
  assert.equal(readJson(dir, 'apps/cli/package.json').version, '1.2.3');
});

