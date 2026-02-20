import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline github commit+push script supports dry-run and optional missing paths', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'github', 'commit-and-push.mjs'),
      '--paths',
      'apps/ui/package.json,apps/ui/DOES_NOT_EXIST',
      '--allow-missing',
      'true',
      '--message',
      'chore(release): bump',
      '--push-ref',
      'dev',
      '--push-mode',
      'auto',
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

  assert.match(out, /\bgit add\b/);
  assert.match(out, /\bgit commit\b/);
  assert.match(out, /\bgit ls-remote\b/);
  assert.match(out, /\bgit push\b/);
  assert.match(out, /\bDID_COMMIT=true\b/);
});
