import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline CLI release can include preview publishers (docker + ui-web + server-runtime) in dry-run', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'release',
      '--confirm',
      'release preview from dev',
      '--deploy-environment',
      'preview',
      '--deploy-targets',
      'ui,server,server_runner',
      '--force-deploy',
      'true',
      '--repository',
      'happier-dev/happier',
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
        HAPPIER_UI_DEPLOY_WEBHOOKS: 'ui',
        HAPPIER_SERVER_API_DEPLOY_WEBHOOKS: 'server-api',
        HAPPIER_SERVER_WORKER_DEPLOY_WEBHOOKS: 'server-worker',
        GH_TOKEN: '',
        GH_REPO: '',
        GITHUB_REPOSITORY: '',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] release: environment=preview confirm=release preview from dev/);
  assert.match(out, /\[pipeline\] dry-run: would run/);
  assert.match(out, /- runPublishDocker: true/);
  assert.match(out, /- runPublishUiWeb: true/);
  assert.match(out, /- runPublishServerRuntime: true/);
});
