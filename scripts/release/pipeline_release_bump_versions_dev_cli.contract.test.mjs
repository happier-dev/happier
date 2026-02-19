import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline CLI can run bump-versions-dev in dry-run', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'release-bump-versions-dev',
      '--bump-app',
      'patch',
      '--bump-cli',
      'none',
      '--bump-stack',
      'minor',
      '--bump-server',
      'none',
      '--bump-website',
      'none',
      '--dry-run',
    ],
    { cwd: repoRoot, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  assert.match(out, /scripts\/pipeline\/release\/bump-versions-dev\.mjs/);
  assert.match(out, /scripts\/pipeline\/release\/bump-version\.mjs --component app --bump patch/);
  assert.match(out, /\bgit push origin HEAD:dev\b/);
});
