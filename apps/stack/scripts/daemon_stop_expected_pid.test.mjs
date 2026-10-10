import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';

import { stopLocalDaemon } from './daemon.mjs';
import { spawnDetachedTestProcess } from './testkit/core/spawn_test_process.mjs';
import { writeStubHappierCliFiles } from './testkit/core/stub_happier_cli_files.mjs';
import { resolvePreferredStackDaemonStatePaths } from './utils/auth/credentials_paths.mjs';
import { recordStackRuntimeStart } from './utils/stack/runtime_state.mjs';

test('stopLocalDaemon retires unpublished starting generations only for the exact stack home', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-unpublished-daemon-'));
  const pids = [];
  try {
    const cliHomeDir = join(tmp, 'cli-home');
    const internalServerUrl = 'http://127.0.0.1:3005';
    const stackName = 'unpublished-stop';
    const own = { cliHomeDir, internalServerUrl, stackName };
    pids.push(await spawnDaemonLikeProcess(own));
    pids.push(await spawnDaemonLikeProcess({ ...own, internalServerUrl: 'http://127.0.0.1:3006' }));
    pids.push(await spawnDaemonLikeProcess({ ...own, stackName: `${stackName}-peer` }));
    pids.push(await spawnDaemonLikeProcess({ ...own, cliHomeDir: `${cliHomeDir}-peer` }));
    pids.push(await spawnDaemonLikeProcess({ ...own, processKind: 'session' }));

    await stopLocalDaemon({ cliBin: join(tmp, 'missing', 'happier.mjs'), cliHomeDir,
      internalServerUrl, stackName, expectedPid: pids[0],
      env: { ...process.env, HAPPIER_STACK_REPO_DIR: '', HAPPIER_STACK_STACK: stackName } });
    for (const pid of pids) assert.doesNotThrow(() => process.kill(pid, 0), 'guarded old-owner shutdown must not sweep an unpublished successor');

    await stopLocalDaemon({ cliBin: join(tmp, 'missing', 'happier.mjs'), cliHomeDir,
      internalServerUrl, stackName,
      env: { ...process.env, HAPPIER_STACK_REPO_DIR: '', HAPPIER_STACK_STACK: stackName } });

    for (const pid of pids.slice(0, 2)) assert.throws(() => process.kill(pid, 0), 'unpublished daemon generations must retire');
    for (const pid of pids.slice(2)) assert.doesNotThrow(() => process.kill(pid, 0), 'other stacks, sibling homes and sessions must survive');
  } finally {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('stopLocalDaemon retires the recorded source bundle owner even when CLI stop removes its publication', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-source-owner-'));
  let daemonPid = null;
  try {
    const cliHomeDir = join(tmp, 'cli-home');
    const internalServerUrl = 'http://127.0.0.1:3005';
    const stackName = 'source-owner-stop';
    const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl: internalServerUrl, env: {} });
    daemonPid = await spawnDaemonLikeProcess({ cliHomeDir, internalServerUrl, stackName });
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ pid: daemonPid, httpPort: 0 }));
    const oldEntrypoint = join(tmp, 'bundle-old.mjs');
    const newEntrypoint = join(tmp, 'bundle-new.mjs');
    const markerPath = join(tmp, 'old-owner-stop');
    await writeFile(oldEntrypoint, `import { unlinkSync, writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(markerPath)}, 'old');\nunlinkSync(${JSON.stringify(statePath)});\n`);
    await writeFile(newEntrypoint, 'process.exit(0);\n');
    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    await recordStackRuntimeStart(runtimeStatePath, { stackName, ownerPid: process.pid,
      sourceRuntimeLaunch: { entrypoint: oldEntrypoint, cliDir: tmp, env: {} },
      processes: { daemonPid, daemonPids: [daemonPid] } });

    await stopLocalDaemon({ cliBin: newEntrypoint, cliEntrypoint: newEntrypoint, cliHomeDir,
      internalServerUrl, runtimeStatePath, stackName,
      env: { ...process.env, HAPPIER_STACK_REPO_DIR: '', HAPPIER_STACK_STACK: stackName } });

    assert.equal(existsSync(markerPath), true, 'retirement must use the retained source CLI launch');
    assert.throws(() => process.kill(daemonPid, 0), 'retirement must not forget a PID when its publication disappears');
    daemonPid = null;
  } finally {
    if (daemonPid) { try { process.kill(daemonPid, 'SIGKILL'); } catch {} }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('stopLocalDaemon remembers the scoped owner before a stop command removes daemon state', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-source-publication-'));
  let daemonPid = null;
  try {
    const cliHomeDir = join(tmp, 'cli-home');
    const internalServerUrl = 'http://127.0.0.1:3005';
    const stackName = 'source-publication-stop';
    daemonPid = await spawnDaemonLikeProcess({ cliHomeDir, internalServerUrl, stackName });
    const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl: internalServerUrl, env: {} });
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ pid: daemonPid, httpPort: 0 }));
    const cliEntrypoint = join(tmp, 'stop.mjs');
    await writeFile(cliEntrypoint, `import { unlinkSync } from 'node:fs';\nunlinkSync(${JSON.stringify(statePath)});\n`);
    await stopLocalDaemon({ cliBin: cliEntrypoint, cliEntrypoint, cliHomeDir, internalServerUrl, stackName,
      env: { ...process.env, HAPPIER_STACK_REPO_DIR: '', HAPPIER_STACK_STACK: stackName } });
    assert.throws(() => process.kill(daemonPid, 0), 'disappearing publication is not proof of process retirement');
    daemonPid = null;
  } finally {
    if (daemonPid) { try { process.kill(daemonPid, 'SIGKILL'); } catch {} }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('stopLocalDaemon retires every retained bundle daemon PID without requiring moving CLI dist', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-source-pid-set-'));
  const pids = [];
  try {
    const cliHomeDir = join(tmp, 'cli-home');
    const internalServerUrl = 'http://127.0.0.1:3005';
    const stackName = 'source-pid-set-stop';
    pids.push(await spawnDaemonLikeProcess({ cliHomeDir, internalServerUrl, stackName }));
    pids.push(await spawnDaemonLikeProcess({ cliHomeDir, internalServerUrl, stackName }));
    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    await recordStackRuntimeStart(runtimeStatePath, { stackName, ownerPid: process.pid,
      processes: { daemonPid: pids[1], daemonPids: pids } });
    await stopLocalDaemon({ cliBin: join(tmp, 'missing', 'happier.mjs'), cliHomeDir,
      internalServerUrl, runtimeStatePath, stackName,
      env: { ...process.env, HAPPIER_STACK_REPO_DIR: '', HAPPIER_STACK_STACK: stackName } });
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), `retained bundle PID ${pid} must be retired`);
    pids.length = 0;
  } finally {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await rm(tmp, { recursive: true, force: true });
  }
});

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

async function spawnDaemonLikeProcess({ cliHomeDir, internalServerUrl, stackName = '', processKind = 'daemon' }) {
  const logDir = join(cliHomeDir, 'logs');
  await mkdir(logDir, { recursive: true });
  const ownedLogPath = join(logDir, 'daemon-owned.log');
  const child = spawnDetachedTestProcess(
    process.execPath,
    [
      '-e',
      "const fs = require('node:fs'); const p = process.env.DAEMON_OWNED_LOG_PATH || ''; if (!p) process.exit(2); const fd = fs.openSync(p, 'a'); fs.writeSync(fd, 'ready\\n'); if (process.send) { process.send('ready'); process.disconnect(); } setInterval(() => {}, 1000);",
      'daemon',
      'start-sync',
    ],
    {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env,
        DAEMON_OWNED_LOG_PATH: ownedLogPath,
        HAPPIER_HOME_DIR: cliHomeDir,
        HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
        ...(stackName ? { HAPPIER_STACK_STACK: stackName } : {}),
        HAPPIER_STACK_PROCESS_KIND: processKind,
        HAPPIER_SERVER_URL: internalServerUrl,
      },
    },
  );
  await once(child, 'message');
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

test('stopLocalDaemon does not launch moving or retained source CLI when the scoped daemon is already stopped', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-daemon-already-stopped-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    const cliHomeDir = join(tmp, 'cli-home');
    const markerPath = join(tmp, 'marker.txt');
    const cliBin = await writeStubHappyCli({ cliDir });

    await stopLocalDaemon({
      cliBin,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:3005',
      env: {
        ...process.env,
        HAPPIER_STACK_REPO_DIR: '',
        MARKER_PATH: markerPath,
      },
    });

    assert.equal(existsSync(markerPath), false);
    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    await recordStackRuntimeStart(runtimeStatePath, { stackName: 'already-stopped', ownerPid: process.pid,
      sourceRuntimeLaunch: { entrypoint: join(cliDir, 'dist', 'index.mjs'), cliDir, env: { MARKER_PATH: markerPath } } });
    await stopLocalDaemon({ cliBin, cliHomeDir, internalServerUrl: 'http://127.0.0.1:3005',
      runtimeStatePath, env: { ...process.env, HAPPIER_STACK_REPO_DIR: '' } });
    assert.equal(existsSync(markerPath), false, 'a retained source launch alone is not a live daemon');
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
    const stackName = 'daemon-stop-test';

    await mkdir(join(cliDir, 'bin'), { recursive: true });
    await writeFile(join(cliDir, 'package.json'), '{}\n', 'utf-8');
    await writeFile(join(cliBin), "throw new Error('cli bin should not run when dist is missing');\n", 'utf-8');

    const daemonPid = await spawnDaemonLikeProcess({ cliHomeDir, internalServerUrl, stackName });
    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    await recordStackRuntimeStart(runtimeStatePath, {
      stackName,
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
      stackName,
      env: { ...process.env, HAPPIER_STACK_STACK: stackName },
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
