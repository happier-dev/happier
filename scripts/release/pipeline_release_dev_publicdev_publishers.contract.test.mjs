import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createReleaseCliDryRunEnv, RELEASE_CLI_DRY_RUN_TIMEOUT_MS } from './releaseCliDryRunTestkit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline CLI release can dry-run the public dev lane from the nightly dev release mapping', async () => {
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
    assert.match(out, /\[pipeline\] dry-run: would run/);
    assert.match(out, /- runPublishUiWeb: true/);
    assert.match(out, /- runPublishServerRuntime: true/);
    assert.match(out, /- runPublishDocker: true/);
    assert.match(out, /- runPublishCliBinaries: true/);
    assert.match(out, /- runPublishHstackBinaries: true/);
    assert.match(out, /- runPublishNpm: true/);
    assert.match(out, /- runDeployUi: false/);
    assert.match(out, /- runDeployServer: false/);
    assert.match(out, /- runDeployWebsite: false/);
    assert.match(out, /- runDeployDocs: false/);
  } finally {
    stub.cleanup();
  }
});
