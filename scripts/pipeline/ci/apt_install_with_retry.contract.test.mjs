import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, 'scripts', 'ci', 'apt-install-with-retry.sh');

function writeExecutable(filePath, content) {
  writeFileSync(filePath, content, 'utf8');
  chmodSync(filePath, 0o755);
}

function createFakeAptWorkspace({ updateBody = 'exit 0', installBody = 'exit 0', cleanBody = 'exit 0' }) {
  const root = mkdtempSync(path.join(tmpdir(), 'apt-install-with-retry-'));
  const binDir = path.join(root, 'bin');
  mkdirSync(binDir, { recursive: true });

  writeExecutable(
    path.join(binDir, 'apt-get'),
    `#!/usr/bin/env bash
set -euo pipefail
state_file="\${FAKE_APT_STATE_FILE:?}"
printf '%s\\n' "$*" >> "$state_file"
subcommand=""
for arg in "$@"; do
  case "$arg" in
    update|install|clean)
      subcommand="$arg"
      break
      ;;
  esac
done
case "$subcommand" in
  update)
${updateBody}
    ;;
  install)
${installBody}
    ;;
  clean)
${cleanBody}
    ;;
  *)
    echo "unexpected apt-get args: $*" >&2
    exit 2
    ;;
esac
`,
  );

  return root;
}

test('apt-install-with-retry retries transient mirror-sync failures and cleans apt state before retrying', () => {
  const root = createFakeAptWorkspace({
    updateBody: `    count_file="\${FAKE_APT_UPDATE_COUNT_FILE:?}"
    count=0
    if [ -f "$count_file" ]; then
      count="$(cat "$count_file")"
    fi
    count=$((count + 1))
    printf '%s' "$count" > "$count_file"
    if [ "$count" -eq 1 ]; then
      echo 'E: Failed to fetch http://archive.ubuntu.com/ubuntu/dists/noble-updates/main/binary-amd64/Packages.gz  File has unexpected size (2401874 != 2401847). Mirror sync in progress?' >&2
      exit 100
    fi
    exit 0`,
    installBody: '    exit 0',
  });
  const stateFile = path.join(root, 'state.log');
  const updateCountFile = path.join(root, 'update-count.txt');

  const res = spawnSync('bash', [scriptPath, 'ca-certificates', 'curl'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
      FAKE_APT_STATE_FILE: stateFile,
      FAKE_APT_UPDATE_COUNT_FILE: updateCountFile,
      APT_INSTALL_RETRY_SLEEP_SECONDS: '0',
    },
  });

  assert.equal(res.status, 0, `expected retrying apt install to succeed, stderr:\n${res.stderr}`);
  const stateLines = readFileSync(stateFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.equal(stateLines.length, 4, `expected update/clean/update/install sequence, got:\n${stateLines.join('\n')}`);
  assert.match(stateLines[0], /\bAcquire::Retries=3\b[\s\S]*\bAcquire::By-Hash=force\b[\s\S]*\bupdate\b/);
  assert.match(stateLines[1], /\bclean\b/);
  assert.match(stateLines[2], /\bAcquire::Retries=3\b[\s\S]*\bupdate\b/);
  assert.match(stateLines[3], /\binstall\b[\s\S]*--no-install-recommends[\s\S]*ca-certificates[\s\S]*curl\b/);
});

test('apt-install-with-retry does not retry non-transient apt failures', () => {
  const root = createFakeAptWorkspace({
    installBody: `    echo 'E: Unable to locate package definitely-missing-package' >&2
    exit 100`,
  });
  const stateFile = path.join(root, 'state.log');

  const res = spawnSync('bash', [scriptPath, 'definitely-missing-package'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
      FAKE_APT_STATE_FILE: stateFile,
      APT_INSTALL_RETRY_SLEEP_SECONDS: '0',
    },
  });

  assert.notEqual(res.status, 0, 'expected non-transient apt failure to bubble up');
  const stateLines = readFileSync(stateFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.equal(stateLines.length, 2, `expected one update and one install attempt, got:\n${stateLines.join('\n')}`);
  assert.match(stateLines[0], /\bupdate\b/);
  assert.match(stateLines[1], /\binstall\b[\s\S]*definitely-missing-package\b/);
  assert.match(res.stderr, /non-transient/i, 'expected stderr to explain that the failure was not retried');
});
