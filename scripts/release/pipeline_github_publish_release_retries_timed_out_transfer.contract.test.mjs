import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline GitHub release retries a stalled asset transfer after its transfer timeout', () => {
  const tmp = fs.mkdtempSync(resolve(os.tmpdir(), 'happier-publish-release-transfer-timeout-'));
  const binDir = resolve(tmp, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const ghLog = resolve(tmp, 'gh.log');
  const stateFile = resolve(tmp, 'state.json');
  const asset = resolve(tmp, 'asset.txt');
  fs.writeFileSync(ghLog, '', 'utf8');
  fs.writeFileSync(stateFile, JSON.stringify({ uploadAttempts: 0 }), 'utf8');
  fs.writeFileSync(asset, 'hello\n', 'utf8');

  const ghPath = resolve(binDir, 'gh');
  fs.writeFileSync(ghPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const logFile = ${JSON.stringify(ghLog)};
const stateFile = ${JSON.stringify(stateFile)};
const asset = ${JSON.stringify(asset)};
fs.appendFileSync(logFile, \`gh \${args.join(' ')}\\n\`);

if (args[0] === 'release' && args[1] === 'upload') {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.uploadAttempts += 1;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  if (state.uploadAttempts === 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  process.exit(0);
}

if (args[0] === 'release' && args[1] === 'download') {
  const dirIndex = args.indexOf('--dir');
  const destination = args[dirIndex + 1];
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(asset, path.join(destination, path.basename(asset)));
}
`, { encoding: 'utf8', mode: 0o755 });

  execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'github', 'publish-release.mjs'),
      '--tag', 'cli-v0.2.10-dev.test',
      '--title', 'Happier CLI v0.2.10-dev.test',
      '--target-sha', '0123456789abcdef0123456789abcdef01234567',
      '--prerelease', 'true',
      '--rolling-tag', 'false',
      '--generate-notes', 'true',
      '--assets', asset,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        GH_REPO: 'test/test',
        GH_TOKEN: 'dummy',
        GITHUB_REPOSITORY: '',
        HAPPIER_PIPELINE_GH_RELEASE_TRANSFER_TIMEOUT_MS: '50',
        HAPPIER_PIPELINE_GH_RELEASE_UPLOAD_RETRIES: '3',
        HAPPIER_PIPELINE_GH_RELEASE_UPLOAD_RETRY_DELAY_MS: '10',
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    },
  );

  const log = fs.readFileSync(ghLog, 'utf8');
  assert.equal(
    log.match(/gh release upload cli-v0\.2\.10-dev\.test /g)?.length ?? 0,
    2,
    'expected the timed-out transfer to be retried',
  );
});
