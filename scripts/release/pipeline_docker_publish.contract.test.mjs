import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline docker publish script supports dry-run and computes stable tags', async () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';

  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'docker', 'publish-images.mjs'),
      '--channel',
      'stable',
      '--sha',
      sha,
      '--push-latest',
      'true',
      '--build-relay',
      'true',
      '--build-devcontainer',
      'true',
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

  assert.match(out, /\[dry-run\] docker buildx build /);
  assert.match(out, /\[dry-run\] docker login\b/);
  assert.match(out, /--target relay-server/);
  assert.match(out, /--file Dockerfile/);
  assert.match(out, /--tag happierdev\/relay-server:stable/);
  assert.match(out, /--tag happierdev\/relay-server:stable-0123456789ab/);
  assert.match(out, /--tag happierdev\/relay-server:latest/);

  assert.match(out, /--file docker\/devcontainer\/Dockerfile/);
  assert.match(out, /--tag happierdev\/dev-container:stable/);
  assert.match(out, /--tag happierdev\/dev-container:stable-0123456789ab/);
  assert.match(out, /--tag happierdev\/dev-container:latest/);
});
