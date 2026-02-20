import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline CLI can docker-publish in dry-run using env-only secrets', async () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';

  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'docker-publish',
      '--channel',
      'stable',
      '--sha',
      sha,
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] docker publish: channel=stable/);
  assert.match(out, /\[dry-run\] docker buildx build /);
  assert.match(out, /--tag happierdev\/relay-server:stable-0123456789ab/);
});

test('pipeline CLI docker-publish forwards --registries to include GHCR tags', async () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';

  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'docker-publish',
      '--channel',
      'stable',
      '--sha',
      sha,
      '--registries',
      'dockerhub,ghcr',
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] docker publish: channel=stable/);
  assert.match(out, /--tag happierdev\/relay-server:stable\b/);
  assert.match(out, /--tag ghcr\.io\/happier-dev\/relay-server:stable\b/);
});
