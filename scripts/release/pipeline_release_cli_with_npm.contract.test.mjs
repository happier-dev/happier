import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createReleaseCliDryRunEnv, RELEASE_CLI_DRY_RUN_TIMEOUT_MS } from './releaseCliDryRunTestkit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline CLI release can include npm publish lane in dry-run', async () => {
  const stub = createReleaseCliDryRunEnv();
  try {
    const out = execFileSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
        'release',
        '--confirm',
        'release dev to preview',
        '--deploy-environment',
        'preview',
        '--deploy-targets',
        'cli',
        '--force-deploy',
        'true',
        '--repository',
        'happier-dev/happier',
        '--npm-mode',
        'pack+publish',
        '--dry-run',
        '--secrets-source',
        'env',
      ],
      {
        cwd: repoRoot,
        env: {
          ...stub.env,
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
        timeout: RELEASE_CLI_DRY_RUN_TIMEOUT_MS,
      },
    );

    assert.match(out, /\[pipeline\] release: environment=preview confirm=release dev to preview/);
    assert.match(out, /\[pipeline\] dry-run: would run/);
    assert.match(out, /- runPublishNpm: true/);
  } finally {
    stub.cleanup();
  }
});
