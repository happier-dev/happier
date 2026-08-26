import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createReleaseCliDryRunEnv, RELEASE_CLI_DRY_RUN_TIMEOUT_MS } from './releaseCliDryRunTestkit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline CLI release dry-run reports hosted inputs and release refinements without predicting npm jobs', async () => {
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
        '--release-notes-id',
        'test-release',
        '--waive-ci',
        'true',
        '--approve-public-sdk-release',
        'true',
        '--waive-validation-suites',
        'docker-release-assets',
        '--override-reason',
        'Maintainer accepted the bounded release risk.',
        '--dry-run',
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
    assert.match(out, /\[pipeline\] dry-run: hosted dispatch inputs/);
    assert.match(out, /- workflow: release\.yml/);
    assert.match(out, /- deploy_targets: cli/);
    assert.match(out, /- force_deploy: true/);
    assert.match(out, /- waive_ci: true/);
    assert.match(out, /- approve_public_sdk_release: true/);
    assert.match(out, /- waive_validation_suites: docker-release-assets/);
    assert.match(out, /- override_reason: Maintainer accepted the bounded release risk\./);
    assert.match(out, /- publish_cli=true/);
    assert.doesNotMatch(out, /runPublishNpm|runPublishCliBinaries|runDeploy/);
  } finally {
    stub.cleanup();
  }
});

test('pipeline CLI release dry-run carries public package targets through the materialized-version plan', async () => {
  const stub = createReleaseCliDryRunEnv(process.env, {
    diffPaths: ['packages/plugin-sdk/src/runtime/runtime.ts', 'packages/sdk/src/index.ts'],
  });
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
        'plugin_sdk,sdk',
        '--repository',
        'happier-dev/happier',
        '--release-notes-id',
        'test-public-packages',
        '--dry-run',
      ],
      {
        cwd: repoRoot,
        env: {
          ...stub.env,
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

    assert.match(out, /- plugin_sdk: true/);
    assert.match(out, /- sdk: true/);
    assert.match(out, /- plugin SDK pair: true \(baseline=plugin-sdk-v0\.1\.0\)/);
    assert.match(out, /- SDK: true \(baseline=sdk-v0\.1\.0\)/);
    assert.match(out, /publish_plugin_sdk=true/);
    assert.match(out, /publish_sdk=true/);
  } finally {
    stub.cleanup();
  }
});
