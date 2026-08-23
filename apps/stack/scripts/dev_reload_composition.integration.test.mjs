import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startDevReloadComposition } from './utils/dev/devReloadComposition.mjs';
import {
  createDevServerReloadExecutor,
  startDevServer,
} from './utils/dev/server.mjs';
import { startDevReloadCoordinator } from './utils/dev/devReloadCoordinator.mjs';
import { recordStackRuntimeStart } from './utils/stack/runtime_state.mjs';

async function createServerFixture(t) {
  const rootDir = await mkdtemp(join(tmpdir(), 'hstack-dev-reload-composition-'));
  const serverDir = join(rootDir, 'apps', 'server');
  const sourceDir = join(serverDir, 'sources');
  const prismaDir = join(serverDir, 'prisma');
  const dataDir = join(rootDir, 'stack', 'server-light');
  const runtimeStatePath = join(rootDir, 'stack.runtime.json');
  await mkdir(sourceDir, { recursive: true });
  await mkdir(prismaDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(sourceDir, 'start.mjs'), 'export const generation = 0;\n');
  await writeFile(join(prismaDir, 'schema.prisma'), 'generator client {}\n');
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({ scripts: { 'dev:light': 'ignored' } }));
  await writeFile(join(serverDir, 'tsconfig.json'), '{}\n');
  await writeFile(join(serverDir, 'tsconfig.runtime.json'), '{}\n');
  t.after(async () => rm(rootDir, { recursive: true, force: true }));
  return { rootDir, serverDir, sourceDir, prismaDir, dataDir, runtimeStatePath };
}

test('production reload composition keeps app and Prisma reloads exclusive while selecting migrations independently', async (t) => {
  const fixture = await createServerFixture(t);
  const children = [];
  const calls = [];
  const spawnedChildren = new Map();
  let nextPid = 101;
  let nextBackendPort = 5102;
  let onChange = null;
  let readPollSignature = null;
  let replacementReadinessCount = 0;
  let markSecondReplacementReady;
  let releaseSecondReplacement;
  const secondReplacementReady = new Promise((resolve) => {
    markSecondReplacementReady = resolve;
  });
  const secondReplacementRelease = new Promise((resolve) => {
    releaseSecondReplacement = resolve;
  });

  const processGroupForPid = (pid) => {
    const value = Number(pid);
    if (value === 101 || value === 301) return 41;
    if (value === 102 || value === 302) return 42;
    if (value === 103 || value === 303) return 43;
    if (value === 104 || value === 304) return 44;
    return value;
  };
  const listenerPidForPort = (port) => {
    const value = Number(port);
    if (value === 5101) return 301;
    if (value === 5102) return 302;
    if (value === 5103) return 303;
    if (value === 5104) return 304;
    return null;
  };
  const spawnServer = async ({ env }) => {
    const pid = nextPid++;
    const child = { pid, exitCode: null, signalCode: null };
    spawnedChildren.set(pid, child);
    calls.push(['spawn', pid, Number(env.PORT), env.HAPPIER_STACK_MIGRATE_MODE ?? null]);
    return child;
  };
  const proxyController = {
    pid: 91,
    available: true,
    port: 4101,
    targetPort: 5101,
    async enterMaintenance() {
      calls.push(['maintenance', this.targetPort]);
      return { targetHost: '127.0.0.1', targetPort: this.targetPort };
    },
    async flipUpstream({ targetPort }) {
      calls.push(['flip', targetPort]);
      this.targetPort = targetPort;
      return { targetHost: '127.0.0.1', targetPort };
    },
    async drainUpstream({ targetPort, graceMs }) {
      calls.push(['drain', targetPort, graceMs]);
      return { targetHost: '127.0.0.1', targetPort, remainingConnections: 0 };
    },
  };

  const initial = await startDevServer({
    serverComponentName: 'happier-server-light',
    serverDir: fixture.serverDir,
    autostart: { stackName: 'test-stack', baseDir: join(fixture.rootDir, 'stack') },
    baseEnv: {
      HAPPIER_SERVER_LIGHT_DATA_DIR: fixture.dataDir,
      HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: '1200ms',
      HAPPIER_STACK_DEV_PROXY_DRAIN_MS: '0',
    },
    serverPort: 4101,
    serverBindPort: 5101,
    internalServerUrl: 'http://127.0.0.1:4101',
    publicServerUrl: 'http://127.0.0.1:4101',
    envPath: join(fixture.rootDir, 'stack.env'),
    stackMode: true,
    runtimeStatePath: fixture.runtimeStatePath,
    serverAlreadyRunning: false,
    restart: false,
    children,
    serverProxyRuntime: { mode: 'proxy', proxyPid: proxyController.pid },
  }, {
    ensureDepsInstalledImpl: async () => {},
    pmSpawnScriptImpl: spawnServer,
    waitForServerReadyImpl: async () => {},
    listListenPidsImpl: async (port) => {
      const pid = listenerPidForPort(port);
      return pid ? [pid] : [];
    },
    getProcessGroupIdImpl: async (pid) => processGroupForPid(pid),
  });

  assert.equal(initial.serverEnv.HAPPIER_DB_PROVIDER, 'sqlite');
  const serverProcRef = { current: initial.serverProc };
  const composition = startDevReloadComposition({
    watchEnabled: true,
    daemonReloadEnabled: false,
    serverReloadEnabled: true,
    serverOptions: {
      enabled: true,
      stackMode: true,
      serverComponentName: 'happier-server-light',
      serverDir: fixture.serverDir,
      serverPort: 4101,
      serverBindPort: 5101,
      internalServerUrl: 'http://127.0.0.1:4101',
      serverScript: initial.serverScript,
      serverEnv: initial.serverEnv,
      runtimeStatePath: fixture.runtimeStatePath,
      stackName: 'test-stack',
      envPath: join(fixture.rootDir, 'stack.env'),
      children,
      serverProcRef,
      isShuttingDown: () => false,
      proxyController,
    },
    debounceMs: 0,
    pollIntervalMs: 0,
    isShuttingDown: () => false,
    logger: { log() {}, warn() {}, error() {} },
  }, {
    createDevServerReloadExecutorImpl: (options) => createDevServerReloadExecutor(options, {
      preflightDevServerRestartImpl: async () => {},
      waitForServerReadyImpl: async () => {
        replacementReadinessCount += 1;
        if (replacementReadinessCount === 2) {
          markSecondReplacementReady();
          await secondReplacementRelease;
        }
      },
      pickNextFreeTcpPortImpl: async () => nextBackendPort++,
      waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
      pmSpawnScriptImpl: spawnServer,
      listListenPidsImpl: async (port) => {
        const pid = listenerPidForPort(port);
        return pid ? [pid] : [];
      },
      getProcessGroupIdImpl: async (pid) => processGroupForPid(pid),
      isPidAliveImpl: (pid) => spawnedChildren.get(Number(pid))?.exitCode == null,
      killProcessGroupOwnedByStackImpl: async (pid, options) => {
        calls.push(['kill', Number(pid), options?.graceMs ?? null]);
        const child = spawnedChildren.get(Number(pid));
        if (child) child.exitCode = 0;
        return { killed: true };
      },
      logger: { log() {}, warn() {}, error() {} },
    }),
    startDevReloadCoordinatorImpl: (options) => startDevReloadCoordinator(options, {
      watchDebouncedImpl: ({ onChange: handler, readSignature }) => {
        onChange = handler;
        readPollSignature = readSignature;
        return { close() {} };
      },
    }),
  });
  t.after(() => composition?.close?.());

  await readPollSignature();
  await writeFile(join(fixture.sourceDir, 'start.mjs'), 'export const generation = 1;\n');
  await onChange();
  await writeFile(join(fixture.sourceDir, 'start.mjs'), 'export const generation = 2;\n');
  const inFlightAppReload = onChange();
  await secondReplacementReady;
  await writeFile(join(fixture.prismaDir, 'schema.prisma'), 'generator client { output = "next" }\n');
  await onChange();
  releaseSecondReplacement();
  await inFlightAppReload;

  const runtime = JSON.parse(await readFile(fixture.runtimeStatePath, 'utf8'));
  assert.deepEqual(calls.filter(([kind]) => kind === 'spawn'), [
    ['spawn', 101, 5101, null],
    ['spawn', 102, 5102, 'skip'],
    ['spawn', 103, 5103, 'skip'],
    ['spawn', 104, 5104, 'always'],
  ]);
  assert.deepEqual(calls.filter(([kind]) => kind === 'kill'), [
    ['kill', 301, 1450],
    ['kill', 302, 1450],
    ['kill', 303, 1450],
  ]);
  assert.ok(
    calls.findIndex(([kind]) => kind === 'maintenance')
      < calls.findIndex(([kind, pid]) => kind === 'kill' && pid === 301),
    'exclusive mode must enter maintenance before stopping the incumbent backend',
  );
  assert.ok(
    calls.findIndex(([kind, pid]) => kind === 'kill' && pid === 301)
      < calls.findIndex(([kind, pid]) => kind === 'spawn' && pid === 102),
    'exclusive mode must stop the incumbent backend before spawning its replacement',
  );
  assert.deepEqual(calls.find(([kind, port]) => kind === 'flip' && port === 5104), ['flip', 5104]);
  assert.equal(runtime.serverProxy.restartMode, 'exclusiveDb');
  assert.equal(runtime.serverProxy.reloadGeneration, 3);
  assert.equal(runtime.ports.server, 4101);
  assert.equal(runtime.ports.serverBackend, 5104);
  assert.equal(runtime.processes.serverWrapperPid, 104);
  assert.equal(runtime.processes.serverBackendPid, 304);
  assert.equal(runtime.processes.serverDrainingPid, null);
});

test('production reload composition retries typed inconclusive post-stop evidence through the same coordinator', async (t) => {
  const fixture = await createServerFixture(t);
  await recordStackRuntimeStart(fixture.runtimeStatePath, {
    stackName: 'test-stack',
    ownerPid: process.pid,
  });
  const oldChild = { pid: 201, exitCode: null, signalCode: null };
  const children = [oldChild];
  const serverProcRef = { current: oldChild };
  const calls = [];
  const timers = [];
  let watcherCount = 0;
  let onChange = null;
  let readPollSignature = null;
  let releaseAttempt = 0;
  let oldStopped = false;
  const proxyController = {
    pid: 91,
    available: true,
    port: 4101,
    targetPort: 5101,
    async enterMaintenance() {
      calls.push('maintenance');
      return { targetHost: '127.0.0.1', targetPort: this.targetPort };
    },
    async flipUpstream({ targetPort }) {
      calls.push(['flip', targetPort]);
      this.targetPort = targetPort;
      return { targetHost: '127.0.0.1', targetPort };
    },
    async drainUpstream() {
      return { remainingConnections: 0 };
    },
  };

  const composition = startDevReloadComposition({
    watchEnabled: true,
    daemonReloadEnabled: false,
    serverReloadEnabled: true,
    serverOptions: {
      enabled: true,
      stackMode: true,
      serverComponentName: 'happier-server-light',
      serverDir: fixture.serverDir,
      serverPort: 4101,
      serverBindPort: 5101,
      internalServerUrl: 'http://127.0.0.1:4101',
      serverScript: 'dev:light',
      serverEnv: {
        HAPPIER_DB_PROVIDER: 'sqlite',
        HAPPIER_SERVER_LIGHT_DATA_DIR: fixture.dataDir,
        HAPPIER_STACK_DEV_PROXY_DRAIN_MS: '0',
        PORT: '5101',
      },
      runtimeStatePath: fixture.runtimeStatePath,
      stackName: 'test-stack',
      envPath: join(fixture.rootDir, 'stack.env'),
      children,
      serverProcRef,
      isShuttingDown: () => false,
      proxyController,
    },
    debounceMs: 0,
    pollIntervalMs: 0,
    isShuttingDown: () => false,
    logger: { log() {}, warn() {}, error() {} },
  }, {
    createDevServerReloadExecutorImpl: (options) => createDevServerReloadExecutor(options, {
      preflightDevServerRestartImpl: async () => {},
      listListenPidsImpl: async (port) => {
        if (Number(port) === 5101) return oldStopped ? [] : [301];
        if (Number(port) === 5102) return [302];
        return [];
      },
      probeTcpPortBindingImpl: async () => ({ status: 'free' }),
      getProcessGroupIdImpl: async (pid) => (
        Number(pid) === 201 || Number(pid) === 301 ? 41 : 42
      ),
      isPidAliveImpl: (pid) => Number(pid) !== 201 || !oldStopped,
      killProcessGroupOwnedByStackImpl: async (pid) => {
        calls.push(['kill', Number(pid)]);
        oldStopped = true;
        oldChild.exitCode = 0;
        return { killed: true };
      },
      waitForTcpPortFreeImpl: async () => {
        releaseAttempt += 1;
        return releaseAttempt === 1
          ? { status: 'inconclusive', reason: 'port-bind-timeout' }
          : { status: 'free' };
      },
      pickNextFreeTcpPortImpl: async () => {
        calls.push('allocate');
        return 5102;
      },
      pmSpawnScriptImpl: async ({ env }) => {
        calls.push(['spawn', Number(env.PORT), env.HAPPIER_STACK_MIGRATE_MODE]);
        return { pid: 202, exitCode: null, signalCode: null };
      },
      waitForServerReadyImpl: async () => {},
      logger: { log() {}, warn() {}, error() {} },
    }),
    startDevReloadCoordinatorImpl: (options) => startDevReloadCoordinator(options, {
      watchDebouncedImpl: ({ onChange: handler, readSignature }) => {
        watcherCount += 1;
        onChange = handler;
        readPollSignature = readSignature;
        return { close() {} };
      },
      setTimeoutImpl: (callback, milliseconds) => {
        const timer = { callback, milliseconds, unref() {} };
        timers.push(timer);
        return timer;
      },
      clearTimeoutImpl: () => {},
    }),
  });
  t.after(() => composition?.close?.());

  await readPollSignature();
  await writeFile(join(fixture.prismaDir, 'schema.prisma'), 'generator client { output = "retry" }\n');
  await onChange();

  assert.equal(watcherCount, 1);
  assert.equal(releaseAttempt, 1);
  assert.deepEqual(timers.map(({ milliseconds }) => milliseconds), [250]);
  assert.equal(calls.some((entry) => Array.isArray(entry) && entry[0] === 'spawn'), false);
  assert.equal(calls.includes('allocate'), false);
  const retryRuntime = JSON.parse(await readFile(fixture.runtimeStatePath, 'utf8'));
  assert.deepEqual(retryRuntime.serverLifecycle, {
    phase: 'retry-scheduled',
    planned: { mode: 'exclusiveDb', generation: 1, reason: 'prisma_changed' },
    lastCompleted: null,
    retry: { afterMs: 250 },
    disposition: null,
  });

  await timers[0].callback();

  const runtime = JSON.parse(await readFile(fixture.runtimeStatePath, 'utf8'));
  assert.equal(watcherCount, 1);
  assert.equal(releaseAttempt, 2);
  assert.deepEqual(calls.filter((entry) => Array.isArray(entry) && entry[0] === 'spawn'), [
    ['spawn', 5102, 'always'],
  ]);
  assert.equal(runtime.serverProxy.restartMode, 'exclusiveDb');
  assert.equal(runtime.serverProxy.reloadGeneration, 2);
  assert.deepEqual(runtime.serverLifecycle, {
    phase: 'completed',
    planned: null,
    lastCompleted: { mode: 'exclusiveDb', generation: 2 },
    retry: null,
    disposition: null,
  });
  assert.equal(runtime.ports.serverBackend, 5102);
  assert.equal(runtime.processes.serverWrapperPid, 202);
});
