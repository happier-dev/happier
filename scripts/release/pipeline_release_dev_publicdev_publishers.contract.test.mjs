import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createReleaseCliDryRunEnv, RELEASE_CLI_DRY_RUN_TIMEOUT_MS } from './releaseCliDryRunTestkit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline CLI release can inspect public dev release facts without predicting nightly publisher jobs', async () => {
  const stub = createReleaseCliDryRunEnv();
  try {
    const out = execFileSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
        'release',
        '--confirm',
        'release dev to dev',
        '--deploy-environment',
        'dev',
        '--deploy-targets',
        'ui,server,server_runner,cli,stack',
        '--force-deploy',
        'true',
        '--repository',
        'happier-dev/happier',
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

    assert.match(out, /\[pipeline\] release: environment=dev confirm=release dev to dev/);
    assert.match(out, /\[pipeline\] rolling version suffix: dev\./);
    assert.match(out, /\[pipeline\] dry-run: hosted dispatch is owned by nightly-dev\.yml/);
    assert.match(out, /- deploy_targets: ui,server,server_runner,cli,stack/);
    assert.match(out, /- force_deploy: true/);
    assert.doesNotMatch(out, /runPublish|runDeploy/);
  } finally {
    stub.cleanup();
  }
});
