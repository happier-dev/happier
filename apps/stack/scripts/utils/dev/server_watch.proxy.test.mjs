import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDevServerReloadExecutor, selectDevServerRestartMode } from './server.mjs';
import { getSpawnedProcessPlannedExitReason } from '../proc/proc.mjs';

async function withTempServerDir(t, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-dev-server-proxy-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return await fn(dir);
}

function executorOptions(serverDir, overrides = {}) {
  return {
    enabled: true,
    stackMode: true,
    serverComponentName: 'happier-server-light',
    serverDir,
    serverPort: 4101,
    serverBindPort: 5101,
    internalServerUrl: 'http://127.0.0.1:5101',
    serverScript: 'dev:light',
    serverEnv: { HAPPIER_DB_PROVIDER: 'sqlite', PORT: '5101' },
    runtimeStatePath: join(serverDir, 'stack.runtime.json'),
    stackName: 'proxy-test',
    envPath: join(serverDir, 'env'),
    children: [],
    serverProcRef: { current: { pid: 101, exitCode: null } },
    isShuttingDown: () => false,
    ...overrides,
  };
}

test('server restart mode fails closed to exclusiveDb unless all blue-green proofs are present', () => {
  assert.equal(selectDevServerRestartMode({ dbProvider: 'pglite', migrationsChanged: false }), 'exclusiveDb');
  assert.equal(selectDevServerRestartMode({ dbProvider: 'sqlite', migrationsChanged: true }), 'exclusiveDb');
  assert.equal(selectDevServerRestartMode({ dbProvider: 'sqlite', migrationsChanged: false }), 'exclusiveDb');
  assert.equal(
    selectDevServerRestartMode({
      dbProvider: 'sqlite',
      migrationsChanged: false,
      sqliteRuntimeMigrationsNoop: true,
      overlapSafeStartup: true,
    }),
    'blueGreen',
  );
});

test('proxy exclusiveDb restart enters maintenance, swaps backend, flips upstream, and records runtime', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    const updates = [];
    const oldServer = { pid: 101, exitCode: null };
    const proxy = {
      pid: process.pid,
      async enterMaintenance({ retryAfterMs }) {
        calls.push(['maintenance', retryAfterMs]);
        return { targetHost: '127.0.0.1', targetPort: 6101 };
      },
      flipUpstream({ targetPort }) {
        calls.push(['flip', targetPort]);
      },
      drainConnections(args) {
        calls.push(['drain', args]);
      },
    };

    const executor = createDevServerReloadExecutor(
      executorOptions(serverDir, {
        proxyController: proxy,
        serverProcRef: { current: oldServer },
      }),
      {
        ensureSourceServerWorkspacePackagesBuiltImpl: async () => {},
        preflightDevServerRestartImpl: async () => {},
        killProcessGroupOwnedByStackImpl: async (pid) => {
          if (Number(pid) === 101) {
            assert.equal(getSpawnedProcessPlannedExitReason(oldServer), 'dev-reload');
          }
          calls.push(['kill', pid]);
          return { killed: true };
        },
        waitForTcpPortFreeImpl: async (port) => {
          calls.push(['wait-free', port]);
          return true;
        },
        pickNextFreeTcpPortImpl: async () => 5102,
        pmSpawnScriptImpl: async ({ env }) => {
          calls.push(['spawn', Number(env.PORT)]);
          return { pid: 202, exitCode: null };
        },
        waitForServerReadyImpl: async (url) => {
          calls.push(['ready', url]);
        },
        listListenPidsImpl: async (port) => (Number(port) === 5101 ? [101] : [302]),
        getProcessGroupIdImpl: async (pid) => (
          Number(pid) === 101 ? 101 :
          Number(pid) === 202 || Number(pid) === 302 ? 202 :
          Number(pid)
        ),
        recordStackRuntimeUpdateImpl: async (_path, patch) => {
          updates.push(patch);
        },
        logger: { log() {}, error() {} },
      },
    );

    await executor.build();
    await executor.restart();

    assert.deepEqual(calls, [
      ['maintenance', 2000],
      ['kill', 101],
      ['wait-free', 5101],
      ['spawn', 5102],
      ['ready', 'http://127.0.0.1:5102'],
      ['flip', 5102],
      ['drain', { targetHost: '127.0.0.1', targetPort: 6101, graceMs: 2000 }],
      ['drain', { targetHost: '127.0.0.1', targetPort: 5101, graceMs: 2000 }],
    ]);
    assert.equal(getSpawnedProcessPlannedExitReason(oldServer), 'dev-reload');
    assert.deepEqual(updates, [
      {
        processes: {
          serverPid: 302,
          serverWrapperPid: 202,
          proxyPid: process.pid,
          serverBackendPid: 302,
          serverDrainingPid: null,
        },
        ports: {
          server: 4101,
          serverBackend: 5102,
        },
        serverProxy: {
          enabled: true,
          mode: 'proxy',
          restartMode: 'exclusiveDb',
          fallbackReason: null,
        },
      },
    ]);
  });
});

test('exclusiveDb proxy restart drains maintenance target after kill failure without closing active backend sockets', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    const proxy = {
      async enterMaintenance({ retryAfterMs }) {
        calls.push(['maintenance', retryAfterMs]);
        return { targetHost: '127.0.0.1', targetPort: 6101 };
      },
      flipUpstream({ targetPort }) {
        calls.push(['flip', targetPort]);
      },
      drainConnections(args) {
        calls.push(['drain', args]);
      },
    };

    const executor = createDevServerReloadExecutor(
      executorOptions(serverDir, { proxyController: proxy }),
      {
        ensureSourceServerWorkspacePackagesBuiltImpl: async () => {},
        preflightDevServerRestartImpl: async () => {},
        killProcessGroupOwnedByStackImpl: async (pid) => {
          calls.push(['kill', pid]);
          return { killed: false };
        },
        listListenPidsImpl: async () => [101],
        getProcessGroupIdImpl: async (pid) => Number(pid),
        logger: { log() {}, error() {} },
      },
    );

    await assert.rejects(() => executor.restart(), /could not be stopped safely/);
    assert.deepEqual(calls, [
      ['maintenance', 2000],
      ['kill', 101],
      ['flip', 5101],
      ['drain', { targetHost: '127.0.0.1', targetPort: 6101, graceMs: 2000 }],
    ]);
  });
});

test('exclusiveDb proxy restart rolls back to old backend and drains attempted replacement on readiness failure', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    const proxy = {
      async enterMaintenance({ retryAfterMs }) {
        calls.push(['maintenance', retryAfterMs]);
        return { targetHost: '127.0.0.1', targetPort: 6101 };
      },
      flipUpstream({ targetPort }) {
        calls.push(['flip', targetPort]);
      },
      drainConnections(args) {
        calls.push(['drain', args]);
      },
    };

    const executor = createDevServerReloadExecutor(
      executorOptions(serverDir, { proxyController: proxy }),
      {
        ensureSourceServerWorkspacePackagesBuiltImpl: async () => {},
        preflightDevServerRestartImpl: async () => {},
        killProcessGroupOwnedByStackImpl: async (pid) => {
          calls.push(['kill', pid]);
          return { killed: true };
        },
        waitForTcpPortFreeImpl: async (port) => {
          calls.push(['wait-free', port]);
          return true;
        },
        pickNextFreeTcpPortImpl: async () => 5102,
        pmSpawnScriptImpl: async ({ env }) => {
          calls.push(['spawn', Number(env.PORT)]);
          return { pid: 202, exitCode: null };
        },
        waitForServerReadyImpl: async (url) => {
          calls.push(['ready', url]);
          throw new Error('replacement not ready');
        },
        listListenPidsImpl: async (port) => (Number(port) === 5101 ? [101] : []),
        getProcessGroupIdImpl: async (pid) => Number(pid),
        logger: { log() {}, error() {} },
      },
    );

    await assert.rejects(() => executor.restart(), /replacement not ready/);
    assert.deepEqual(calls, [
      ['maintenance', 2000],
      ['kill', 101],
      ['wait-free', 5101],
      ['spawn', 5102],
      ['ready', 'http://127.0.0.1:5102'],
      ['kill', 202],
      ['flip', 5101],
      ['drain', { targetHost: '127.0.0.1', targetPort: 6101, graceMs: 2000 }],
      ['drain', { targetHost: '127.0.0.1', targetPort: 5102, graceMs: 2000 }],
    ]);
  });
});

test('exclusiveDb proxy restart keeps old backend serving when ownership proof fails before maintenance', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    const proxy = {
      enterMaintenance() {
        calls.push('maintenance');
      },
      flipUpstream() {
        calls.push('flip');
      },
    };
    const executor = createDevServerReloadExecutor(
      executorOptions(serverDir, { proxyController: proxy }),
      {
        ensureSourceServerWorkspacePackagesBuiltImpl: async () => {},
        preflightDevServerRestartImpl: async () => {},
        listListenPidsImpl: async () => [],
        getProcessGroupIdImpl: async (pid) => Number(pid),
        isTcpPortFreeImpl: async () => false,
        isPidAliveImpl: () => true,
        logger: { log() {}, error() {} },
      },
    );

    await assert.rejects(() => executor.restart(), /not provably stack-owned/);
    assert.deepEqual(calls, []);
  });
});

test('blue-green proxy restart drains only the old backend target after flip', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    const updates = [];
    const proxy = {
      pid: process.pid,
      flipUpstream({ targetPort }) {
        calls.push(['flip', targetPort]);
      },
      drainConnections(args) {
        calls.push(['drain', args]);
      },
    };

    const executor = createDevServerReloadExecutor(
      executorOptions(serverDir, {
        proxyController: proxy,
        serverRestartModeContext: {
          migrationsChanged: false,
          sqliteRuntimeMigrationsNoop: true,
          overlapSafeStartup: true,
        },
      }),
      {
        ensureSourceServerWorkspacePackagesBuiltImpl: async () => {},
        preflightDevServerRestartImpl: async () => {},
        pickNextFreeTcpPortImpl: async () => 5102,
        pmSpawnScriptImpl: async ({ env }) => {
          calls.push(['spawn', Number(env.PORT)]);
          return { pid: 202, exitCode: null };
        },
        waitForServerReadyImpl: async (url) => {
          calls.push(['ready', url]);
        },
        listListenPidsImpl: async (port) => (Number(port) === 5102 ? [302] : [101]),
        getProcessGroupIdImpl: async (pid) => (
          Number(pid) === 202 || Number(pid) === 302 ? 202 : Number(pid)
        ),
        killProcessGroupOwnedByStackImpl: async (pid) => {
          calls.push(['kill', pid]);
          return { killed: true };
        },
        recordStackRuntimeUpdateImpl: async (_path, patch) => {
          updates.push(patch);
        },
        sleepImpl: async (ms) => {
          calls.push(['sleep', ms]);
        },
        logger: { log() {}, error() {} },
      },
    );

    await executor.build();
    await executor.restart();

    assert.deepEqual(calls, [
      ['spawn', 5102],
      ['ready', 'http://127.0.0.1:5102'],
      ['flip', 5102],
      ['drain', { targetHost: '127.0.0.1', targetPort: 5101, graceMs: 2000 }],
      ['kill', 101],
    ]);
    assert.deepEqual(updates, [
      {
        processes: {
          serverPid: 302,
          serverWrapperPid: 202,
          proxyPid: process.pid,
          serverBackendPid: 302,
          serverDrainingPid: 101,
        },
        ports: {
          server: 4101,
          serverBackend: 5102,
        },
        serverProxy: {
          enabled: true,
          mode: 'proxy',
          restartMode: 'blueGreen',
          fallbackReason: null,
        },
      },
      {
        processes: {
          serverPid: 302,
          serverWrapperPid: 202,
          proxyPid: process.pid,
          serverBackendPid: 302,
          serverDrainingPid: null,
        },
        ports: {
          server: 4101,
          serverBackend: 5102,
        },
        serverProxy: {
          enabled: true,
          mode: 'proxy',
          restartMode: 'blueGreen',
          fallbackReason: null,
        },
      },
    ]);
  });
});
