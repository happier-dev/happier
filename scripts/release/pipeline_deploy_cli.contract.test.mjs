import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline deploy CLI can run deploy dry-run using env-file mode', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'deploy',
      '--deploy-environment',
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
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        DEPLOY_WEBHOOK_URL: 'https://ci.example.com/api/deploy',
        CF_WEBHOOK_DEPLOY_CLIENT_ID: 'cf-id',
        CF_WEBHOOK_DEPLOY_CLIENT_SECRET: 'cf-secret',
        HAPPIER_SERVER_API_DEPLOY_WEBHOOKS: 'server-api',
        HAPPIER_SERVER_WORKER_DEPLOY_WEBHOOKS: 'server-worker',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] deploy webhooks: env=production component=server ref=deploy\/production\/server/);
  assert.match(out, /Dokploy webhook target: ref=refs\/heads\/deploy\/production\/server/);
});

