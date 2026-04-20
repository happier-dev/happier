import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, 'scripts', 'ci', 'yarn-install-with-retry.sh');

function writeExecutable(filePath, content) {
  writeFileSync(filePath, content, 'utf8');
  chmodSync(filePath, 0o755);
}

function createFakeYarnWorkspace({ installBody }) {
  const root = mkdtempSync(path.join(tmpdir(), 'yarn-install-with-retry-'));
  const binDir = path.join(root, 'bin');
  mkdirSync(binDir, { recursive: true });

  writeExecutable(
    path.join(binDir, 'yarn'),
    `#!/bin/sh
set -eu
state_file="\${FAKE_YARN_STATE_FILE:?}"
printf '%s\\n' "$*" >> "$state_file"
if [ "$#" -ge 3 ] && [ "$1" = "config" ] && [ "$2" = "set" ] && [ "$3" = "registry" ]; then
  exit 0
fi
if [ "$#" -ge 2 ] && [ "$1" = "cache" ] && [ "$2" = "clean" ]; then
  exit 0
fi
if [ "$#" -ge 1 ] && [ "$1" = "install" ]; then
${installBody}
fi
echo "unexpected yarn args: $*" >&2
exit 2
`,
  );

  return root;
}

test('yarn-install-with-retry retries transient registry failures and clears the cache before retrying', () => {
  const root = createFakeYarnWorkspace({
    installBody: `  count_file="\${FAKE_YARN_INSTALL_COUNT_FILE:?}"
  count=0
  if [ -f "$count_file" ]; then
    count="$(cat "$count_file")"
  fi
  count=$((count + 1))
  printf '%s' "$count" > "$count_file"
  if [ "$count" -eq 1 ]; then
    echo 'error https://registry.yarnpkg.com/@img/sharp-linux-arm/-/sharp-linux-arm-0.34.5.tgz: Request failed "502 Bad Gateway"' >&2
    exit 1
  fi
  exit 0`,
  });
  const stateFile = path.join(root, 'state.log');
  const installCountFile = path.join(root, 'install-count.txt');

  const res = spawnSync('bash', [scriptPath, '--frozen-lockfile', '--ignore-engines'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
      FAKE_YARN_STATE_FILE: stateFile,
      FAKE_YARN_INSTALL_COUNT_FILE: installCountFile,
      YARN_INSTALL_RETRY_SLEEP_SECONDS: '0',
    },
  });

  assert.equal(res.status, 0, `expected retrying install to succeed, stderr:\n${res.stderr}`);
  const stateLines = readFileSync(stateFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.deepEqual(
    stateLines,
    [
      'config set registry https://registry.npmjs.org/',
      'install --frozen-lockfile --ignore-engines',
      'cache clean',
      'install --frozen-lockfile --ignore-engines',
    ],
    'expected a transient failure to trigger cache cleanup and a second install attempt',
  );
});

test('yarn-install-with-retry does not retry non-transient failures', () => {
  const root = createFakeYarnWorkspace({
    installBody: `  echo 'error Command failed with exit code 1.' >&2
  exit 1`,
  });
  const stateFile = path.join(root, 'state.log');

  const res = spawnSync('bash', [scriptPath, '--frozen-lockfile'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
      FAKE_YARN_STATE_FILE: stateFile,
      YARN_INSTALL_RETRY_SLEEP_SECONDS: '0',
    },
  });

  assert.notEqual(res.status, 0, 'expected non-transient install failure to bubble up');
  const stateLines = readFileSync(stateFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.deepEqual(
    stateLines,
    ['config set registry https://registry.npmjs.org/', 'install --frozen-lockfile'],
    'expected non-transient failures to stop after the first install attempt',
  );
  assert.match(res.stderr, /non-transient error/i, 'expected stderr to explain that the failure was not retried');
});

test('yarn-install-with-retry executes directly without bash on PATH for alpine docker stages', () => {
  const root = createFakeYarnWorkspace({
    installBody: '  exit 0',
  });
  const stateFile = path.join(root, 'state.log');
  const installedScriptPath = path.join(root, 'yarn-install-with-retry');
  copyFileSync(scriptPath, installedScriptPath);
  chmodSync(installedScriptPath, 0o755);

  const res = spawnSync(installedScriptPath, ['--frozen-lockfile'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(root, 'bin')}:/usr/bin:/usr/sbin:/sbin`,
      FAKE_YARN_STATE_FILE: stateFile,
      YARN_INSTALL_RETRY_SLEEP_SECONDS: '0',
    },
  });

  assert.equal(res.status, 0, `expected direct-exec install helper to avoid requiring bash on PATH, stderr:\n${res.stderr}`);
  const stateLines = readFileSync(stateFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.deepEqual(
    stateLines,
    ['config set registry https://registry.npmjs.org/', 'install --frozen-lockfile'],
    'expected the shared helper to run successfully when directly executed in alpine-like environments without bash',
  );
});
