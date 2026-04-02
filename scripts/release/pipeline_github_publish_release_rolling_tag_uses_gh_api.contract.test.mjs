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

test('pipeline GitHub rolling release updates the tag ref via gh api (not git push)', async () => {
  const tmp = fs.mkdtempSync(resolve(os.tmpdir(), 'happier-publish-release-'));
  const binDir = resolve(tmp, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const ghLog = resolve(tmp, 'gh.log');
  fs.writeFileSync(ghLog, '', 'utf8');

  const asset = resolve(tmp, 'asset.txt');
  fs.writeFileSync(asset, 'hello\n', 'utf8');

  const gitLog = resolve(tmp, 'git.log');
  fs.writeFileSync(gitLog, '', 'utf8');

  const gitPath = resolve(binDir, 'git');
  makeExecutable(
    gitPath,
    `#!/bin/sh
set -eu

echo "git $*" >> "${gitLog}"

cmd="$1"
shift || true

case "$cmd" in
  rev-parse)
    # Simulate no local tag ref.
    exit 1
    ;;
  push)
    echo "unexpected git push: $*" >&2
    exit 2
    ;;
  remote)
    if [ "$1" = "get-url" ] && [ "$2" = "origin" ]; then
      echo "https://github.com/test/test.git"
      exit 0
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
  );

  const ghPath = resolve(binDir, 'gh');
  makeExecutable(
    ghPath,
    `#!/bin/sh
set -eu

echo "gh $*" >> "${ghLog}"

if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  # Simulate missing release (script should create it).
  exit 1
fi

if [ "$1" = "api" ]; then
  # Return a deterministic old sha for the tag ref probe.
  if echo "$*" | grep -q "repos/test/test/git/ref/tags/dev-test"; then
    echo "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    exit 0
  fi
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
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
  };

  execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'github', 'publish-release.mjs'),
      '--tag',
      'dev-test',
      '--title',
      'Dev Test',
      '--target-sha',
      '0123456789abcdef0123456789abcdef01234567',
      '--prerelease',
      'true',
      '--rolling-tag',
      'true',
      '--generate-notes',
      'false',
      '--notes',
      'Rolling dev build.',
      '--prune-assets',
      'false',
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
  assert.match(log, /gh api -X PATCH repos\/test\/test\/git\/refs\/tags\/dev-test/);

  const gitCalls = fs.readFileSync(gitLog, 'utf8');
  assert.doesNotMatch(gitCalls, /\bgit push\b/);
});

