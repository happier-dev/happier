import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline CLI smoke script supports --dry-run', async () => {
  const out = execFileSync(
    process.execPath,
    [resolve(repoRoot, 'scripts', 'pipeline', 'smoke', 'cli-smoke.mjs'), '--dry-run'],
    {
      cwd: repoRoot,
      env: { ...process.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\bnpm pack\b/);
  assert.match(out, /\bnpm install\b/);
  assert.match(out, /\bhappier\b.*--help/);
  assert.match(out, /\bhappier\b.*--version/);
});

