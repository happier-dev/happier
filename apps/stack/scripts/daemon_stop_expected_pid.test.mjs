import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { stopLocalDaemon } from './daemon.mjs';
import { spawnDetachedTestProcess } from './testkit/core/spawn_test_process.mjs';
import { writeStubHappierCliFiles } from './testkit/core/stub_happier_cli_files.mjs';
import { resolvePreferredStackDaemonStatePaths } from './utils/auth/credentials_paths.mjs';
import { recordStackRuntimeStart } from './utils/stack/runtime_state.mjs';

async function writeStubHappyCli({ cliDir }) {
  const script = `
import { writeFileSync } from 'node:fs';

const markerPath = process.env.MARKER_PATH || '';
const args = process.argv.slice(2);
if (args[0] === 'daemon' && args[1] === 'stop') {
  if (markerPath) {
    writeFileSync(markerPath, 'stopped\\n', 'utf8');
  }
  process.exit(0);
}
process.exit(0);
`.trimStart();
  const monoRoot = join(cliDir, '..', '..');
  const { cliBinDir } = await writeStubHappierCliFiles(monoRoot, {
    packageJsonContent: '{}\n',
    distIndexScript: script,
    // Ensure stopLocalDaemon launches via dist entrypoint (preferred).
    binHappierScript: 'process.exit(0);\n',
  });
  return join(cliBinDir, 'happier.mjs');
}

async function spawnDaemonLikeProcess({ cliHomeDir, internalServerUrl, stackName = '' }) {
  const logDir = join(cliHomeDir, 'logs');
  await mkdir(logDir, { recursive: true });
  const ownedLogPath = join(logDir, 'daemon-owned.log');
  const child = spawnDetachedTestProcess(
    process.execPath,
    [
      '-e',
      "const fs = require('node:fs'); const p = process.env.DAEMON_OWNED_LOG_PATH || ''; if (!p) process.exit(2); const fd = fs.openSync(p, 'a'); fs.writeSync(fd, 'ready\\n'); setInterval(() => {}, 1000);",
      'daemon',
      'start-sync',
    ],
    {
      stdio: 'ignore',
      env: {
        ...process.env,
        DAEMON_OWNED_LOG_PATH: ownedLogPath,
        HAPPIER_HOME_DIR: cliHomeDir,
        HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
        ...(stackName ? { HAPPIER_STACK_STACK: stackName } : {}),
        HAPPIER_STACK_PROCESS_KIND: 'daemon',
        HAPPIER_SERVER_URL: internalServerUrl,
      },
    },
  );
  return child.pid;
}

test('stopLocalDaemon skips stop when expectedPid does not match current daemon state pid', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-daemon-expected-pid-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    const cliHomeDir = join(tmp, 'cli-home');
    const markerPath = join(tmp, 'marker.txt');
    const cliBin = await writeStubHappyCli({ cliDir });
    const daemonEnv = {
      ...process.env,
      // This fixture owns its CLI checkout; do not inherit the unit runner's real repo override.
      HAPPIER_STACK_REPO_DIR: '',
      MARKER_PATH: markerPath,
    };

    const internalServerUrl = 'http://127.0.0.1:3005';
    const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl: internalServerUrl, env: {} });
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ pid: 222, httpPort: 0 }) + '\n', 'utf-8');

    await stopLocalDaemon({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      expectedPid: 111,
      env: daemonEnv,
    });
    assert.equal(existsSync(markerPath), false);

    await stopLocalDaemon({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      expectedPid: 222,
      env: daemonEnv,
    });
    assert.equal(existsSync(markerPath), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('stopLocalDaemon stops a live daemon from daemon.state.json when cli dist is missing', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-daemon-missing-dist-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    const cliHomeDir = join(tmp, 'cli-home');
    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    const internalServerUrl = 'http://127.0.0.1:3005';

    await mkdir(join(cliDir, 'bin'), { recursive: true });
    await writeFile(join(cliDir, 'package.json'), '{}\n', 'utf-8');
    await writeFile(join(cliBin), "throw new Error('cli bin should not run when dist is missing');\n", 'utf-8');

    const daemonPid = await spawnDaemonLikeProcess({ cliHomeDir, internalServerUrl });
    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    await recordStackRuntimeStart(runtimeStatePath, {
      stackName: 'daemon-stop-test',
      ownerPid: process.pid,
      processes: { daemonPid, daemonPids: [daemonPid] },
    });
    const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl: internalServerUrl, env: {} });
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ pid: daemonPid, httpPort: 0 }) + '\n', 'utf-8');

    await stopLocalDaemon({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      runtimeStatePath,
      env: process.env,
    });

    let alive = true;
    try {
      process.kill(daemonPid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, `expected daemon pid ${daemonPid} to be stopped`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('stopLocalDaemon delegates legacy POSIX state without persisted identity to canonical ownership', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-daemon-legacy-owner-'));
  let daemonPid = null;
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    const cliHomeDir = join(tmp, 'cli-home');
    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    const internalServerUrl = 'http://127.0.0.1:3005';
    const stackName = 'daemon-legacy-owner-test';

    await mkdir(join(cliDir, 'bin'), { recursive: true });
    await writeFile(join(cliDir, 'package.json'), '{}\n', 'utf-8');
    await writeFile(cliBin, "throw new Error('cli bin should not run when dist is missing');\n", 'utf-8');

    daemonPid = await spawnDaemonLikeProcess({ cliHomeDir, internalServerUrl, stackName });
    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    await writeFile(
      runtimeStatePath,
      JSON.stringify({
        version: 1,
        stackName,
        ownerPid: process.pid,
        processes: { daemonPid },
      }) + '\n',
      'utf-8',
    );
    const { statePath } = resolvePreferredStackDaemonStatePaths({
      cliHomeDir,
      serverUrl: internalServerUrl,
      env: {},
    });
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ pid: daemonPid, httpPort: 0 }) + '\n', 'utf-8');

    await stopLocalDaemon({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      runtimeStatePath,
      stackName,
      env: process.env,
    });

    assert.throws(() => process.kill(daemonPid, 0));
    daemonPid = null;
  } finally {
    if (daemonPid) {
      try {
        process.kill(daemonPid, 'SIGKILL');
      } catch {
        // Already exited.
      }
    }
    await rm(tmp, { recursive: true, force: true });
  }
});
