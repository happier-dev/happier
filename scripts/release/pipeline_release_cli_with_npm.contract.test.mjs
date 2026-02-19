import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline CLI release can include npm publish lane in dry-run', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'release',
      '--confirm',
      'release preview from dev',
      '--deploy-environment',
      'production',
      '--deploy-targets',
      'server',
      '--repository',
      'happier-dev/happier',
      '--npm-targets',
      'cli',
      '--npm-mode',
      'pack+publish',
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
        NPM_TOKEN: 'npm-token',
        GH_TOKEN: '',
        GH_REPO: '',
        GITHUB_REPOSITORY: '',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] release: npm channel=preview targets=cli/);
  assert.match(out, /scripts\/pipeline\/npm\/release-packages\.mjs/);
  assert.match(out, /scripts\/pipeline\/npm\/publish-tarball\.mjs/);
});

