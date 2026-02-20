import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('run.mjs forwards unknown flags to wrapped release scripts (dry-run)', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'release-build-cli-binaries',
      '--dry-run',
      '--channel',
      'preview',
      '--version',
      '0.0.0-preview.test.1',
      '--targets',
      'linux-arm64',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /build-cli-binaries\.mjs/);
  assert.match(out, /"--channel"/);
  assert.match(out, /"preview"/);
  assert.match(out, /"--version"/);
  assert.match(out, /0\.0\.0-preview\.test\.1/);
});

