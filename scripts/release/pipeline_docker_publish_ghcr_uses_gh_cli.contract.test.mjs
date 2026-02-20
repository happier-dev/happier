import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function writeExecutable(filePath, contents) {
  writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o755 });
  chmodSync(filePath, 0o755);
}

test('pipeline docker publish can use gh CLI auth for GHCR when local env is missing GHCR_*', async () => {
  const binDir = mkdtempSync(resolve(tmpdir(), 'happier-pipeline-ghcr-bin-'));
  const dockerPath = resolve(binDir, 'docker');
  const ghPath = resolve(binDir, 'gh');

  writeExecutable(
    ghPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "auth" ] && [ "$2" = "token" ]; then
  echo "gh-test-token"
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "user" ]; then
  echo "gh-test-user"
  exit 0
fi
echo "unsupported gh args: $*" >&2
exit 2
`,
  );

  writeExecutable(
    dockerPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "info" ]; then
  exit 0
fi
if [ "$1" = "buildx" ] && [ "$2" = "inspect" ]; then
  echo "Driver: docker-container"
  exit 0
fi
if [ "$1" = "login" ]; then
  user=""
  shift
  while [ $# -gt 0 ]; do
    if [ "$1" = "--username" ]; then
      shift
      user="$1"
      break
    fi
    shift
  done
  echo "FAKE_DOCKER_LOGIN_USER=$user"
  exit 0
fi
echo "unsupported docker args: $*" >&2
exit 2
`,
  );

  const sha = '0123456789abcdef0123456789abcdef01234567';

  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'docker', 'publish-images.mjs'),
      '--channel',
      'preview',
      '--sha',
      sha,
      '--push-latest',
      'false',
      '--build-relay',
      'false',
      '--build-dev-box',
      'false',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        PIPELINE_DOCKER_REGISTRIES: 'ghcr',
        GHCR_NAMESPACE: 'ghcr.io/happier-dev',
        // Ensure we're in "local" mode, so fallback to gh CLI is allowed.
        GITHUB_ACTIONS: 'false',
        // Ensure the test fails unless fallback works.
        GHCR_USERNAME: '',
        GHCR_TOKEN: '',
        GITHUB_ACTOR: '',
        GITHUB_TOKEN: '',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] docker login: ghcr\.io\b/);
  assert.match(out, /FAKE_DOCKER_LOGIN_USER=gh-test-user\b/);
});
