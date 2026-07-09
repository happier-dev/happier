import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  resolveStackOwnedServerListenPid,
  resolveStackOwnedServerRuntimePid,
  startDevServer,
  stopStackOwnedServerForRestart,
  watchDevServerAndRestart,
} from './server.mjs';
import { getSpawnedProcessPlannedExitReason } from '../proc/proc.mjs';

async function withTempServerDir(t, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-dev-server-watch-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return await fn(dir);
}

function createWatcherOptions(serverDir, overrides = {}) {
  return {
    enabled: true,
    stackMode: true,
    serverComponentName: 'happier-server-light',
    serverDir,
    serverPort: 34567,
    internalServerUrl: 'http://127.0.0.1:34567',
    serverScript: 'dev:light',
    serverEnv: {},
    runtimeStatePath: join(serverDir, 'stack.runtime.json'),
    stackName: 'watch-test',
    envPath: join(serverDir, 'env'),
    children: [],
    serverProcRef: { current: { pid: process.pid, exitCode: null } },
    isShuttingDown: () => false,
    ...overrides,
  };
}

function createChangingSignatureReader() {
  let value = 0;
  return () => String(value++);
}

test('watchDevServerAndRestart watches server-light because dev:light does not self-reload', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const watcher = watchDevServerAndRestart(createWatcherOptions(serverDir));

    try {
      assert.ok(watcher, 'expected a server-light watcher when stack watch mode is enabled');
      assert.equal(typeof watcher.close, 'function');
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart serializes a pending restart observed while waiting for readiness', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    let killCalls = 0;
    let spawnCalls = 0;
    let readyCalls = 0;
    const serverProcRef = { current: { pid: 1234, exitCode: null } };

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        killProcessGroupOwnedByStackImpl: async () => {
          killCalls += 1;
          return { killed: true };
        },
        pmSpawnScriptImpl: async () => {
          spawnCalls += 1;
          return { pid: 2000 + spawnCalls, exitCode: null };
        },
        listListenPidsImpl: async () => [2000 + spawnCalls],
        getProcessGroupIdImpl: async (pid) => Number(pid),
        recordStackRuntimeUpdateImpl: async () => undefined,
        waitForServerReadyImpl: async () => {
          readyCalls += 1;
          if (readyCalls === 1) {
            await capturedOnChange({ eventType: 'change', filename: 'second-change.ts' });
          }
        },
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        consoleImpl: { log() {}, error() {} },
      },
    );

    try {
      assert.equal(typeof capturedOnChange, 'function');
      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.equal(killCalls, 2);
      assert.equal(spawnCalls, 2);
      assert.equal(readyCalls, 2);
      assert.equal(serverProcRef.current.pid, 2002);
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart keeps the existing server when preflight rebuild fails', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    let killCalls = 0;
    let spawnCalls = 0;
    let readyCalls = 0;
    const errors = [];
    const children = [];
    const serverProcRef = { current: { pid: 1234, exitCode: null } };

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { children, serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        preflightDevServerRestartImpl: async () => {
          throw new Error('server build failed');
        },
        killProcessGroupOwnedByStackImpl: async () => {
          killCalls += 1;
          return { killed: true };
        },
        pmSpawnScriptImpl: async () => {
          spawnCalls += 1;
          return { pid: 2000 + spawnCalls, exitCode: null };
        },
        recordStackRuntimeUpdateImpl: async () => undefined,
        waitForServerReadyImpl: async () => {
          readyCalls += 1;
        },
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        consoleImpl: {
          log() {},
          error(message) {
            errors.push(String(message));
          },
        },
      },
    );

    try {
      assert.equal(typeof capturedOnChange, 'function');
      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.equal(killCalls, 0);
      assert.equal(spawnCalls, 0);
      assert.equal(readyCalls, 0);
      assert.deepEqual(children, []);
      assert.equal(serverProcRef.current.pid, 1234);
      assert.ok(errors.some((message) => message.includes('server restart failed')));
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart validates workspace package exports before replacing the server', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    let workspaceBuildCalls = 0;
    let preflightCalls = 0;
    let killCalls = 0;
    let spawnCalls = 0;
    const errors = [];
    const children = [];
    const serverProcRef = { current: { pid: 1234, exitCode: null } };

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { children, serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        ensureSourceServerWorkspacePackagesBuiltImpl: async ({ serverDir: dir }) => {
          workspaceBuildCalls += 1;
          assert.equal(dir, serverDir);
          throw new Error('protocol dist is temporarily incomplete');
        },
        preflightDevServerRestartImpl: async () => {
          preflightCalls += 1;
        },
        killProcessGroupOwnedByStackImpl: async () => {
          killCalls += 1;
          return { killed: true };
        },
        pmSpawnScriptImpl: async () => {
          spawnCalls += 1;
          return { pid: 2001, exitCode: null };
        },
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        consoleImpl: {
          log() {},
          error(message) {
            errors.push(String(message));
          },
        },
      },
    );

    try {
      assert.equal(typeof capturedOnChange, 'function');
      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.equal(workspaceBuildCalls, 1);
      assert.equal(preflightCalls, 0, 'server build must not run until shared dist exports are valid');
      assert.equal(killCalls, 0, 'existing server must not be killed when shared dist exports are invalid');
      assert.equal(spawnCalls, 0, 'replacement server must not spawn when shared dist exports are invalid');
      assert.deepEqual(children, []);
      assert.equal(serverProcRef.current.pid, 1234);
      assert.ok(errors.some((message) => message.includes('server restart failed')));
    } finally {
      watcher?.close?.();
    }
  });
});

test('startDevServer validates workspace package exports before spawning a server process', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    const child = { pid: 2001, exitCode: null, kill() {} };

    const result = await startDevServer(
      {
        serverComponentName: 'happier-server-custom',
        serverDir,
        autostart: { stackName: 'start-test', baseDir: serverDir },
        baseEnv: {},
        serverPort: 34567,
        internalServerUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'http://localhost:34567',
        envPath: join(serverDir, 'env'),
        stackMode: true,
        runtimeStatePath: join(serverDir, 'stack.runtime.json'),
        serverAlreadyRunning: false,
        restart: false,
        children: [],
        quiet: true,
      },
      {
        ensureDepsInstalledImpl: async () => {
          calls.push('deps');
        },
        ensureSourceServerWorkspacePackagesBuiltImpl: async ({ serverDir: dir }) => {
          calls.push('workspace');
          assert.equal(dir, serverDir);
        },
        pmSpawnScriptImpl: async () => {
          calls.push('spawn');
          return child;
        },
        waitForServerReadyImpl: async () => {
          calls.push('ready');
        },
        assertServerPortOwnedBySpawnedProcessGroupImpl: async () => {
          calls.push('ownership');
        },
        recordStackRuntimeUpdateImpl: async () => {
          calls.push('record');
        },
      },
    );

    assert.equal(result.serverProc, child);
    assert.deepEqual(calls, ['deps', 'workspace', 'spawn', 'ready', 'ownership', 'record']);
  });
});

test('startDevServer records the listener pid separately from the server wrapper pid', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const child = { pid: 2001, exitCode: null, kill() {} };
    const updates = [];

    await startDevServer(
      {
        serverComponentName: 'happier-server-custom',
        serverDir,
        autostart: { stackName: 'start-test', baseDir: serverDir },
        baseEnv: {},
        serverPort: 34567,
        internalServerUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'http://localhost:34567',
        envPath: join(serverDir, 'env'),
        stackMode: true,
        runtimeStatePath: join(serverDir, 'stack.runtime.json'),
        serverAlreadyRunning: false,
        restart: false,
        children: [],
        quiet: true,
      },
      {
        ensureDepsInstalledImpl: async () => {},
        ensureSourceServerWorkspacePackagesBuiltImpl: async () => {},
        pmSpawnScriptImpl: async () => child,
        waitForServerReadyImpl: async () => {},
        assertServerPortOwnedBySpawnedProcessGroupImpl: async () => 3001,
        recordStackRuntimeUpdateImpl: async (_statePath, patch) => {
          updates.push(patch);
        },
      },
    );

    assert.deepEqual(updates, [
      {
        processes: {
          serverPid: 3001,
          serverWrapperPid: 2001,
          proxyPid: null,
          serverBackendPid: null,
          serverDrainingPid: null,
        },
        ports: {
          server: 34567,
          serverBackend: null,
        },
        serverProxy: {
          enabled: false,
          mode: 'direct',
          restartMode: null,
          fallbackReason: null,
        },
      },
    ]);
  });
});

test('watchDevServerAndRestart backs off server startup failures instead of consuming pending changes forever', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    let nowMs = 1_000;
    let spawnCalls = 0;
    let readyCalls = 0;
    const errors = [];
    const serverProcRef = { current: { pid: 1234, exitCode: null } };

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
        waitForTcpPortFreeImpl: async () => true,
        pmSpawnScriptImpl: async () => {
          spawnCalls += 1;
          return { pid: 2000 + spawnCalls, exitCode: 1 };
        },
        listListenPidsImpl: async () => [spawnCalls === 0 ? 1234 : 2000 + spawnCalls],
        getProcessGroupIdImpl: async (pid) => Number(pid),
        recordStackRuntimeUpdateImpl: async () => undefined,
        waitForServerReadyImpl: async () => {
          readyCalls += 1;
          if (readyCalls === 1) {
            await capturedOnChange({ eventType: 'change', filename: `pending-${readyCalls}.ts` });
          }
          throw new Error('replacement never became ready');
        },
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        nowImpl: () => nowMs,
        restartFailurePolicy: { maxFailures: 1, windowMs: 60_000, backoffMs: 30_000 },
        consoleImpl: {
          log() {},
          error(message) {
            errors.push(String(message));
          },
        },
      },
    );

    try {
      assert.equal(typeof capturedOnChange, 'function');
      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.equal(spawnCalls, 1, 'pending restart must stop after the backoff threshold');
      assert.equal(readyCalls, 1);
      assert.ok(errors.some((message) => message.includes('server failed to start 1 times')));
      assert.ok(errors.some((message) => message.includes('backing off for 30000ms')));

      nowMs += 1_000;
      await capturedOnChange({ eventType: 'change', filename: 'during-backoff.ts' });
      assert.equal(spawnCalls, 1, 'changes during backoff must not spawn another replacement');
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart includes the recent child output excerpt on replacement failure', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    const errors = [];
    const serverProcRef = { current: { pid: 1234, exitCode: null } };

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
        waitForTcpPortFreeImpl: async () => true,
        pmSpawnScriptImpl: async ({ options }) => {
          assert.equal(typeof options?.onLine, 'function', 'spawn should receive an onLine hook for recent output');
          for (let i = 1; i <= 14; i += 1) {
            options.onLine({ stream: 'stderr', line: `server-line-${i}` });
          }
          return { pid: 2001, exitCode: 1 };
        },
        listListenPidsImpl: async () => [2001],
        getProcessGroupIdImpl: async (pid) => Number(pid),
        recordStackRuntimeUpdateImpl: async () => undefined,
        waitForServerReadyImpl: async () => {
          throw new Error('replacement failed readiness');
        },
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        restartFailurePolicy: { maxFailures: 1, windowMs: 60_000, backoffMs: 30_000, recentLineLimit: 8 },
        consoleImpl: {
          log() {},
          error(message) {
            errors.push(String(message));
          },
        },
      },
    );

    try {
      assert.equal(typeof capturedOnChange, 'function');
      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      const errorOutput = errors.join('\n');
      assert.ok(errorOutput.includes('recent server output'));
      assert.ok(errorOutput.includes('[stderr] server-line-7'));
      assert.ok(errorOutput.includes('[stderr] server-line-14'));
      assert.ok(!errorOutput.includes('server-line-6'));
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart waits for the old server port to be released before spawning', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    let spawnCalls = 0;
    let waitForPortFreeCalls = 0;
    const serverProcRef = { current: { pid: 1234, exitCode: null } };

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
        waitForTcpPortFreeImpl: async () => {
          waitForPortFreeCalls += 1;
          return true;
        },
        pmSpawnScriptImpl: async () => {
          assert.equal(waitForPortFreeCalls, 1, 'must wait for the old listener to release before spawning');
          spawnCalls += 1;
          return { pid: 2001, exitCode: null };
        },
        listListenPidsImpl: async () => [2001],
        getProcessGroupIdImpl: async () => 2001,
        recordStackRuntimeUpdateImpl: async () => undefined,
        waitForServerReadyImpl: async () => undefined,
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        consoleImpl: { log() {}, error() {} },
      },
    );

    try {
      assert.equal(typeof capturedOnChange, 'function');
      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.equal(waitForPortFreeCalls, 1);
      assert.equal(spawnCalls, 1);
      assert.equal(serverProcRef.current.pid, 2001);
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart marks direct-mode old server exits as planned dev reloads', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    const oldServer = { pid: 1234, exitCode: null };
    const serverProcRef = { current: oldServer };

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        killProcessGroupOwnedByStackImpl: async () => {
          assert.equal(getSpawnedProcessPlannedExitReason(oldServer), 'dev-reload');
          return { killed: true };
        },
        waitForTcpPortFreeImpl: async () => true,
        pmSpawnScriptImpl: async () => ({ pid: 2001, exitCode: null }),
        listListenPidsImpl: async () => [2001],
        getProcessGroupIdImpl: async () => 2001,
        recordStackRuntimeUpdateImpl: async () => undefined,
        waitForServerReadyImpl: async () => undefined,
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        consoleImpl: { log() {}, error() {} },
      },
    );

    try {
      assert.equal(typeof capturedOnChange, 'function');
      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.equal(getSpawnedProcessPlannedExitReason(oldServer), 'dev-reload');
      assert.equal(serverProcRef.current.pid, 2001);
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart waits for the pglite dir lock after port release before spawning', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    const order = [];
    const serverProcRef = { current: { pid: 1234, exitCode: null } };
    const dbDir = join(serverDir, 'server-light', 'pglite');

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, {
        serverProcRef,
        serverEnv: {
          HAPPIER_DB_PROVIDER: 'pglite',
          HAPPY_DB_PROVIDER: 'pglite',
          HAPPIER_SERVER_LIGHT_DB_DIR: dbDir,
        },
      }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        killProcessGroupOwnedByStackImpl: async () => {
          order.push('kill');
          return { killed: true };
        },
        waitForTcpPortFreeImpl: async () => {
          order.push('port-free');
          return true;
        },
        waitForPgliteDirLockReleaseImpl: async (actualDbDir) => {
          order.push(`pglite-lock:${actualDbDir}`);
          return true;
        },
        pmSpawnScriptImpl: async () => {
          order.push('spawn');
          return { pid: 2001, exitCode: null };
        },
        listListenPidsImpl: async () => [2001],
        getProcessGroupIdImpl: async () => 2001,
        recordStackRuntimeUpdateImpl: async () => undefined,
        waitForServerReadyImpl: async () => {
          order.push('ready');
        },
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        consoleImpl: { log() {}, error() {} },
      },
    );

    try {
      assert.equal(typeof capturedOnChange, 'function');
      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.deepEqual(order, ['kill', 'port-free', `pglite-lock:${dbDir}`, 'spawn', 'ready']);
      assert.equal(serverProcRef.current.pid, 2001);
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart does not wait for a pglite dir lock for sqlite', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    let lockWaitCalls = 0;
    const serverProcRef = { current: { pid: 1234, exitCode: null } };

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, {
        serverProcRef,
        serverEnv: {
          HAPPIER_DB_PROVIDER: 'sqlite',
          HAPPY_DB_PROVIDER: 'sqlite',
          HAPPIER_SERVER_LIGHT_DB_DIR: join(serverDir, 'server-light', 'pglite'),
        },
      }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
        waitForTcpPortFreeImpl: async () => true,
        waitForPgliteDirLockReleaseImpl: async () => {
          lockWaitCalls += 1;
          return true;
        },
        pmSpawnScriptImpl: async () => ({ pid: 2001, exitCode: null }),
        listListenPidsImpl: async () => [2001],
        getProcessGroupIdImpl: async () => 2001,
        recordStackRuntimeUpdateImpl: async () => undefined,
        waitForServerReadyImpl: async () => undefined,
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        consoleImpl: { log() {}, error() {} },
      },
    );

    try {
      assert.equal(typeof capturedOnChange, 'function');
      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.equal(lockWaitCalls, 0);
      assert.equal(serverProcRef.current.pid, 2001);
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart rejects readiness from a listener outside the spawned process group', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    let spawnCalls = 0;
    let recordCalls = 0;
    const errors = [];
    const children = [];
    const serverProcRef = { current: { pid: 1234, exitCode: null } };

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { children, serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
        waitForTcpPortFreeImpl: async () => true,
        pmSpawnScriptImpl: async () => {
          spawnCalls += 1;
          return { pid: 2001, exitCode: null };
        },
        listListenPidsImpl: async () => [9999],
        getProcessGroupIdImpl: async (pid) => (Number(pid) === 2001 ? 2001 : 9999),
        recordStackRuntimeUpdateImpl: async () => {
          recordCalls += 1;
        },
        waitForServerReadyImpl: async () => undefined,
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        consoleImpl: {
          log() {},
          error(message) {
            errors.push(String(message));
          },
        },
      },
    );

    try {
      assert.equal(typeof capturedOnChange, 'function');
      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.equal(spawnCalls, 1);
      assert.equal(recordCalls, 0, 'must not record a PID when another process owns readiness');
      assert.equal(serverProcRef.current, null, 'the stopped server must not remain marked as current after replacement failure');
      assert.equal(errors.some((message) => message.includes('keeping existing process as-is')), false);
      assert.equal(errors.some((message) => message.includes('no server is running')), true);
      assert.ok(errors.some((message) => message.includes('server restart failed')));
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart fails closed and cleans a replacement when spawned PGID proof is missing', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    let recordCalls = 0;
    let replacementKilled = false;
    const errors = [];
    const replacement = {
      pid: 2001,
      exitCode: null,
      kill() {
        replacementKilled = true;
      },
    };
    const children = [];
    const serverProcRef = { current: { pid: 1234, exitCode: null } };

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { children, serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        stopStackOwnedServerForRestartImpl: async () => ({ stopped: true, pid: 1234 }),
        killProcessGroupOwnedByStackImpl: async () => ({ killed: false, reason: 'not_owned' }),
        pmSpawnScriptImpl: async () => replacement,
        listListenPidsImpl: async () => [2001],
        getProcessGroupIdImpl: async () => null,
        recordStackRuntimeUpdateImpl: async () => {
          recordCalls += 1;
        },
        waitForServerReadyImpl: async () => undefined,
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        consoleImpl: {
          log() {},
          error(message) {
            errors.push(String(message));
          },
        },
      },
    );

    try {
      assert.equal(typeof capturedOnChange, 'function');
      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.equal(recordCalls, 0, 'must not record a PID without spawned process-group proof');
      assert.equal(serverProcRef.current, null, 'the stopped server must not remain marked as current after replacement failure');
      assert.deepEqual(children, [], 'failed provisional replacement must be removed from tracked children');
      assert.equal(replacementKilled, true, 'failed provisional replacement must be terminated');
      assert.equal(errors.some((message) => message.includes('keeping existing process as-is')), false);
      assert.equal(errors.some((message) => message.includes('no server is running')), true);
      assert.ok(errors.some((message) => message.includes('server restart failed')));
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart fails closed and cleans a replacement when listener discovery is unavailable', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    let replacementKilled = false;
    const errors = [];
    const replacement = {
      pid: 2001,
      exitCode: null,
      kill() {
        replacementKilled = true;
      },
    };
    const children = [];
    const serverProcRef = { current: { pid: 1234, exitCode: null } };

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { children, serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        stopStackOwnedServerForRestartImpl: async () => ({ stopped: true, pid: 1234 }),
        killProcessGroupOwnedByStackImpl: async () => ({ killed: false, reason: 'not_owned' }),
        pmSpawnScriptImpl: async () => replacement,
        listListenPidsImpl: async () => {
          throw new Error('lsof unavailable');
        },
        getProcessGroupIdImpl: async () => 2001,
        recordStackRuntimeUpdateImpl: async () => undefined,
        waitForServerReadyImpl: async () => undefined,
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        consoleImpl: {
          log() {},
          error(message) {
            errors.push(String(message));
          },
        },
      },
    );

    try {
      assert.equal(typeof capturedOnChange, 'function');
      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.equal(serverProcRef.current, null, 'the stopped server must not remain marked as current after replacement failure');
      assert.deepEqual(children, []);
      assert.equal(replacementKilled, true);
      assert.equal(errors.some((message) => message.includes('keeping existing process as-is')), false);
      assert.equal(errors.some((message) => message.includes('no server is running')), true);
      assert.ok(errors.some((message) => message.includes('server restart failed')));
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart refuses to spawn when existing server is not stack-owned and port is occupied', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    let killCalls = 0;
    let spawnCalls = 0;
    let readyCalls = 0;
    const errors = [];
    const children = [];
    const serverProcRef = { current: { pid: 1234, exitCode: null } };

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { children, serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        killProcessGroupOwnedByStackImpl: async () => {
          killCalls += 1;
          return { killed: false, reason: 'not_owned' };
        },
        isTcpPortFreeImpl: async () => false,
        pmSpawnScriptImpl: async () => {
          spawnCalls += 1;
          return { pid: 2000 + spawnCalls, exitCode: null };
        },
        recordStackRuntimeUpdateImpl: async () => undefined,
        waitForServerReadyImpl: async () => {
          readyCalls += 1;
        },
        readWatchChangeSignatureImpl: createChangingSignatureReader(),
        consoleImpl: {
          log() {},
          error(message) {
            errors.push(String(message));
          },
        },
      },
    );

    try {
      assert.equal(typeof capturedOnChange, 'function');
      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.equal(killCalls, 1);
      assert.equal(spawnCalls, 0);
      assert.equal(readyCalls, 0);
      assert.deepEqual(children, []);
      assert.equal(serverProcRef.current.pid, 1234);
      assert.ok(errors.some((message) => message.includes('server restart failed')));
    } finally {
      watcher?.close?.();
    }
  });
});

test('resolveStackOwnedServerListenPid returns a stack-owned listener for stale runtime repair', async () => {
  const pid = await resolveStackOwnedServerListenPid(
    { serverPort: 34567, stackName: 'watch-test', envPath: '/tmp/watch-test/env' },
    {
      listListenPidsImpl: async () => [1111, 2222],
      isPidOwnedByStackImpl: async (candidate) => Number(candidate) === 2222,
    },
  );

  assert.equal(pid, 2222);
});

test('resolveStackOwnedServerRuntimePid requires alive runtime PID ownership and listener evidence', async () => {
  const pid = await resolveStackOwnedServerRuntimePid(
    { runtimeServerPid: 1234, serverPort: 34567, stackName: 'watch-test', envPath: '/tmp/watch-test/env' },
    {
      isPidAliveImpl: () => true,
      isPidOwnedByStackImpl: async () => false,
      resolveStackOwnedServerListenPidImpl: async () => null,
    },
  );

  assert.equal(pid, null);
});

test('resolveStackOwnedServerRuntimePid repairs stale runtime PID from stack-owned listener evidence', async () => {
  const pid = await resolveStackOwnedServerRuntimePid(
    { runtimeServerPid: 1234, serverPort: 34567, stackName: 'watch-test', envPath: '/tmp/watch-test/env' },
    {
      isPidAliveImpl: () => false,
      isPidOwnedByStackImpl: async () => false,
      resolveStackOwnedServerListenPidImpl: async () => 2222,
    },
  );

  assert.equal(pid, 2222);
});

test('stopStackOwnedServerForRestart repairs stale stack-owned listeners before waiting for port release', async () => {
  const killed = [];
  const waited = [];

  const result = await stopStackOwnedServerForRestart(
    { pid: 1234, serverPort: 34567, stackName: 'watch-test', envPath: '/tmp/watch-test/env', label: 'server' },
    {
      killProcessGroupOwnedByStackImpl: async (pid) => {
        killed.push(pid);
        return { killed: pid === 2222, reason: pid === 2222 ? 'killed_pgid' : 'not_owned' };
      },
      isTcpPortFreeImpl: async () => false,
      resolveStackOwnedServerListenPidImpl: async () => 2222,
      waitForTcpPortFreeImpl: async (port) => {
        waited.push(port);
        return true;
      },
    },
  );

  assert.equal(result.stopped, true);
  assert.deepEqual(killed, [1234, 2222]);
  assert.deepEqual(waited, [34567]);
});

test('watchDevServerAndRestart watches source/config paths instead of the whole server directory', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    await mkdir(join(serverDir, 'sources'), { recursive: true });
    let capturedPaths = null;

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir),
      {
        watchDebouncedImpl: ({ paths }) => {
          capturedPaths = paths;
          return { close() {} };
        },
        consoleImpl: { log() {}, error() {} },
      },
    );

    try {
      assert.ok(watcher);
      assert.ok(Array.isArray(capturedPaths));
      assert.ok(!capturedPaths.includes(serverDir), 'must not watch the whole server directory');
      assert.ok(capturedPaths.every((p) => !p.includes('/dist') && !p.includes('/node_modules') && !p.includes('/logs')));
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart forwards signature polling to watchDebounced so missed server fs events still reload', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    await mkdir(join(serverDir, 'sources'), { recursive: true });
    let capturedWatchOptions = null;
    let signatureReads = 0;

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, {
        serverEnv: { HAPPIER_STACK_DEV_RELOAD_POLL_MS: '19' },
      }),
      {
        watchDebouncedImpl: (options) => {
          capturedWatchOptions = options;
          return { close() {} };
        },
        readWatchChangeSignatureImpl: () => `signature-${++signatureReads}`,
        consoleImpl: { log() {}, error() {} },
      },
    );

    try {
      assert.ok(watcher);
      assert.equal(capturedWatchOptions?.pollIntervalMs, 19);
      assert.equal(typeof capturedWatchOptions?.readSignature, 'function');
      assert.equal(capturedWatchOptions.readSignature(), 'signature-2');
    } finally {
      watcher?.close?.();
    }
  });
});
