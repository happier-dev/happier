import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline CLI can compute release bump plan (dry-run safe, pure)', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'release-bump-plan',
      '--environment',
      'preview',
      '--bump-preset',
      'patch',
      '--bump-app-override',
      'preset',
      '--bump-cli-override',
      'none',
      '--bump-stack-override',
      'preset',
      '--deploy-targets',
      'ui,cli,stack',
      '--changed-ui',
      'true',
      '--changed-cli',
      'false',
      '--changed-stack',
      'true',
      '--changed-server',
      'false',
      '--changed-website',
      'false',
      '--changed-shared',
      'false',
    ],
    { cwd: repoRoot, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  const lastLine = out
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  assert.ok(lastLine, 'expected JSON output line');
  const parsed = JSON.parse(lastLine);
  assert.equal(parsed.bump_app, 'patch');
  assert.equal(parsed.bump_cli, 'none');
  assert.equal(parsed.bump_stack, 'patch');
  assert.equal(parsed.publish_cli, true);
  assert.equal(parsed.publish_stack, true);
  assert.equal(parsed.publish_server, false);
});

