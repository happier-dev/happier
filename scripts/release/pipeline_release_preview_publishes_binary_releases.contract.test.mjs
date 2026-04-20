import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createReleaseCliDryRunEnv, RELEASE_CLI_DRY_RUN_TIMEOUT_MS } from './releaseCliDryRunTestkit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('release dev to preview dry-runs CLI binary releases without hstack release signoff', async () => {
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
        '--npm-mode',
        'pack',
        '--dry-run',
        '--secrets-source',
        'env',
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
    assert.match(out, /\[pipeline\] dry-run: would run/);
    assert.match(out, /- runPublishCliBinaries: true/);
    assert.match(out, /- runPublishHstackBinaries: false/);
  } finally {
    stub.cleanup();
  }
});
