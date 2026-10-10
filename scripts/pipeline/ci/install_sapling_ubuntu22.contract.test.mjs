import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const scriptPath = resolve('scripts/ci/install_sapling_ubuntu22.sh');

function runInstaller({ sudo, checksumStatus = 0, installStatus = 0 }) {
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
  executable('curl', 'exit 0');
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
      env: { ...process.env, PATH: bin, SAPLING_TEST_INSTALLED: installed },
    });
    return { status: result.status, stderr: result.stderr, installed: existsSync(installed) };
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
