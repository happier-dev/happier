import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const scriptPath = resolve('scripts/ci/install_sapling_ubuntu22.sh');

function runInstaller({ sudo, checksumStatus = 0, installStatus = 0, token }) {
  const dir = mkdtempSync(join(tmpdir(), 'sapling-install-contract-'));
  const bin = join(dir, 'bin');
  const installed = join(dir, 'installed');
  mkdirSync(bin);
  const executable = (name, body) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/bash\nset -euo pipefail\n${body}\n`);
    chmodSync(path, 0o755);
  };
  // Exercise the real installer against network, checksum-tool and package-manager process boundaries.
  const curlArgs = join(dir, 'curl-args');
  executable('curl', 'printf "%s\\n" "$@" > "$SAPLING_TEST_CURL_ARGS"');
  executable('sha256sum', `read -r checksum_input\nexit ${checksumStatus}`);
  executable('apt-get', `
    case "$1" in
      update) echo 'unavailable mirror metadata' >&2; exit 74 ;;
      install)
        if [ "${installStatus}" != 0 ]; then exit ${installStatus}; fi
        : > "$SAPLING_TEST_INSTALLED"
        ;;
      *) exit 75 ;;
    esac
  `);
  if (sudo) executable('sudo', 'exec "$@"');
  try {
    const result = spawnSync('/bin/bash', [scriptPath], {
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'GITHUB_TOKEN' && name !== 'GH_TOKEN')),
        PATH: bin,
        SAPLING_TEST_INSTALLED: installed,
        SAPLING_TEST_CURL_ARGS: curlArgs,
        ...(token ? { GITHUB_TOKEN: token } : {}),
      },
    });
    const curlArgv = existsSync(curlArgs) ? readFileSync(curlArgs, 'utf8').trim().split('\n') : [];
    return { status: result.status, stderr: result.stderr, installed: existsSync(installed), curlArgv };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const sudo of [false, true]) {
  test(`installs the verified local Sapling archive without requiring mirror metadata (sudo=${sudo})`, () => {
    const result = runInstaller({ sudo });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.installed, true);
  });
}

test('checksum failure prevents Sapling installation', () => {
  const result = runInstaller({ sudo: false, checksumStatus: 1 });
  assert.equal(result.status, 1);
  assert.equal(result.installed, false);
});

test('Sapling dependency installation failures propagate', () => {
  const result = runInstaller({ sudo: true, installStatus: 100 });
  assert.equal(result.status, 100);
  assert.equal(result.installed, false);
});

// github.com/<owner>/sapling/releases/download/... answers 504 for this repository
// (2026-11-08) while the authenticated release-asset API serves the same bytes.
test('downloads the pinned asset through the release-asset API with the job token', () => {
  const result = runInstaller({ sudo: false, token: 'test-token' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.curlArgv.some((arg) => /^https:\/\/api\.github\.com\/repos\/meta\/sapling\/releases\/assets\/\d+$/.test(arg)), result.curlArgv.join(' '));
  assert.ok(result.curlArgv.includes('Accept: application/octet-stream'));
  assert.ok(result.curlArgv.includes('Authorization: Bearer test-token'));
});

test('downloads without an Authorization header when no token is available', () => {
  const result = runInstaller({ sudo: false });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.curlArgv.some((arg) => arg.startsWith('Authorization:')));
});
