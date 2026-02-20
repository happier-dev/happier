import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline CLI exposes smoke-cli subcommand', async () => {
  const out = execFileSync(
    process.execPath,
    [resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'), 'smoke-cli', '--dry-run'],
    {
      cwd: repoRoot,
      env: { ...process.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /scripts\/pipeline\/smoke\/cli-smoke\.mjs/);
  assert.match(out, /\bCLI smoke test passed\b/);
});
