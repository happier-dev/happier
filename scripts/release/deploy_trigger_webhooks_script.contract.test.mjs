import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function runTriggerWebhooks(env, args) {
  const scriptPath = resolve(repoRoot, 'scripts', 'pipeline', 'deploy', 'trigger-webhooks.mjs');
  return execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  });
}

test('trigger-webhooks supports dry-run and enforces server api->worker ordering', async () => {
  const output = runTriggerWebhooks(
    {
      DEPLOY_WEBHOOK_URL: 'https://ci.example.com/api/deploy',
      CF_WEBHOOK_DEPLOY_CLIENT_ID: 'cf-id',
      CF_WEBHOOK_DEPLOY_CLIENT_SECRET: 'cf-secret',
      HAPPIER_SERVER_API_DEPLOY_WEBHOOKS: 'server-api',
      HAPPIER_SERVER_WORKER_DEPLOY_WEBHOOKS: 'server-worker',
    },
    [
      '--environment',
      'production',
      '--component',
      'server',
      '--repository',
      'happier-dev/happier',
      '--ref-name',
      'deploy/production/server',
      '--sha',
      '0123456789abcdef0123456789abcdef01234567',
      '--dry-run',
    ],
  );

  assert.match(output, /refs\/heads\/deploy\/production\/server/);
  assert.ok(
    output.indexOf("server api") < output.indexOf("server worker"),
    'expected server api hooks to be evaluated before server worker hooks',
  );
});

test('trigger-webhooks dry-run can resolve SHA with gh without executing it and URL-encodes deploy ref', async () => {
  const output = runTriggerWebhooks(
    {
      DEPLOY_WEBHOOK_URL: 'https://ci.example.com/api/deploy',
      CF_WEBHOOK_DEPLOY_CLIENT_ID: 'cf-id',
      CF_WEBHOOK_DEPLOY_CLIENT_SECRET: 'cf-secret',
      HAPPIER_WEBSITE_DEPLOY_WEBHOOKS: 'website',
      GH_REPO: 'happier-dev/happier',
      GH_TOKEN: '',
    },
    [
      '--environment',
      'production',
      '--component',
      'website',
      '--repository',
      'happier-dev/happier',
      '--ref-name',
      'deploy/production/website',
      '--dry-run',
    ],
  );

  assert.match(output, /Resolving deploy branch SHA with gh: deploy\/production\/website/);
  assert.match(output, /\[dry-run\] gh api /);
  assert.match(output, /deploy%2Fproduction%2Fwebsite/, 'gh api ref path must URL-encode deploy branch slashes');
});
