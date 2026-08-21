import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('immutable release audit retries a transient download reset without re-uploading', () => {
  const tmp = fs.mkdtempSync(resolve(os.tmpdir(), 'happier-publish-release-audit-retry-'));
  const binDir = resolve(tmp, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const ghLog = resolve(tmp, 'gh.log');
  const downloadCount = resolve(tmp, 'download-count');
  const asset = resolve(tmp, 'asset.txt');
  fs.writeFileSync(ghLog, '', 'utf8');
  fs.writeFileSync(downloadCount, '0', 'utf8');
  fs.writeFileSync(asset, 'authorized bytes\n', 'utf8');

  const ghPath = resolve(binDir, 'gh');
  fs.writeFileSync(ghPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ghLog)}, \`gh \${args.join(' ')}\\n\`);

if (args[0] === 'release' && args[1] === 'view' && args.includes('--json')) {
  process.stdout.write('asset.txt\\n');
  process.exit(0);
}
if (args[0] === 'release' && args[1] === 'view') process.exit(0);
if (args[0] === 'release' && args[1] === 'download') {
  const count = Number(fs.readFileSync(${JSON.stringify(downloadCount)}, 'utf8')) + 1;
  fs.writeFileSync(${JSON.stringify(downloadCount)}, String(count));
  if (count === 1) {
    process.stderr.write('read: connection reset by peer\\n');
    process.exit(1);
  }
  const destination = args[args.indexOf('--dir') + 1];
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(${JSON.stringify(asset)}, path.join(destination, 'asset.txt'));
  process.exit(0);
}
if (args[0] === 'api') process.exit(0);
process.exit(0);
`, { encoding: 'utf8', mode: 0o755 });

  execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'github', 'publish-release.mjs'),
      '--tag', 'server-v0.2.10-dev.test',
      '--title', 'Happier Server v0.2.10-dev.test',
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
        HAPPIER_PIPELINE_GH_RELEASE_UPLOAD_RETRIES: '3',
        HAPPIER_PIPELINE_GH_RELEASE_UPLOAD_RETRY_DELAY_MS: '10',
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // The fixture starts several Node-backed fake `gh` processes. Keep the
      // harness ceiling above slow shared-runner process startup; production
      // transfer timeouts are configured independently by the command itself.
      timeout: 30_000,
    },
  );

  const log = fs.readFileSync(ghLog, 'utf8');
  assert.equal(
    log.match(/gh release download server-v0\.2\.10-dev\.test /g)?.length ?? 0,
    3,
    'the pre-upload audit should retry once and the post-upload audit should still verify the asset',
  );
  assert.equal(log.match(/gh release upload server-v0\.2\.10-dev\.test /g)?.length ?? 0, 0);
});
