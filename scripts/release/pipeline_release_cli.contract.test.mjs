import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createReleaseCliDryRunEnv, RELEASE_CLI_DRY_RUN_TIMEOUT_MS } from './releaseCliDryRunTestkit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline CLI release dry-run reports hosted deploy inputs without predicting deploy jobs', async () => {
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
        'server',
        '--force-deploy',
        'true',
        '--repository',
        'happier-dev/happier',
        '--release-notes-id',
        'test-release',
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
    assert.match(out, /release profile=integrated/);
    assert.doesNotMatch(out, /hosted checks profile|checks_profile/, 'the hosted workflow resolves checks from the public profile');
    assert.match(out, /\[pipeline\] dry-run: hosted dispatch inputs/);
    assert.match(out, /- deploy_targets: server/);
    assert.match(out, /- force_deploy: true/);
    assert.doesNotMatch(out, /runDeployServer|runPublish/);
  } finally {
    stub.cleanup();
  }
});

test('pipeline CLI release dry-run defaults production to the stable release profile', async () => {
  const stub = createReleaseCliDryRunEnv();
  try {
    const out = execFileSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
        'release',
        '--confirm',
        'release preview to main',
        '--deploy-environment',
        'production',
        '--deploy-targets',
        'server',
        '--repository',
        'happier-dev/happier',
        '--release-notes-id',
        'test-release',
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
          GH_TOKEN: '',
          GH_REPO: '',
          GITHUB_REPOSITORY: '',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: RELEASE_CLI_DRY_RUN_TIMEOUT_MS,
      },
    );

    assert.match(out, /\[pipeline\] release: environment=production confirm=release preview to main/);
    assert.match(out, /release profile=stable/);
    assert.doesNotMatch(out, /hosted checks profile|checks_profile/, 'the local dispatcher must not become a second checks-profile owner');
  } finally {
    stub.cleanup();
  }
});

test('pipeline CLI rejects the manual deep profile before release work begins', () => {
  const result = spawnSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'release',
      '--confirm',
      'release dev to preview',
      '--deploy-environment',
      'preview',
      '--deploy-targets',
      'server',
      '--repository',
      'happier-dev/happier',
      '--release-notes-id',
      'test-release',
      '--release-profile',
      'deep',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: process.env,
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /manual comprehensive certification/i);
});

test('pipeline CLI rejects automatic version bumps even for dry-run release planning', () => {
  const stub = createReleaseCliDryRunEnv();
  try {
    const result = spawnSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
        'release',
        '--confirm',
        'release dev to preview',
        '--deploy-environment',
        'preview',
        '--deploy-targets',
        'server',
        '--repository',
        'happier-dev/happier',
        '--release-notes-id',
        'test-release',
        '--bump',
        'patch',
        '--dry-run',
      ],
      {
        cwd: repoRoot,
        env: { ...stub.env },
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Materialize and commit changelog and version updates, then rerun with --bump none\./);
  } finally {
    stub.cleanup();
  }
});
