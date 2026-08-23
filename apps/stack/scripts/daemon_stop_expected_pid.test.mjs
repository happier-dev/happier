import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { stopLocalDaemon } from './daemon.mjs';
import { spawnDetachedTestProcess } from './testkit/core/spawn_test_process.mjs';
import { writeStubHappierCliFiles } from './testkit/core/stub_happier_cli_files.mjs';
import { killPidOwnedByStack } from './utils/proc/ownership.mjs';
import { resolvePreferredStackDaemonStatePaths } from './utils/auth/credentials_paths.mjs';
import { applyStackDaemonLifecycleScopeEnv } from './utils/auth/stable_scope_id.mjs';
import { sanitizeStackTestRunnerEnv } from './utils/test/test_env.mjs';

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

async function spawnDaemonLikeProcess({ cliHomeDir, internalServerUrl, stackName = 'main' }) {
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
        HAPPIER_SERVER_URL: internalServerUrl,
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_PROCESS_KIND: 'daemon',
      },
    },
  );
  return child.pid;
}

async function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForPidExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await delay(20);
  }
  return false;
}

async function stopPidIfAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 1) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  await delay(50);
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // exited
  }
}

test('stopLocalDaemon bounds a hung CLI stop child, terminates its group, and continues state cleanup', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-daemon-timeout-'));
  let daemonPid = null;
  let stopDescendantPid = null;
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    const cliHomeDir = join(tmp, 'cli-home');
    const monoRoot = join(cliDir, '..', '..');
    const { cliBinDir, cliDistDir } = await writeStubHappierCliFiles(monoRoot, {
      packageJsonContent: '{}\n',
      distIndexScript: `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
  stdio: 'ignore',
});
writeFileSync(process.env.STOP_DESCENDANT_PID_PATH, String(descendant.pid), 'utf8');
setInterval(() => {}, 1000);
`.trimStart(),
      binHappierScript: 'process.exit(0);\n',
    });
    const cliBin = join(cliBinDir, 'happier.mjs');
    const internalServerUrl = 'http://127.0.0.1:3005';
    const env = {
      ...sanitizeStackTestRunnerEnv(process.env),
      // Exercise post-readiness group termination without making fresh Node startup itself
      // race a two-second timer on a contended host.
      HAPPIER_STACK_DAEMON_STOP_TIMEOUT_MS: '10000',
      HAPPIER_STACK_DAEMON_STOP_TERMINATE_GRACE_MS: '50',
      STOP_DESCENDANT_PID_PATH: join(tmp, 'stop-descendant.pid'),
    };
    daemonPid = await spawnDaemonLikeProcess({ cliHomeDir, internalServerUrl });
    const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl: internalServerUrl, env });
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ pid: daemonPid, httpPort: 0 }) + '\n', 'utf-8');

    let timeoutError = null;
    const stopStartedAt = Date.now();
    try {
      await stopLocalDaemon(
        {
          cliBin,
          cliNodeEntrypoint: join(cliDistDir, 'index.mjs'),
          cliHomeDir,
          internalServerUrl,
          env,
        },
        {
          killPidOwnedByStackImpl: async (pid) => {
            process.kill(pid, 'SIGTERM');
            return { killed: true, reason: 'test-owned-daemon' };
          },
        },
      );
    } catch (error) {
      timeoutError = error;
    }
    const stopElapsedMs = Date.now() - stopStartedAt;
    assert.equal(timeoutError?.code, 'ETIMEDOUT');
    assert.match(timeoutError?.message ?? '', /daemon stop timed out/i);
    assert.ok(stopElapsedMs < 20_000, `daemon stop timeout must remain bounded (elapsed=${stopElapsedMs}ms)`);
    const stopChildPid = Number(timeoutError?.childPid);
    assert.ok(Number.isFinite(stopChildPid) && stopChildPid > 1, 'timeout should identify its spawned stop child');
    await waitForFile(env.STOP_DESCENDANT_PID_PATH);
    stopDescendantPid = Number(await readFile(env.STOP_DESCENDANT_PID_PATH, 'utf8'));
    assert.ok(Number.isFinite(stopDescendantPid) && stopDescendantPid > 1, 'expected spawned stop-command descendant');
    assert.equal(
      await waitForPidExit(stopChildPid),
      true,
      'hung CLI stop process group should be terminated',
    );
    assert.equal(
      await waitForPidExit(stopDescendantPid),
      true,
      'hung CLI stop descendant must be terminated with its group',
    );
    assert.equal(
      await waitForPidExit(daemonPid),
      true,
      'daemon state cleanup must continue after CLI stop timeout',
    );
  } finally {
    await stopPidIfAlive(stopDescendantPid);
    await stopPidIfAlive(daemonPid);
    await rm(tmp, { recursive: true, force: true });
  }
});

test('stopLocalDaemon signals only the expected daemon pid from current scoped state', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-daemon-expected-pid-'));
  let daemonPid = null;
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    const cliHomeDir = join(tmp, 'cli-home');
    const markerPath = join(tmp, 'marker.txt');
    const cliBin = await writeStubHappyCli({ cliDir });
    const env = sanitizeStackTestRunnerEnv(process.env);

    const internalServerUrl = 'http://127.0.0.1:3005';
    const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl: internalServerUrl, env });
    await mkdir(dirname(statePath), { recursive: true });
    daemonPid = await spawnDaemonLikeProcess({ cliHomeDir, internalServerUrl });
    await writeFile(statePath, JSON.stringify({ pid: daemonPid, httpPort: 0 }) + '\n', 'utf-8');

    await stopLocalDaemon({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      expectedPid: daemonPid + 1,
      env: { ...env, MARKER_PATH: markerPath },
    });
    assert.equal(existsSync(markerPath), false);
    assert.doesNotThrow(() => process.kill(daemonPid, 0));

    await stopLocalDaemon({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      expectedPid: daemonPid,
      env: { ...env, MARKER_PATH: markerPath },
    });
    assert.equal(existsSync(markerPath), false, 'successor-specific stop must not invoke generic CLI stop');
    assert.throws(() => process.kill(daemonPid, 0));
  } finally {
    await stopPidIfAlive(daemonPid);
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
    const env = sanitizeStackTestRunnerEnv(process.env);

    await mkdir(join(cliDir, 'bin'), { recursive: true });
    await writeFile(join(cliDir, 'package.json'), '{}\n', 'utf-8');
    await writeFile(join(cliBin), "throw new Error('cli bin should not run when dist is missing');\n", 'utf-8');

    const daemonPid = await spawnDaemonLikeProcess({ cliHomeDir, internalServerUrl });
    const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl: internalServerUrl, env });
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ pid: daemonPid, httpPort: 0 }) + '\n', 'utf-8');

    await stopLocalDaemon({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      env,
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

test('stopLocalDaemon routes daemon.state cleanup through canonical owned termination and reconciles membership', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-daemon-canonical-owner-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const cliDir = join(tmp, 'apps', 'cli');
  const cliHomeDir = join(tmp, 'cli-home');
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const runtimeStatePath = join(tmp, 'stack.runtime.json');
  const internalServerUrl = 'http://127.0.0.1:3005';
  const env = sanitizeStackTestRunnerEnv(process.env);
  const daemonEnv = applyStackDaemonLifecycleScopeEnv({ env, stackName: 'main', cliIdentity: 'default' });
  const { statePath } = resolvePreferredStackDaemonStatePaths({
    cliHomeDir,
    serverUrl: internalServerUrl,
    env: daemonEnv,
  });
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify({ pid: 4242, httpPort: 0 }) + '\n', 'utf8');
  await writeFile(runtimeStatePath, JSON.stringify({
    stackName: 'main',
    processes: { daemonPid: 4242, daemonPids: [4242] },
    processInstances: {
      processes: {
        daemonPid: { pid: 4242, fingerprint: 'linux-proc:owned' },
      },
    },
  }) + '\n', 'utf8');

  const killCalls = [];
  const syncCalls = [];
  await stopLocalDaemon(
    {
      cliBin,
      cliHomeDir,
      internalServerUrl,
      runtimeStatePath,
      env,
    },
    {
      killPidOwnedByStackImpl: async (pid, options) => {
        killCalls.push({ pid, options });
        return { killed: false, reason: 'process_instance_mismatch' };
      },
      syncStackRuntimeDaemonPidFromDaemonStateImpl: async (options) => {
        syncCalls.push(options);
        return { running: false, pid: 4242, status: 'unreachable', source: 'daemon_state' };
      },
    },
  );

  assert.equal(killCalls.length, 1);
  assert.equal(killCalls[0]?.pid, 4242);
  assert.equal(killCalls[0]?.options?.processInstanceFingerprint, 'linux-proc:owned');
  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0]?.runtimeStatePath, runtimeStatePath);
});

test('stopLocalDaemon does not promote fresh process identity for old Windows daemon state or lock PIDs', async (t) => {
  for (const source of ['state', 'lock']) {
    await t.test(source, async () => {
      const tmp = await mkdtemp(join(tmpdir(), `hstack-stop-daemon-windows-old-${source}-`));
      t.after(async () => {
        await rm(tmp, { recursive: true, force: true });
      });

      const cliDir = join(tmp, 'apps', 'cli');
      const cliHomeDir = join(tmp, 'cli-home');
      const cliBin = join(cliDir, 'bin', 'happier.mjs');
      const runtimeStatePath = join(tmp, 'old-stack.runtime.json');
      const internalServerUrl = 'http://127.0.0.1:3005';
      const env = sanitizeStackTestRunnerEnv(process.env);
      const daemonEnv = applyStackDaemonLifecycleScopeEnv({ env, stackName: 'main', cliIdentity: 'default' });
      const { statePath, lockPath } = resolvePreferredStackDaemonStatePaths({
        cliHomeDir,
        serverUrl: internalServerUrl,
        env: daemonEnv,
      });
      await mkdir(dirname(statePath), { recursive: true });
      if (source === 'state') {
        await writeFile(statePath, JSON.stringify({ pid: process.pid, httpPort: 0 }) + '\n', 'utf8');
      } else {
        await writeFile(lockPath, String(process.pid) + '\n', 'utf8');
      }
      await writeFile(runtimeStatePath, JSON.stringify({
        stackName: 'main',
        processes: { daemonPid: process.pid, daemonPids: [process.pid] },
      }) + '\n', 'utf8');

      const killCalls = [];
      await stopLocalDaemon(
        {
          cliBin,
          cliHomeDir,
          internalServerUrl,
          runtimeStatePath,
          expectedPid: process.pid,
          env,
        },
        {
          killPidOwnedByStackImpl: async (pid, options) => {
            killCalls.push({ pid, options });
            return options.processInstanceFingerprint
              ? { killed: true, reason: 'unsafe_fresh_identity' }
              : { killed: false, reason: 'process_instance_unavailable' };
          },
        },
      );

      assert.equal(killCalls.length, 1);
      assert.equal(killCalls[0]?.pid, process.pid);
      assert.equal(killCalls[0]?.options?.processInstanceFingerprint ?? null, null);
    });
  }
});

test('stopLocalDaemon does not kill a successor when scoped state changes after expectedPid verification', async (t) => {
  if (process.platform === 'win32') {
    t.skip('requires a POSIX ps boundary fixture');
    return;
  }
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-daemon-successor-race-'));
  let expectedPid = null;
  let successorPid = null;
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    const cliHomeDir = join(tmp, 'cli-home');
    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    const internalServerUrl = 'http://127.0.0.1:3005';
    const stackName = 'successor-race';
    const env = sanitizeStackTestRunnerEnv(process.env);
    const cliBin = await writeStubHappyCli({ cliDir });
    const daemonEnv = applyStackDaemonLifecycleScopeEnv({ env, stackName, cliIdentity: 'default' });
    const { statePath } = resolvePreferredStackDaemonStatePaths({
      cliHomeDir,
      serverUrl: internalServerUrl,
      env: daemonEnv,
    });
    await mkdir(dirname(statePath), { recursive: true });
    expectedPid = await spawnDaemonLikeProcess({ cliHomeDir, internalServerUrl, stackName });
    successorPid = await spawnDaemonLikeProcess({ cliHomeDir, internalServerUrl, stackName });
    await writeFile(statePath, JSON.stringify({ pid: expectedPid, httpPort: 0 }) + '\n', 'utf-8');

    let releaseKill;
    let markKillEntered;
    const killEntered = new Promise((resolve) => { markKillEntered = resolve; });
    const killRelease = new Promise((resolve) => { releaseKill = resolve; });
    const stopPromise = stopLocalDaemon(
      {
        cliBin,
        cliHomeDir,
        internalServerUrl,
        stackName,
        expectedPid,
        runtimeStatePath,
        env,
      },
      {
        killPidOwnedByStackImpl: async (pid, options) => {
          markKillEntered();
          await killRelease;
          return await killPidOwnedByStack(pid, options);
        },
      },
    );
    await killEntered;

    await writeFile(statePath, JSON.stringify({ pid: successorPid, httpPort: 0 }) + '\n', 'utf-8');
    await writeFile(runtimeStatePath, JSON.stringify({
      processes: { daemonPid: successorPid, daemonPids: [successorPid] },
    }) + '\n', 'utf8');
    releaseKill();
    await stopPromise;

    assert.throws(() => process.kill(expectedPid, 0), 'expected daemon should be stopped');
    assert.doesNotThrow(() => process.kill(successorPid, 0), 'successor must remain alive');
    assert.equal(JSON.parse(await readFile(runtimeStatePath, 'utf8')).processes.daemonPid, successorPid);
  } finally {
    await stopPidIfAlive(expectedPid);
    await stopPidIfAlive(successorPid);
    await rm(tmp, { recursive: true, force: true });
  }
});
