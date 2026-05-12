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

test('set-preview-versions updates selected package.json versions and prints JSON summary', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'happier-preview-versions-'));
  writeJson(dir, 'apps/cli/package.json', { name: '@happier-dev/cli', version: '1.2.3' });
  writeJson(dir, 'apps/stack/package.json', { name: '@happier-dev/stack', version: '9.9.9' });
  writeJson(dir, 'packages/relay-server/package.json', { name: '@happier-dev/relay-server', version: '3.4.5' });

  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'npm', 'set-preview-versions.mjs'),
      '--repo-root',
      dir,
      '--publish-cli',
      'true',
      '--publish-stack',
      'false',
      '--publish-server',
      'true',
      '--server-runner-dir',
      'packages/relay-server',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_RUN_NUMBER: '123',
        GITHUB_RUN_ATTEMPT: '2',
        HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({ github: {}, npm: {} }),
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  ).trim();

  const parsed = JSON.parse(out);
  assert.equal(parsed.cli, '1.2.3-preview.1');
  assert.equal(parsed.server, '3.4.5-preview.1');
  assert.equal(parsed.stack, undefined);

  assert.equal(readJson(dir, 'apps/cli/package.json').version, '1.2.3-preview.1');
  assert.equal(readJson(dir, 'apps/stack/package.json').version, '9.9.9');
  assert.equal(readJson(dir, 'packages/relay-server/package.json').version, '3.4.5-preview.1');
});

test('set-preview-versions catches npm preview version up to the published CLI binary channel', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'happier-preview-versions-'));
  writeJson(dir, 'apps/cli/package.json', { name: '@happier-dev/cli', version: '1.2.3' });

  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'npm', 'set-preview-versions.mjs'),
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
      env: {
        ...process.env,
        GITHUB_RUN_NUMBER: '16',
        GITHUB_RUN_ATTEMPT: '1',
        HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({
          github: {
            cli: ['1.2.3-preview.125.1'],
          },
          npm: {
            '@happier-dev/cli': ['1.2.3-preview.124.1'],
          },
        }),
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  ).trim();

  const parsed = JSON.parse(out);
  assert.equal(parsed.cli, '1.2.3-preview.125.1');
  assert.equal(readJson(dir, 'apps/cli/package.json').version, '1.2.3');
});
