import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function makeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o755 });
}

test('pipeline GitHub versioned release retries asset upload when GitHub has not materialized the new release yet', async () => {
  const tmp = fs.mkdtempSync(resolve(os.tmpdir(), 'happier-publish-release-upload-retry-'));
  const binDir = resolve(tmp, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const ghLog = resolve(tmp, 'gh.log');
  const stateFile = resolve(tmp, 'state.json');
  fs.writeFileSync(ghLog, '', 'utf8');
  fs.writeFileSync(stateFile, JSON.stringify({ created: false, uploadAttempts: 0 }), 'utf8');

  const asset = resolve(tmp, 'asset.txt');
  fs.writeFileSync(asset, 'hello\n', 'utf8');

  const ghPath = resolve(binDir, 'gh');
  makeExecutable(
    ghPath,
    `#!/bin/sh
set -eu

log_file=${JSON.stringify(ghLog)}
state_file=${JSON.stringify(stateFile)}

echo "gh $*" >> "$log_file"

read_state() {
  node -e "const fs=require('fs'); const s=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(JSON.stringify(s));" "$state_file"
}

write_state() {
  node -e "const fs=require('fs'); fs.writeFileSync(process.argv[1], process.argv[2]);" "$state_file" "$1"
}

state="$(read_state)"
created="$(node -e "const s=JSON.parse(process.argv[1]); process.stdout.write(String(s.created));" "$state")"
upload_attempts="$(node -e "const s=JSON.parse(process.argv[1]); process.stdout.write(String(s.uploadAttempts));" "$state")"

if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  if [ "$created" = "true" ]; then
    exit 0
  fi
  exit 1
fi

if [ "$1" = "release" ] && [ "$2" = "create" ]; then
  write_state '{"created":true,"uploadAttempts":0}'
  exit 0
fi

if [ "$1" = "release" ] && [ "$2" = "upload" ]; then
  if [ "$upload_attempts" = "0" ]; then
    write_state '{"created":true,"uploadAttempts":1}'
    echo "release not found" >&2
    exit 1
  fi
  write_state '{"created":true,"uploadAttempts":2}'
  exit 0
fi

if [ "$1" = "api" ]; then
  exit 0
fi

exit 0
`,
  );

  const env = {
    ...process.env,
    GH_REPO: 'test/test',
    GH_TOKEN: 'dummy',
    GITHUB_REPOSITORY: '',
    HAPPIER_PIPELINE_GH_RELEASE_UPLOAD_RETRIES: '3',
    HAPPIER_PIPELINE_GH_RELEASE_UPLOAD_RETRY_DELAY_MS: '10',
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
  };

  execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'github', 'publish-release.mjs'),
      '--tag',
      'stack-v0.2.0-preview.test',
      '--title',
      'Happier Stack v0.2.0-preview.test',
      '--target-sha',
      '0123456789abcdef0123456789abcdef01234567',
      '--prerelease',
      'true',
      '--rolling-tag',
      'false',
      '--generate-notes',
      'true',
      '--assets',
      asset,
    ],
    {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  const log = fs.readFileSync(ghLog, 'utf8');
  assert.match(log, /gh release create stack-v0\.2\.0-preview\.test /);
  assert.equal(
    log.match(/gh release upload stack-v0\.2\.0-preview\.test /g)?.length ?? 0,
    2,
    'expected publish-release to retry the upload after the first release-not-found response',
  );
});
