import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('resolve-bump-plan computes bump + publish flags from changed components and deploy_targets', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'resolve-bump-plan.mjs'),
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
      'ui,server,cli,stack',
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

  const parsed = JSON.parse(out);
  assert.deepEqual(parsed, {
    publish_cli: true,
    publish_stack: true,
    publish_server: false,
    bump_app: 'patch',
    bump_cli: 'none',
    bump_stack: 'patch',
    bump_server: 'none',
    bump_website: 'none',
    should_bump: true,
  });
});

test('resolve-bump-plan only publishes server runner when deploy_targets includes server_runner', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'resolve-bump-plan.mjs'),
      '--environment',
      'preview',
      '--bump-preset',
      'patch',
      '--bump-app-override',
      'preset',
      '--bump-cli-override',
      'preset',
      '--bump-stack-override',
      'preset',
      '--deploy-targets',
      'server',
      '--changed-ui',
      'false',
      '--changed-cli',
      'false',
      '--changed-stack',
      'false',
      '--changed-server',
      'true',
      '--changed-website',
      'false',
      '--changed-shared',
      'false',
    ],
    { cwd: repoRoot, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  const parsed = JSON.parse(out);
  assert.equal(parsed.publish_server, false);

  const out2 = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'resolve-bump-plan.mjs'),
      '--environment',
      'preview',
      '--bump-preset',
      'patch',
      '--bump-app-override',
      'preset',
      '--bump-cli-override',
      'preset',
      '--bump-stack-override',
      'preset',
      '--deploy-targets',
      'server_runner',
      '--changed-ui',
      'false',
      '--changed-cli',
      'false',
      '--changed-stack',
      'false',
      '--changed-server',
      'true',
      '--changed-website',
      'false',
      '--changed-shared',
      'false',
    ],
    { cwd: repoRoot, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );
  const parsed2 = JSON.parse(out2);
  assert.equal(parsed2.publish_server, true);
});

