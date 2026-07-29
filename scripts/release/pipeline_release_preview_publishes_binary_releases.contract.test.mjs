import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createReleaseCliDryRunEnv, RELEASE_CLI_DRY_RUN_TIMEOUT_MS } from './releaseCliDryRunTestkit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('release dev to preview dry-run reports CLI and stack facts without predicting binary publisher jobs', async () => {
  const stub = createReleaseCliDryRunEnv();
  try {
    const out = execFileSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
        'release',
        '--confirm',
        'release dev to preview',
        '--repository',
        'happier-dev/happier',
        '--deploy-environment',
        'preview',
        '--deploy-targets',
        'cli,stack',
        '--dry-run',
      ],
      {
        cwd: repoRoot,
        env: {
          ...stub.env,
          MINISIGN_SECRET_KEY: 'untrusted comment: minisign encrypted secret key\nRWQpH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1',
          MINISIGN_PASSPHRASE: 'x',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: RELEASE_CLI_DRY_RUN_TIMEOUT_MS,
      },
    );

    assert.match(out, /\[pipeline\] rolling version suffix: preview\./);
    assert.match(out, /\[pipeline\] dry-run: hosted dispatch inputs/);
    assert.match(out, /- deploy_targets: cli,stack/);
    assert.match(out, /- publish_cli=true publish_stack=true/);
    assert.doesNotMatch(out, /runPublishCliBinaries|runPublishHstackBinaries/);
  } finally {
    stub.cleanup();
  }
});
