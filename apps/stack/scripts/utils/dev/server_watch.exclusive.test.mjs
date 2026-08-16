import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  createDevServerReloadDescriptors,
  createDevServerReloadExecutor,
  createDevServerReloadPlan,
  updateUnresolvedChildRetention,
} from './server.mjs';
import { getSpawnedProcessPlannedExitReason } from '../proc/proc.mjs';
import { listListenPids } from '../net/ports.mjs';
import { startDevReloadCoordinator } from './devReloadCoordinator.mjs';
import {
  readStackRuntimeStateFile,
  recordStackRuntimeServerActivation,
  recordStackRuntimeStart,
} from '../stack/runtime_state.mjs';

async function withTempServerDir(t, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-dev-server-proxy-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return await fn(dir);
}

async function restartThroughCoordinator(executor, context = {}, { retryScheduled } = {}) {
  try {
    return await executor.restart(context);
  } catch (error) {
    const retryAfterMs = Number(error?.reloadRetryAfterMs);
    const scheduled = retryScheduled ?? (Number.isFinite(retryAfterMs) && retryAfterMs > 0);
    try {
      await executor.publishFailureDisposition({
        error,
        plan: executor.createPlan(context),
        retryScheduled: scheduled,
        retryAfterMs: scheduled ? Math.trunc(retryAfterMs) : null,
      });
    } catch {
      // The coordinator preserves the typed restart error when outward projection fails.
    }
    throw error;
  }
}

function createExecutorOptions(serverDir, overrides = {}) {
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

test('unresolved-child retention refines same-child classifications without leaking them to another child', () => {
  const firstChild = { pid: 201, exitCode: null };
  const secondChild = { pid: 202, exitCode: null };
  const initial = updateUnresolvedChildRetention(null, firstChild, {
    activationCommitUnknown: true,
    transportCommitted: true,
  });

  assert.deepEqual(updateUnresolvedChildRetention(initial, firstChild, {
    oldServerStopped: true,
  }), {
    child: firstChild,
    oldServerStopped: true,
    transportCommitted: true,
    serviceRestored: false,
    activationCommitUnknown: true,
  });
  assert.deepEqual(updateUnresolvedChildRetention(initial, secondChild, {
    oldServerStopped: true,
  }), {
    child: secondChild,
    oldServerStopped: true,
    transportCommitted: false,
    serviceRestored: false,
    activationCommitUnknown: false,
  });
});

test('ordinary SQLite app-only reload with a live proxy is admitted exclusively', () => {
  const appOnlyPlan = createDevServerReloadPlan({
    dbProvider: 'sqlite',
    changedDescriptors: ['server:app'],
    generation: 7,
  });
  assert.equal(appOnlyPlan.mode, 'exclusiveDb');
  assert.equal(appOnlyPlan.migrationMode, 'skip');
  assert.equal(appOnlyPlan.generation, 7);
  assert.deepEqual(createDevServerReloadPlan({
    dbProvider: 'sqlite',
    changedDescriptors: ['shared:protocol', 'daemon:cli'],
    generation: 8,
  }), {
    generation: 8,
    mode: 'exclusiveDb',
    migrationMode: 'skip',
    reason: 'app_only_descriptor_unchanged',
  });
  assert.equal(createDevServerReloadPlan({
    dbProvider: 'sqlite',
    changedDescriptors: ['server:app', 'server:prisma'],
    generation: 9,
  }).migrationMode, 'apply');
  for (const inconclusive of [
    {},
    { changedDescriptors: ['server:app'] },
    { changedDescriptors: [] },
    { changedDescriptors: ['server:unknown'], generation: 9 },
    { changedDescriptors: ['shared:protocol', 'migration:unknown'], generation: 9 },
    {
      changedDescriptors: ['shared:protocol', 'daemon:cli'],
      descriptorEvidenceConclusive: false,
      generation: 9,
    },
    { changedDescriptors: 'server:app', generation: 9 },
  ]) {
    assert.equal(createDevServerReloadPlan({ dbProvider: 'sqlite', ...inconclusive }).migrationMode, 'apply');
  }
  assert.deepEqual(createDevServerReloadPlan({
    dbProvider: 'sqlite',
    changedDescriptors: ['server:app', 'server:prisma'],
    generation: 8,
  }), {
    generation: 8,
    mode: 'exclusiveDb',
    migrationMode: 'apply',
    reason: 'prisma_changed',
  });
  assert.equal(createDevServerReloadPlan({
    dbProvider: 'sqlite',
    changedDescriptors: ['server:app'],
    generation: 9,
  }).reason, 'app_only_descriptor_unchanged');
});

test('planned server termination honors the server shutdown deadline plus bounded exit overhead', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let terminationOptions = null;
    const executor = createDevServerReloadExecutor(
      createExecutorOptions(serverDir, {
        serverEnv: {
          HAPPIER_DB_PROVIDER: 'sqlite',
          HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: '1200ms',
          PORT: '5101',
        },
        proxyController: {
          pid: 91,
          async enterMaintenance() {},
          async flipUpstream() {},
        },
      }),
      {
        preflightDevServerRestartImpl: async () => {},
        listListenPidsImpl: async () => [101],
        getProcessGroupIdImpl: async (pid) => Number(pid),
        killProcessGroupOwnedByStackImpl: async (_pid, options) => {
          terminationOptions = options;
          return { killed: false };
        },
        logger: { log() {}, warn() {}, error() {} },
      },
    );

    await assert.rejects(() => executor.restart(), /could not be stopped safely/i);
    assert.equal(terminationOptions?.graceMs, 1450);
  });
});

test('inconclusive post-stop release evidence requests a bounded same-coordinator retry without spawning', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const oldServer = { pid: 101, exitCode: null };
    let spawnCount = 0;
    let allocationCount = 0;
    const proxyCalls = [];
    const executor = createDevServerReloadExecutor(
      createExecutorOptions(serverDir, {
        serverProcRef: { current: oldServer },
        proxyController: {
          pid: 91,
          async enterMaintenance() {
            proxyCalls.push('maintenance');
            return { targetHost: '127.0.0.1', targetPort: 5101 };
          },
          async flipUpstream() { proxyCalls.push('flip'); },
        },
      }),
      {
        preflightDevServerRestartImpl: async () => {},
        listListenPidsImpl: async () => [101],
        getProcessGroupIdImpl: async (pid) => Number(pid),
        killProcessGroupOwnedByStackImpl: async () => {
          oldServer.exitCode = 0;
          return { killed: true };
        },
        waitForTcpPortFreeImpl: async () => ({
          status: 'inconclusive',
          reason: 'port-bind-timeout',
        }),
        pickNextFreeTcpPortImpl: async () => {
          allocationCount += 1;
          return 5102;
        },
        pmSpawnScriptImpl: async () => {
          spawnCount += 1;
          throw new Error('unsafe spawn reached');
        },
        logger: { log() {}, warn() {}, error() {} },
      },
    );

    await assert.rejects(
      () => restartThroughCoordinator(executor),
      (error) => (
        error?.code === 'ESERVERBACKENDPORTRELEASEINCONCLUSIVE'
        && Number(error?.reloadRetryAfterMs) > 0
      ),
    );
    assert.deepEqual(proxyCalls, ['maintenance', 'maintenance']);
    assert.equal(allocationCount, 0);
    assert.equal(spawnCount, 0);
  });
});

for (const observation of [
  { status: 'timeout', supported: true, pids: [], reason: 'listener-discovery-timeout' },
  { status: 'unsupported', supported: false, pids: [], reason: 'missing-listener-discovery-command' },
  { status: 'error', supported: true, pids: [], reason: 'listener-discovery-error' },
]) {
  test(`exclusive reload preserves typed ${observation.status} listener evidence before destructive mutation`, async (t) => {
    await withTempServerDir(t, async (serverDir) => {
      const calls = [];
      const incumbent = { pid: 101, exitCode: null };
      const serverProcRef = { current: incumbent };
      const activations = [];
      let typedObservations = 0;
      const executor = createDevServerReloadExecutor(
        createExecutorOptions(serverDir, {
          serverProcRef,
          proxyController: {
            pid: 91,
            async enterMaintenance() { calls.push('maintenance'); },
            async flipUpstream() { calls.push('flip'); },
          },
        }),
        {
          preflightDevServerRestartImpl: async () => {},
          listListenPidsImpl: listListenPids,
          listListenPidsWithStatusImpl: async () => {
            typedObservations += 1;
            return observation;
          },
          getProcessGroupIdImpl: async () => null,
          listenerOwnershipTimeoutMs: observation.status === 'unsupported' ? 500 : 20,
          listenerOwnershipRetryDelayMs: 0,
          isTcpPortFreeImpl: async () => {
            calls.push('bind-proof');
            return true;
          },
          killProcessGroupOwnedByStackImpl: async () => {
            calls.push('kill');
            return { killed: true };
          },
          recordStackRuntimeServerActivationImpl: async (_path, activation) => activations.push(activation),
          logger: { log() {}, warn() {}, error() {} },
        },
      );

      await assert.rejects(
        () => executor.restart({
          generation: 1,
          changedDescriptors: ['server:prisma'],
          reloadPlans: {
            server: createDevServerReloadPlan({
              dbProvider: 'sqlite',
              changedDescriptors: ['server:prisma'],
              generation: 1,
            }),
          },
        }),
        (error) => error?.code === 'ELISTENERDISCOVERYINCONCLUSIVE'
          && error?.reloadRetryAfterMs === (observation.status === 'unsupported' ? undefined : 250)
          && (
            error?.observation?.status === observation.status
            || (observation.status === 'error' && error?.observation?.status === 'timeout')
          )
          && (
            error?.observation?.reason === observation.reason
            || (observation.status === 'error' && error?.observation?.reason === 'listener-discovery-timeout')
          ),
      );

      assert.ok(typedObservations > 0);
      assert.deepEqual(calls, []);
      assert.equal(serverProcRef.current, incumbent);
      assert.deepEqual(activations, []);
    });
  });
}

test('direct reload preserves typed listener evidence before destructive mutation', async (t) => {
  for (const observation of [
    { status: 'timeout', supported: true, pids: [], reason: 'listener-discovery-timeout' },
    { status: 'unsupported', supported: false, pids: [], reason: 'missing-listener-discovery-command' },
    { status: 'error', supported: true, pids: [], reason: 'listener-discovery-error' },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await withTempServerDir(t, async (serverDir) => {
      const calls = [];
      const executor = createDevServerReloadExecutor(
        createExecutorOptions(serverDir, {
          proxyController: null,
          serverPort: 4101,
          serverBindPort: 4101,
          internalServerUrl: 'http://127.0.0.1:4101',
        }),
        {
          preflightDevServerRestartImpl: async () => {},
          listListenPidsImpl: listListenPids,
          listListenPidsWithStatusImpl: async () => observation,
          getProcessGroupIdImpl: async () => null,
          listenerOwnershipTimeoutMs: 20,
          listenerOwnershipRetryDelayMs: 0,
          isPidAliveImpl: () => true,
          isTcpPortFreeImpl: async () => {
            calls.push('bind-proof');
            return true;
          },
          killProcessGroupOwnedByStackImpl: async () => {
            calls.push('kill');
            return { killed: true };
          },
          pmSpawnScriptImpl: async () => {
            calls.push('spawn');
            return { pid: 201, exitCode: null };
          },
          logger: { log() {}, warn() {}, error() {} },
        },
      );

      await assert.rejects(
        () => executor.restart({
          generation: 1,
          changedDescriptors: ['server:prisma'],
          reloadPlans: {
            server: createDevServerReloadPlan({
              dbProvider: 'sqlite',
              changedDescriptors: ['server:prisma'],
              generation: 1,
            }),
          },
        }),
        (error) => error?.code === 'ELISTENERDISCOVERYINCONCLUSIVE'
          && (
            error?.observation?.status === observation.status
            || (observation.status === 'error' && error?.observation?.status === 'timeout')
          )
          && (
            error?.observation?.reason === observation.reason
            || (observation.status === 'error' && error?.observation?.reason === 'listener-discovery-timeout')
          ),
      );

      assert.deepEqual(calls, []);
    });
  }

  await withTempServerDir(t, async (serverDir) => {
    let listenerObservations = 0;
    let bindingProbes = 0;
    let separateAvailabilityChecks = 0;
    const executor = createDevServerReloadExecutor(
      createExecutorOptions(serverDir, {
        proxyController: null,
        serverPort: 4101,
        serverBindPort: 4101,
        internalServerUrl: 'http://127.0.0.1:4101',
        serverProcRef: { current: { pid: 101, exitCode: 0 } },
      }),
      {
        preflightDevServerRestartImpl: async () => {},
        listListenPidsImpl: async () => {
          listenerObservations += 1;
          return [];
        },
        probeTcpPortBindingImpl: async () => {
          bindingProbes += 1;
          return { status: 'free' };
        },
        isTcpPortFreeImpl: async () => {
          separateAvailabilityChecks += 1;
          throw new Error('separate listener deadline must not run');
        },
        waitForTcpPortFreeImpl: async () => ({ status: 'occupied', reason: 'address-in-use' }),
        isPidAliveImpl: () => false,
        logger: { log() {}, warn() {}, error() {} },
      },
    );

    await assert.rejects(
      () => executor.restart({ changedDescriptors: ['server:prisma'] }),
      (error) => error?.code === 'ESERVERBACKENDPORTOCCUPIED',
    );
    assert.equal(listenerObservations, 1);
    assert.equal(bindingProbes, 1);
    assert.equal(separateAvailabilityChecks, 0);
  });

  for (const mode of ['exclusiveDb']) {
    // eslint-disable-next-line no-await-in-loop
    await withTempServerDir(t, async (serverDir) => {
      let listenerObservations = 0;
      let bindingProbes = 0;
      let separateAvailabilityChecks = 0;
      const executor = createDevServerReloadExecutor(
        createExecutorOptions(serverDir, {
          proxyController: {
            pid: 91,
            available: true,
            port: 4101,
            targetPort: 5101,
            async enterMaintenance() {},
          },
          serverProcRef: { current: { pid: 101, exitCode: 0 } },
        }),
        {
          preflightDevServerRestartImpl: async () => {},
          listListenPidsImpl: async () => {
            listenerObservations += 1;
            return [];
          },
          probeTcpPortBindingImpl: async () => {
            bindingProbes += 1;
            return { status: 'free' };
          },
          isTcpPortFreeImpl: async () => {
            separateAvailabilityChecks += 1;
            throw new Error('separate listener deadline must not run');
          },
          waitForTcpPortFreeImpl: async () => ({ status: 'occupied', reason: 'address-in-use' }),
          isPidAliveImpl: () => false,
          pmSpawnScriptImpl: async () => { throw new Error('spawn reached'); },
          logger: { log() {}, warn() {}, error() {} },
        },
      );
      const reloadPlan = {
        generation: 1,
        mode,
        migrationMode: 'apply',
        reason: 'test',
      };

      await assert.rejects(
        () => executor.restart({ reloadPlans: { server: reloadPlan } }),
        (error) => error?.code === 'ESERVERBACKENDPORTOCCUPIED',
      );
      assert.equal(listenerObservations, 1);
      assert.equal(bindingProbes, 1);
      assert.equal(separateAvailabilityChecks, 0);
    });
  }
});

test('direct reload consumes one canonical plan and projects completed mode and generation', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const updates = [];
    const spawnEnvs = [];
    const exits = [];
    const replacement = Object.assign(new EventEmitter(), { pid: 202, exitCode: null, signalCode: null });
    let listenerObservation = 0;
    const executor = createDevServerReloadExecutor(
      createExecutorOptions(serverDir, {
        proxyController: null,
        serverPort: 4101,
        serverBindPort: 4101,
        internalServerUrl: 'http://127.0.0.1:4101',
      }),
      {
        preflightDevServerRestartImpl: async () => {},
        isTcpPortFreeImpl: async () => true,
        waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
        pmSpawnScriptImpl: async ({ env, options }) => {
          spawnEnvs.push(env);
          options?.onLine?.({ line: '{"happierStackTransition":"migration_started"}' });
          return replacement;
        },
        waitForServerReadyImpl: async (_url, options) => {
          assert.equal(options?.startupDeadline?.getPhase(), 'migration');
        },
        listListenPidsImpl: async () => (++listenerObservation === 1 ? [101] : [202]),
        getProcessGroupIdImpl: async (pid) => Number(pid),
        killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
        recordStackRuntimeUpdateImpl: async (_path, patch) => updates.push(patch),
        logger: { log() {}, warn() {}, error() {} },
      },
    );
    executor.setUnexpectedExitHandler((event) => exits.push(event));

    const context = { generation: 21, changedDescriptors: ['server:app'] };
    const plan = executor.createPlan(context);
    await executor.restart({ ...context, reloadPlans: { server: plan } });

    assert.deepEqual(plan, {
      generation: 21,
      mode: 'exclusiveDb',
      migrationMode: 'skip',
      reason: 'app_only_descriptor_unchanged',
    });
    assert.equal(spawnEnvs[0].HAPPIER_STACK_MIGRATE_MODE, 'skip');
    assert.equal(updates.at(-1).serverProxy.restartMode, 'exclusiveDb');
    assert.equal(updates.at(-1).serverProxy.reloadGeneration, 21);
    replacement.exitCode = 1;
    replacement.emit('exit', 1, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(exits.length, 1);
    assert.equal(exits[0].pid, 202);
  });
});

test('direct exclusive reload surfaces unconfirmed provisional cleanup before another migration process can start', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const updates = [];
    let listenerObservation = 0;
    let spawnCount = 0;
    const executor = createDevServerReloadExecutor(
      createExecutorOptions(serverDir, {
        proxyController: null,
        serverPort: 4101,
        serverBindPort: 4101,
        internalServerUrl: 'http://127.0.0.1:4101',
      }),
      {
        preflightDevServerRestartImpl: async () => {},
        isTcpPortFreeImpl: async () => true,
        waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
        pmSpawnScriptImpl: async () => ({ pid: 201 + (++spawnCount), exitCode: null }),
        waitForServerReadyImpl: async () => { throw new Error('replacement not ready'); },
        listListenPidsImpl: async () => (++listenerObservation === 1 ? [101] : []),
        getProcessGroupIdImpl: async (pid) => Number(pid),
        killProcessGroupOwnedByStackImpl: async (pid) => Number(pid) === 101 ? { killed: true } : { killed: false },
        terminateSpawnedChildImpl: async () => false,
        recordStackRuntimeUpdateImpl: async (_path, patch) => updates.push(patch),
        logger: { log() {}, warn() {}, error() {} },
      },
    );

    await assert.rejects(
      () => executor.restart({ changedDescriptors: ['server:prisma'] }),
      /provisional.*termination.*not.*confirmed/i,
    );
    await assert.rejects(
      () => executor.restart({ changedDescriptors: ['server:prisma'] }),
      /provisional.*termination.*not.*confirmed/i,
    );
    assert.equal(spawnCount, 1);
    assert.equal(updates.at(-1).processes.serverDrainingPid, 202);
  });
});

test('direct exclusive reload reports runtime projection failure after the replacement is active', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const logs = [];
    let listenerObservation = 0;
    const options = createExecutorOptions(serverDir, {
      proxyController: null,
      serverPort: 4101,
      serverBindPort: 4101,
      internalServerUrl: 'http://127.0.0.1:4101',
    });
    const executor = createDevServerReloadExecutor(options, {
      preflightDevServerRestartImpl: async () => {},
      isTcpPortFreeImpl: async () => true,
      waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
      pmSpawnScriptImpl: async () => ({ pid: 202, exitCode: null }),
      waitForServerReadyImpl: async () => {},
      listListenPidsImpl: async () => (++listenerObservation === 1 ? [101] : [202]),
      getProcessGroupIdImpl: async (pid) => Number(pid),
      killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
      recordStackRuntimeUpdateImpl: async () => { throw new Error('runtime projection unavailable'); },
      logger: { log() {}, error(message) { logs.push(message); } },
    });

    await assert.rejects(
      () => executor.restart({ generation: 26, changedDescriptors: ['server:prisma'] }),
      /direct replacement server is active.*runtime projection unavailable/i,
    );

    assert.equal(options.serverProcRef.current.pid, 202);
    assert.equal(logs.some((line) => /direct replacement server is active/.test(line)), true);
  });
});

test('server reload descriptors keep app and prisma changes distinguishable', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    await import('node:fs/promises').then(async ({ mkdir, writeFile }) => {
      await mkdir(join(serverDir, 'sources'), { recursive: true });
      await mkdir(join(serverDir, 'prisma'), { recursive: true });
      await writeFile(join(serverDir, 'sources', 'main.ts'), 'export {};\n', 'utf-8');
      await writeFile(join(serverDir, 'prisma', 'schema.prisma'), 'datasource db { provider = "sqlite" }\n', 'utf-8');
      await writeFile(join(serverDir, 'tsconfig.runtime.json'), '{}\n', 'utf-8');
    });

    const descriptors = createDevServerReloadDescriptors({ serverDir });
    const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));

    assert.ok(byId.has('server:app'));
    assert.ok(byId.has('server:prisma'));
    assert.equal(typeof byId.get('server:app').readSignatureAsync, 'function');
    assert.equal(typeof byId.get('server:prisma').readSignatureAsync, 'function');
    assert.deepEqual(
      byId.get('server:app').paths.map((p) => p.slice(serverDir.length + 1)).sort(),
      ['sources', 'tsconfig.runtime.json'],
    );
    assert.deepEqual(byId.get('server:prisma').paths.map((p) => p.slice(serverDir.length + 1)).sort(), ['prisma']);
  });
});

test('server reload descriptors ignore test-only source edits without missing runtime source edits', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(serverDir, 'sources', 'app', 'session'), { recursive: true });
    await mkdir(join(serverDir, 'prisma'), { recursive: true });
    await writeFile(join(serverDir, 'sources', 'app', 'session', 'runtime.ts'), 'export const value = 1;\n', 'utf-8');
    await writeFile(join(serverDir, 'prisma', 'schema.prisma'), 'datasource db { provider = "sqlite" }\n', 'utf-8');

    const descriptor = createDevServerReloadDescriptors({ serverDir }).find((item) => item.id === 'server:app');
    assert.ok(descriptor);

    const before = descriptor.readSignature();
    assert.equal(await descriptor.readSignatureAsync(), before);
    const assertIgnoredFileLifecycle = async (path) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, 'export const testOnly = 1;\n', 'utf-8');
      assert.equal(descriptor.readSignature(), before, `adding ${path} must be ignored`);
      assert.equal(await descriptor.readSignatureAsync(), before, `async adding ${path} must be ignored`);
      await writeFile(path, 'export const testOnly = 2;\n', 'utf-8');
      assert.equal(descriptor.readSignature(), before, `editing ${path} must be ignored`);
      assert.equal(await descriptor.readSignatureAsync(), before, `async editing ${path} must be ignored`);
      await rm(path, { force: true });
      assert.equal(descriptor.readSignature(), before, `deleting ${path} must be ignored`);
      assert.equal(await descriptor.readSignatureAsync(), before, `async deleting ${path} must be ignored`);
    };
    await assertIgnoredFileLifecycle(join(serverDir, 'sources', 'testkit', 'nested', 'env.ts'));
    await assertIgnoredFileLifecycle(join(serverDir, 'sources', 'app', 'session', 'sessionRoutes.testkit.ts'));
    await assertIgnoredFileLifecycle(join(serverDir, 'sources', 'app', 'session', 'runtime.pendingCountZero.spec.ts'));

    await writeFile(join(serverDir, 'sources', 'app', 'session', 'runtime.ts'), 'export const value = 2;\n', 'utf-8');
    assert.notEqual(descriptor.readSignature(), before);
    assert.notEqual(await descriptor.readSignatureAsync(), before);
  });
});

test('reload build delegates prerequisite admission once to validation and leaves the incumbent running on failure', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const transitionEvents = [];
    const calls = [];
    let preflightInput = null;
    const executor = createDevServerReloadExecutor(
      createExecutorOptions(serverDir),
      {
        preflightDevServerRestartImpl: async (input) => {
          calls.push('preflight');
          preflightInput = input;
          throw new Error('preflight rejected');
        },
        logger: {
          log(message) {
            if (String(message).startsWith('{')) transitionEvents.push(JSON.parse(message));
          },
          error() {},
        },
      },
    );

    await assert.rejects(
      () => executor.build({ generation: 6, changedDescriptors: ['server:prisma'] }),
      /preflight rejected/,
    );
    assert.deepEqual(calls, ['preflight']);
    assert.equal(preflightInput?.reloadMigrationMode, 'apply');
    assert.deepEqual(transitionEvents.map(({ event, disposition }) => [event, disposition ?? null]), [
      ['preflight_started', null],
      ['preflight_completed', 'failed'],
    ]);
    assert.ok(transitionEvents.every((event) => event.generation === 6));
  });
});

test('proxy exclusiveDb restart enters maintenance, replaces backend on an ephemeral port, flips, and records runtime state', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    const transitionEvents = [];
    const updates = [];
    let spawnCount = 0;
    const children = [];
    const oldServer = { pid: 101, exitCode: null };
    const proxy = {
      pid: process.pid,
      enterMaintenance(args) {
        calls.push(['maintenance', args.retryAfterMs]);
        return { targetHost: '127.0.0.1', targetPort: 6101 };
      },
      async flipUpstream({ targetPort }) {
        calls.push(['flip-request', targetPort]);
        await Promise.resolve();
        calls.push(['flip-ack', targetPort]);
      },
      drainConnections(args) {
        calls.push(['drain', args?.targetPort ?? null, args?.graceMs ?? null]);
      },
    };
    const executor = createDevServerReloadExecutor(
      createExecutorOptions(serverDir, {
        children,
        proxyController: proxy,
        serverProcRef: { current: oldServer },
      }),
      {
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
          return { status: 'free' };
        },
        pickNextFreeTcpPortImpl: async () => 5102,
        pmSpawnScriptImpl: async ({ env }) => {
          spawnCount += 1;
          calls.push(['spawn', Number(env.PORT), env.HAPPIER_STACK_MIGRATE_MODE]);
          return { pid: 202, exitCode: null };
        },
        waitForServerReadyImpl: async (url) => {
          calls.push(['ready', url]);
        },
        listListenPidsImpl: async () => [spawnCount === 0 ? 101 : 302],
        getProcessGroupIdImpl: async (pid) => (
          Number(pid) === 101 ? 7 :
          Number(pid) === 202 || Number(pid) === 302 ? 44 :
          Number(pid)
        ),
        recordStackRuntimeUpdateImpl: async (_path, patch) => {
          updates.push(patch);
        },
        nowImpl: () => Date.parse('2026-07-17T15:00:00.000Z'),
        monotonicNowImpl: (() => {
          let now = 100;
          return () => now++;
        })(),
        logger: {
          log(message) {
            if (!String(message).startsWith('{')) return;
            const event = JSON.parse(message);
            transitionEvents.push(event);
            calls.push(['event', event.event]);
          },
          error() {},
        },
      }
    );

    await executor.build({ generation: 7, changedDescriptors: ['server:app'] });
    await executor.restart({ generation: 7, changedDescriptors: ['server:app'] });

    assert.deepEqual(calls, [
      ['event', 'preflight_started'],
      ['event', 'preflight_completed'],
      ['maintenance', 2000],
      ['event', 'maintenance_entered'],
      ['event', 'old_server_shutdown_requested'],
      ['kill', 101],
      ['event', 'old_server_exited'],
      ['wait-free', 5101],
      ['event', 'port_database_release_result'],
      ['event', 'migration_skipped'],
      ['spawn', 5102, 'skip'],
      ['event', 'replacement_spawned'],
      ['ready', 'http://127.0.0.1:5102'],
      ['event', 'replacement_ready'],
      ['event', 'backend_activation_requested'],
      ['flip-request', 5102],
      ['flip-ack', 5102],
      ['event', 'backend_activation_acknowledged'],
      ['event', 'maintenance_exited'],
      ['drain', 6101, 2000],
      ['drain', 5101, 2000],
    ]);
    assert.deepEqual(transitionEvents.map(({ event }) => event), [
      'preflight_started',
      'preflight_completed',
      'maintenance_entered',
      'old_server_shutdown_requested',
      'old_server_exited',
      'port_database_release_result',
      'migration_skipped',
      'replacement_spawned',
      'replacement_ready',
      'backend_activation_requested',
      'backend_activation_acknowledged',
      'maintenance_exited',
    ]);
    assert.ok(transitionEvents.every((event) => event.generation === 7));
    assert.ok(transitionEvents.every((event) => event.timestamp === '2026-07-17T15:00:00.000Z'));
    assert.deepEqual(transitionEvents.map((event) => event.monotonicMs),
      transitionEvents.map((_, index) => 100 + index));
    assert.equal(transitionEvents.find((event) => event.event === 'port_database_release_result')?.disposition, 'released');
    assert.equal(transitionEvents.find((event) => event.event === 'migration_skipped')?.migrationMode, 'skip');
    assert.equal(getSpawnedProcessPlannedExitReason(oldServer), 'dev-reload');
    assert.equal(children[0].pid, 202);
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
          reloadGeneration: 7,
          fallbackReason: null,
        },
        serverLifecycle: {
          phase: 'completed',
          planned: null,
          retry: null,
          disposition: null,
          lastCompleted: {
            mode: 'exclusiveDb',
            generation: 7,
          },
        },
      },
    ]);
  });
});

test('proxy reload stops the proven listener when its wrapper already exited', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const wrapperPid = 101;
    const incumbentListenerPid = 151;
    const replacementWrapperPid = 202;
    const replacementListenerPid = 252;
    const killedPids = [];
    const flippedPorts = [];
    let incumbentListenerAlive = true;
    const oldServer = { pid: wrapperPid, exitCode: 0, signalCode: null };
    const options = createExecutorOptions(serverDir, {
      serverProcRef: { current: oldServer },
      proxyController: {
        pid: process.pid,
        async enterMaintenance() {
          return { targetHost: '127.0.0.1', targetPort: 6101 };
        },
        async flipUpstream({ targetPort }) {
          flippedPorts.push(Number(targetPort));
        },
        async drainConnections() {},
      },
    });
    const executor = createDevServerReloadExecutor(options, {
      preflightDevServerRestartImpl: async () => {},
      listListenPidsImpl: async (port) => (
        Number(port) === 5101 && incumbentListenerAlive
          ? [incumbentListenerPid]
          : Number(port) === 5102
            ? [replacementListenerPid]
            : []
      ),
      getProcessGroupIdImpl: async (pid) => (
        Number(pid) === wrapperPid || Number(pid) === incumbentListenerPid
          ? 900
          : Number(pid) === replacementWrapperPid || Number(pid) === replacementListenerPid
            ? 901
            : Number(pid)
      ),
      killProcessGroupOwnedByStackImpl: async (pid) => {
        const targetPid = Number(pid);
        killedPids.push(targetPid);
        if (targetPid === incumbentListenerPid) {
          incumbentListenerAlive = false;
          return { killed: true, reason: 'killed_pgid' };
        }
        return { killed: true, reason: 'already_exited' };
      },
      waitForTcpPortFreeImpl: async () => (
        incumbentListenerAlive
          ? { status: 'occupied', reason: 'listener-still-alive' }
          : { status: 'free' }
      ),
      pickNextFreeTcpPortImpl: async () => 5102,
      pmSpawnScriptImpl: async () => ({ pid: replacementWrapperPid, exitCode: null, signalCode: null }),
      waitForServerReadyImpl: async () => {},
      recordStackRuntimeServerActivationImpl: async () => {},
      logger: { log() {}, error() {} },
    });

    const result = await executor.restart({ generation: 8, changedDescriptors: ['server:app'] });

    assert.deepEqual(result, { restarted: true });
    assert.deepEqual(killedPids, [incumbentListenerPid]);
    assert.deepEqual(flippedPorts, [5102]);
    assert.equal(options.serverProcRef.current.pid, replacementWrapperPid);
  });
});

test('maintenance lifecycle publication failure restores the incumbent before any destructive stop', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const options = createExecutorOptions(serverDir);
    const flips = [];
    const restoreCalls = [];
    let kills = 0;
    let spawns = 0;
    options.proxyController = {
      pid: process.pid,
      async enterMaintenance() {
        return { targetHost: '127.0.0.1', targetPort: 6101 };
      },
      async flipUpstream({ targetPort }) {
        flips.push(targetPort);
        restoreCalls.push(['flip', targetPort]);
      },
      async drainConnections({ targetPort }) { restoreCalls.push(['drain', targetPort]); },
    };
    const incumbent = options.serverProcRef.current;
    const executor = createDevServerReloadExecutor(options, {
      preflightDevServerRestartImpl: async () => {},
      listListenPidsImpl: async () => [101],
      getProcessGroupIdImpl: async (pid) => Number(pid),
      killProcessGroupOwnedByStackImpl: async () => { kills += 1; return { killed: true }; },
      pmSpawnScriptImpl: async () => { spawns += 1; return { pid: 202, exitCode: null }; },
      recordStackRuntimeServerLifecycleImpl: async (_path, transition) => {
        if (transition.phase === 'maintenance') throw new Error('maintenance publication unavailable');
      },
      logger: {
        log(message) {
          if (!String(message).startsWith('{')) return;
          const event = JSON.parse(message);
          if (event.purpose === 'maintenance_restore') restoreCalls.push(['event', event.event]);
        },
        warn() {},
        error() {},
      },
    });

    await assert.rejects(
      () => executor.restart({ generation: 30, changedDescriptors: ['server:app'] }),
      /maintenance publication unavailable/,
    );

    assert.deepEqual(flips, [5101], 'the stable proxy must be restored to the incumbent backend');
    assert.deepEqual(restoreCalls, [
      ['event', 'backend_activation_requested'],
      ['flip', 5101],
      ['event', 'backend_activation_acknowledged'],
      ['event', 'maintenance_exited'],
      ['drain', 6101],
    ]);
    assert.equal(kills, 0, 'publication must succeed before destructive authorization');
    assert.equal(spawns, 0);
    assert.equal(options.serverProcRef.current, incumbent);
  });
});

test('a ready replacement is activated after incumbent shutdown even when a newer generation is pending', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const options = createExecutorOptions(serverDir);
    const flips = [];
    const activations = [];
    const replacement = { pid: 202, exitCode: null };
    let revalidations = 0;
    options.proxyController = {
      pid: process.pid,
      async enterMaintenance() { return { targetHost: '127.0.0.1', targetPort: 6101 }; },
      async flipUpstream({ targetPort }) { flips.push(targetPort); },
      async drainConnections() {},
    };
    const executor = createDevServerReloadExecutor(options, {
      preflightDevServerRestartImpl: async () => {},
      listListenPidsImpl: async (port) => Number(port) === 5101 ? [101] : [202],
      getProcessGroupIdImpl: async (pid) => Number(pid),
      killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
      waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
      pickNextFreeTcpPortImpl: async () => 5102,
      pmSpawnScriptImpl: async () => replacement,
      waitForServerReadyImpl: async () => {},
      terminateSpawnedChildImpl: async () => true,
      recordStackRuntimeServerActivationImpl: async (_path, activation) => activations.push(activation),
      logger: { log() {}, warn() {}, error() {} },
    });

    const result = await executor.restart({
      generation: 31,
      changedDescriptors: ['server:app'],
      revalidateGeneration: async () => ++revalidations < 3,
    });

    assert.deepEqual(result, { restarted: true });
    assert.deepEqual(flips, [5102], 'the ready replacement restores service before the trailing reload');
    assert.equal(options.serverProcRef.current, replacement);
    assert.equal(activations.length, 1);
  });
});

test('a ready direct replacement remains active after incumbent shutdown when a newer generation is pending', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const replacement = { pid: 202, exitCode: null };
    const options = createExecutorOptions(serverDir, {
      proxyController: null,
      serverBindPort: 4101,
      internalServerUrl: 'http://127.0.0.1:4101',
    });
    let revalidations = 0;
    let listenerObservation = 0;
    const activations = [];
    const executor = createDevServerReloadExecutor(options, {
      preflightDevServerRestartImpl: async () => {},
      isTcpPortFreeImpl: async () => true,
      listListenPidsImpl: async () => (++listenerObservation === 1 ? [101] : [202]),
      getProcessGroupIdImpl: async (pid) => Number(pid),
      killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
      waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
      pmSpawnScriptImpl: async () => replacement,
      waitForServerReadyImpl: async () => {},
      terminateSpawnedChildImpl: async () => true,
      recordStackRuntimeUpdateImpl: async (_path, activation) => activations.push(activation),
      logger: { log() {}, warn() {}, error() {} },
    });

    const result = await executor.restart({
      generation: 32,
      changedDescriptors: ['server:app'],
      revalidateGeneration: async () => ++revalidations < 2,
    });

    assert.deepEqual(result, { restarted: true });
    assert.equal(options.serverProcRef.current, replacement);
    assert.equal(activations.length, 1);
  });
});

test('proxy exclusiveDb restart starts current-code recovery when replacement readiness fails after old backend stopped', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    const logs = [];
    const transitionEvents = [];
    const proxy = {
      enterMaintenance() {
        calls.push(['maintenance']);
        return { targetHost: '127.0.0.1', targetPort: 6101 };
      },
      flipUpstream({ targetPort }) {
        calls.push(['flip', targetPort]);
      },
      drainConnections(args) {
        calls.push(['drain', args?.targetPort ?? null, args?.graceMs ?? null]);
      },
    };
    let spawnCount = 0;
    const readinessPhases = [];

    const executor = createDevServerReloadExecutor(
      createExecutorOptions(serverDir, { proxyController: proxy }),
      {
        preflightDevServerRestartImpl: async () => {},
        killProcessGroupOwnedByStackImpl: async (pid) => {
          calls.push(['kill', pid]);
          return { killed: true };
        },
        waitForTcpPortFreeImpl: async (port) => {
          calls.push(['wait-free', port]);
          return { status: 'free' };
        },
        pickNextFreeTcpPortImpl: async () => 5102,
        pmSpawnScriptImpl: async ({ env, options }) => {
          spawnCount += 1;
          calls.push(['spawn', Number(env.PORT), env.HAPPIER_STACK_MIGRATE_MODE]);
          options?.onLine?.({ stream: 'stdout', line: '{"happierStackTransition":"migration_started"}' });
          if (spawnCount > 1) {
            options?.onLine?.({ stream: 'stdout', line: '{"happierStackTransition":"migration_completed"}' });
          }
          return { pid: spawnCount === 1 ? 202 : 203, exitCode: null };
        },
        waitForServerReadyImpl: async (url, options) => {
          readinessPhases.push(options?.startupDeadline?.getPhase());
          calls.push(['ready', url]);
          if (url.endsWith(':5102')) {
            throw new Error('replacement not ready');
          }
        },
        listListenPidsImpl: async () => [spawnCount === 0 ? 101 : spawnCount === 1 ? 302 : 303],
        getProcessGroupIdImpl: async (pid) => (
          Number(pid) === 101 ? 7 :
          Number(pid) === 202 || Number(pid) === 302 ? 44 :
          Number(pid) === 203 || Number(pid) === 303 ? 45 :
          Number(pid)
        ),
        recordStackRuntimeUpdateImpl: async () => {},
        logger: {
          log(message) {
            if (String(message).startsWith('{')) transitionEvents.push(JSON.parse(message));
          },
          error(message) { logs.push(message); },
        },
      }
    );

    await assert.rejects(() => executor.restart(), /replacement not ready/);

    assert.deepEqual(calls, [
      ['maintenance'],
      ['kill', 101],
      ['wait-free', 5101],
      ['spawn', 5102, 'always'],
      ['ready', 'http://127.0.0.1:5102'],
      ['kill', 202],
      ['spawn', 5101, 'always'],
      ['ready', 'http://127.0.0.1:5101'],
      ['flip', 5101],
      ['drain', 6101, 2000],
      ['drain', 5102, 2000],
    ]);
    assert.equal(executor.createPlan({ changedDescriptors: ['server:prisma'] }).migrationMode, 'apply');
    assert.deepEqual(readinessPhases, ['migration', 'readiness']);
    assert.deepEqual(
      transitionEvents
        .filter((event) => event.purpose === 'replacement' && event.event.startsWith('migration_'))
        .map(({ event, disposition }) => [event, disposition ?? null]),
      [
        ['migration_started', null],
        ['migration_completed', 'failed'],
      ],
    );
    assert.equal(
      transitionEvents.some((event) => event.event === 'replacement_readiness_failed' && event.purpose === 'replacement'),
      true,
    );
    assert.equal(logs.some((line) => /current-code recovery server is active/.test(line)), true);
  });
});

test('confirmed replacement and recovery failure publishes terminal unavailable state without stale server membership', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const runtimeStatePath = join(serverDir, 'stack.runtime.json');
    await recordStackRuntimeStart(runtimeStatePath, {
      stackName: 'proxy-test',
      ownerPid: process.pid,
      processes: { daemonPid: process.pid, daemonPids: [process.pid] },
    });
    await recordStackRuntimeServerActivation(runtimeStatePath, {
      listenerPid: process.pid,
      wrapperPid: process.pid,
      stablePort: 4101,
      backendPort: 5101,
      proxyPid: process.pid,
      drainingPid: process.pid,
      mode: 'proxy',
      restartMode: 'exclusiveDb',
      reloadGeneration: 4,
    });

    let spawnCount = 0;
    const executor = createDevServerReloadExecutor(
      createExecutorOptions(serverDir, {
        runtimeStatePath,
        proxyController: {
          pid: process.pid,
          async enterMaintenance() { return { targetHost: '127.0.0.1', targetPort: 6101 }; },
          async flipUpstream() {},
          async drainConnections() {},
        },
      }),
      {
        preflightDevServerRestartImpl: async () => {},
        waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
        pickNextFreeTcpPortImpl: async () => 5102,
        pmSpawnScriptImpl: async () => {
          spawnCount += 1;
          return { pid: spawnCount === 1 ? 202 : 203, exitCode: null };
        },
        waitForServerReadyImpl: async () => { throw new Error('backend not ready'); },
        listListenPidsImpl: async () => [spawnCount === 0 ? 101 : spawnCount === 1 ? 302 : 303],
        getProcessGroupIdImpl: async (pid) => (
          Number(pid) === 101 ? 7
            : Number(pid) === 202 || Number(pid) === 302 ? 44
              : Number(pid) === 203 || Number(pid) === 303 ? 45
                : Number(pid)
        ),
        killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
        logger: { log() {}, warn() {}, error() {} },
      },
    );

    await assert.rejects(
      () => restartThroughCoordinator(executor, { generation: 5, changedDescriptors: ['server:prisma'] }, { retryScheduled: false }),
      /backend not ready/,
    );
    assert.equal(spawnCount, 2);

    const runtimeState = await readStackRuntimeStateFile(runtimeStatePath);
    assert.equal(runtimeState.serverLifecycle.phase, 'unavailable');
    assert.equal(runtimeState.serverLifecycle.disposition.code, 'recovery');
    assert.equal(runtimeState.processes.serverPid, null);
    assert.equal(runtimeState.processes.serverWrapperPid, null);
    assert.equal(runtimeState.processes.serverBackendPid, null);
    assert.equal(runtimeState.processes.serverDrainingPid, null);
    assert.equal(runtimeState.ports.serverBackend, null);
    assert.equal(runtimeState.ownerPid, process.pid);
    assert.equal(runtimeState.processes.proxyPid, process.pid);
    assert.equal(runtimeState.processes.daemonPid, process.pid);
    assert.equal(runtimeState.ports.server, 4101);
    assert.equal(runtimeState.serverProxy.mode, 'proxy');
  });
});

test('proxy exclusiveDb restart recovers when the incumbent already exited before replacement', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const spawnPorts = [];
    const flips = [];
    let spawnCount = 0;
    const executor = createDevServerReloadExecutor(
      createExecutorOptions(serverDir, {
        serverProcRef: { current: { pid: 101, exitCode: 0 } },
        proxyController: {
          pid: 91,
          async enterMaintenance() {
            return { targetHost: '127.0.0.1', targetPort: 6101 };
          },
          async flipUpstream({ targetPort }) {
            flips.push(targetPort);
          },
          async drainConnections() {},
        },
      }),
      {
        preflightDevServerRestartImpl: async () => {},
        listListenPidsImpl: async () => {
          if (spawnCount === 0) return [];
          return [spawnCount === 1 ? 302 : 303];
        },
        probeTcpPortBindingImpl: async () => ({ status: 'free' }),
        isPidAliveImpl: () => false,
        waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
        pickNextFreeTcpPortImpl: async () => 5102,
        pmSpawnScriptImpl: async ({ env }) => {
          spawnCount += 1;
          spawnPorts.push(Number(env.PORT));
          return { pid: spawnCount === 1 ? 202 : 203, exitCode: null };
        },
        waitForServerReadyImpl: async (url) => {
          if (url.endsWith(':5102')) throw new Error('replacement not ready');
        },
        getProcessGroupIdImpl: async (pid) => (
          Number(pid) === 202 || Number(pid) === 302 ? 44 :
          Number(pid) === 203 || Number(pid) === 303 ? 45 :
          Number(pid)
        ),
        killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
        terminateSpawnedChildImpl: async () => true,
        recordStackRuntimeUpdateImpl: async () => {},
        logger: { log() {}, warn() {}, error() {} },
      },
    );

    await assert.rejects(
      () => executor.restart({ generation: 32, changedDescriptors: ['server:prisma'] }),
      (error) => error?.message === 'replacement not ready'
        && error?.serverRestartFailure?.oldServerStopped === true
        && error?.serverRestartFailure?.serviceRestored === true,
    );
    assert.deepEqual(spawnPorts, [5102, 5101]);
    assert.deepEqual(flips, [5101]);
  });
});

test('proxy exclusiveDb restart keeps current-code recovery authoritative when its post-flip drain fails', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    const transitionEvents = [];
    const updates = [];
    const logs = [];
    let spawnCount = 0;
    const options = createExecutorOptions(serverDir, {
      proxyController: {
        enterMaintenance() { return { targetHost: '127.0.0.1', targetPort: 6101 }; },
        flipUpstream({ targetPort }) { calls.push(['flip', targetPort]); },
        drainConnections() { throw new Error('recovery drain failed'); },
      },
    });
    const executor = createDevServerReloadExecutor(options, {
      preflightDevServerRestartImpl: async () => {},
      waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
      pickNextFreeTcpPortImpl: async () => 5102,
      pmSpawnScriptImpl: async ({ env }) => {
        spawnCount += 1;
        calls.push(['spawn', Number(env.PORT), env.HAPPIER_STACK_MIGRATE_MODE]);
        return { pid: spawnCount === 1 ? 202 : 203, exitCode: null };
      },
      waitForServerReadyImpl: async (url) => {
        if (url.endsWith(':5102')) throw new Error('replacement not ready');
      },
      listListenPidsImpl: async () => [spawnCount === 0 ? 101 : spawnCount === 1 ? 302 : 303],
      getProcessGroupIdImpl: async (pid) => (
        Number(pid) === 101 ? 7 :
        Number(pid) === 202 || Number(pid) === 302 ? 44 :
        Number(pid) === 203 || Number(pid) === 303 ? 45 :
        Number(pid)
      ),
      killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
      recordStackRuntimeUpdateImpl: async (_path, patch) => updates.push(patch),
      logger: {
        log(message) {
          if (String(message).startsWith('{')) transitionEvents.push(JSON.parse(message));
        },
        error(message) { logs.push(message); },
      },
    });

    await assert.rejects(
      () => executor.restart({ generation: 24, changedDescriptors: ['server:prisma'] }),
      /recovery drain failed/,
    );

    assert.equal(spawnCount, 2);
    assert.equal(options.serverProcRef.current.pid, 203);
    assert.equal(updates.at(-1).ports.serverBackend, 5101);
    assert.deepEqual(
      transitionEvents
        .filter((event) => event.purpose === 'recovery')
        .map(({ event }) => event),
      [
        'replacement_spawned',
        'replacement_ready',
        'backend_activation_requested',
        'backend_activation_acknowledged',
        'maintenance_exited',
      ],
      'acknowledged recovery exits maintenance before fallible target draining',
    );
    assert.equal(logs.some((line) => /current-code recovery server is active/.test(line)), true);
  });
});

test('proxy exclusiveDb restart retains current-code recovery when its flip acknowledgement is unresolved', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const updates = [];
    const logs = [];
    let spawnCount = 0;
    const options = createExecutorOptions(serverDir, {
      proxyController: {
        enterMaintenance() { return { targetHost: '127.0.0.1', targetPort: 6101 }; },
        flipUpstream() { throw new Error('recovery flip response lost'); },
      },
    });
    const executor = createDevServerReloadExecutor(options, {
      preflightDevServerRestartImpl: async () => {},
      waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
      pickNextFreeTcpPortImpl: async () => 5102,
      pmSpawnScriptImpl: async () => ({ pid: ++spawnCount === 1 ? 202 : 203, exitCode: null }),
      waitForServerReadyImpl: async (url) => {
        if (url.endsWith(':5102')) throw new Error('replacement not ready');
      },
      listListenPidsImpl: async () => [spawnCount === 0 ? 101 : spawnCount === 1 ? 302 : 303],
      getProcessGroupIdImpl: async (pid) => (
        Number(pid) === 101 ? 7 :
        Number(pid) === 202 || Number(pid) === 302 ? 44 :
        Number(pid) === 203 || Number(pid) === 303 ? 45 :
        Number(pid)
      ),
      killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
      recordStackRuntimeUpdateImpl: async (_path, patch) => updates.push(patch),
      logger: { log() {}, error(message) { logs.push(message); } },
    });

    await assert.rejects(
      () => executor.restart({ generation: 25, changedDescriptors: ['server:prisma'] }),
      /recovery flip response lost/,
    );
    await assert.rejects(
      () => executor.restart({ generation: 26, changedDescriptors: ['server:prisma'] }),
      (error) => {
        assert.match(error.message, /provisional.*remains unresolved/i);
        assert.equal(error.serverRestartFailure?.oldServerStopped, true);
        assert.equal(error.serverRestartFailure?.activationCommitUnknown, true);
        return true;
      },
    );

    assert.equal(spawnCount, 2);
    assert.equal(options.serverProcRef.current.pid, 203);
    assert.equal(updates.at(-1).processes.serverDrainingPid, 303);
    assert.equal(logs.some((line) => /activation outcome is unresolved/.test(line)), true);
  });
});

test('proxy exclusiveDb restart records an unconfirmed current-code recovery child', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const updates = [];
    let spawnCount = 0;
    const executor = createDevServerReloadExecutor(
      createExecutorOptions(serverDir, {
        proxyController: {
          pid: process.pid,
          enterMaintenance() { return { targetHost: '127.0.0.1', targetPort: 6101 }; },
          flipUpstream() {},
          drainConnections() {},
        },
      }),
      {
        preflightDevServerRestartImpl: async () => {}, waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
        pickNextFreeTcpPortImpl: async () => 5102,
        pmSpawnScriptImpl: async () => ({ pid: ++spawnCount === 1 ? 202 : 203, exitCode: null }),
        waitForServerReadyImpl: async () => { throw new Error('not ready'); },
        listListenPidsImpl: async () => [101], getProcessGroupIdImpl: async (pid) => Number(pid),
        killProcessGroupOwnedByStackImpl: async (pid) => Number(pid) === 203 ? { killed: false } : { killed: true },
        terminateSpawnedChildImpl: async (child) => Number(child?.pid) !== 203,
        recordStackRuntimeUpdateImpl: async (_path, patch) => updates.push(patch),
        logger: { log() {}, error() {} },
      },
    );

    await assert.rejects(() => executor.restart({ changedDescriptors: ['server:prisma'] }), /provisional.*termination.*not.*confirmed/i);
    await assert.rejects(() => executor.restart({ changedDescriptors: ['server:prisma'] }), /provisional.*termination.*not.*confirmed/i);
    assert.equal(spawnCount, 2);
    assert.equal(updates.at(-1).processes.serverDrainingPid, 203);
  });
});

test('proxy exclusiveDb restart does not spawn while the old backend port remains occupied', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    const lifecycle = [];
    const proxy = {
      enterMaintenance(options) {
        calls.push(['maintenance', options]);
        return { targetHost: '127.0.0.1', targetPort: 6101 };
      },
      flipUpstream({ targetPort }) {
        calls.push(['flip', targetPort]);
      },
      drainConnections(args) {
        calls.push(['drain', args?.targetPort ?? null, args?.graceMs ?? null]);
      },
    };
    const executor = createDevServerReloadExecutor(
      createExecutorOptions(serverDir, { proxyController: proxy }),
      {
        preflightDevServerRestartImpl: async () => {},
        killProcessGroupOwnedByStackImpl: async (pid) => {
          calls.push(['kill', pid]);
          return { killed: true };
        },
        waitForTcpPortFreeImpl: async (port) => {
          calls.push(['wait-free', port]);
          return { status: 'occupied', reason: 'address-in-use' };
        },
        pmSpawnScriptImpl: async ({ env }) => {
          calls.push(['spawn', Number(env.PORT), env.HAPPIER_STACK_MIGRATE_MODE]);
          return { pid: 203, exitCode: null };
        },
        waitForServerReadyImpl: async (url) => {
          calls.push(['ready', url]);
        },
        listListenPidsImpl: async () => [101],
        getProcessGroupIdImpl: async (pid) => (
          Number(pid) === 101 ? 7 :
          Number(pid) === 203 || Number(pid) === 303 ? 45 :
          Number(pid)
        ),
        recordStackRuntimeUpdateImpl: async () => {},
        recordStackRuntimeServerLifecycleImpl: async (_path, transition) => {
          lifecycle.push(transition);
          if (transition.phase === 'unavailable') throw new Error('terminal projection unavailable');
        },
        logger: { log() {}, error() {} },
      }
    );

    await assert.rejects(
      () => restartThroughCoordinator(executor, { generation: 27, changedDescriptors: ['server:prisma'] }, { retryScheduled: false }),
      (error) => error?.code === 'ESERVERBACKENDPORTOCCUPIED',
    );

    assert.deepEqual(calls, [
      ['maintenance', {
        retryAfterMs: 2000,
        message: 'Server reload in progress',
      }],
      ['kill', 101],
      ['wait-free', 5101],
      ['maintenance', {
        retryAfterMs: 0,
        retryable: false,
        message: 'Server unavailable; edit or restart the stack.',
      }],
    ]);
    assert.deepEqual(lifecycle.map(({ phase }) => phase), ['replacing', 'maintenance', 'unavailable']);
    assert.deepEqual(lifecycle.at(-1), {
      phase: 'unavailable',
      plan: {
        generation: 27,
        mode: 'exclusiveDb',
        migrationMode: 'apply',
        reason: 'prisma_changed',
      },
      disposition: { code: 'post-stop' },
    });
  });
});

test('server executor renders retryability only from the coordinator committed disposition', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const lifecycle = [];
    const maintenance = [];
    const executor = createDevServerReloadExecutor(
      createExecutorOptions(serverDir, {
        proxyController: {
          enterMaintenance(options) { maintenance.push(options); },
        },
      }),
      {
        recordStackRuntimeServerLifecycleImpl: async (_path, transition) => lifecycle.push(transition),
        logger: { log() {}, error() {} },
      },
    );
    const error = Object.assign(new Error('replacement exited early'), {
      reloadRetryAfterMs: 250,
      serverRestartFailure: { oldServerStopped: true, stage: 'readiness' },
    });
    const plan = createDevServerReloadPlan({
      changedDescriptors: ['server:app'],
      generation: 9,
    });

    await executor.publishFailureDisposition({ error, plan, retryScheduled: true, retryAfterMs: 250 });
    await executor.publishFailureDisposition({ error, plan, retryScheduled: false, retryAfterMs: null });

    assert.deepEqual(lifecycle.map(({ phase }) => phase), ['retry-scheduled', 'unavailable']);
    assert.deepEqual(maintenance, [
      { retryAfterMs: 250, retryable: true, message: 'Server reload recovery pending' },
      { retryAfterMs: 0, retryable: false, message: 'Server unavailable; edit or restart the stack.' },
    ]);
  });
});

test('unannotated restart failure reports unavailable when the recorded backend process and listener are gone', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const lifecycle = [];
    const maintenance = [];
    const executor = createDevServerReloadExecutor(
      createExecutorOptions(serverDir, {
        proxyController: {
          enterMaintenance(options) { maintenance.push(options); },
        },
      }),
      {
        isPidAliveImpl: () => false,
        listListenPidsWithStatusImpl: async () => ({ status: 'ok', supported: true, pids: [] }),
        recordStackRuntimeServerLifecycleImpl: async (_path, transition) => lifecycle.push(transition),
        logger: { log() {}, error() {} },
      },
    );
    const plan = createDevServerReloadPlan({
      changedDescriptors: ['server:app'],
      generation: 10,
    });

    await executor.publishFailureDisposition({
      error: new Error('restart failed before failure annotation'),
      plan,
      retryScheduled: false,
      retryAfterMs: null,
    });

    assert.equal(lifecycle.at(-1)?.phase, 'unavailable');
    assert.deepEqual(maintenance.at(-1), {
      retryAfterMs: 0,
      retryable: false,
      message: 'Server unavailable; edit or restart the stack.',
    });
  });
});

test('server executor observes the active child and disarms observation on close', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const child = Object.assign(new EventEmitter(), { pid: 101, exitCode: null, signalCode: null });
    const options = createExecutorOptions(serverDir, { serverProcRef: { current: child } });
    const executor = createDevServerReloadExecutor(options, { logger: { log() {}, error() {} } });
    const exits = [];

    executor.setUnexpectedExitHandler((event) => exits.push(event));
    child.exitCode = 1;
    child.emit('exit', 1, null);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(exits.length, 1);
    assert.equal(exits[0].pid, 101);
    assert.equal(exits[0].code, 1);
    executor.setUnexpectedExitHandler(null);
    assert.equal(child.listenerCount('exit'), 0);
  });
});

test('planned incumbent exit is ignored while a later activated replacement exit is observed', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const oldServer = Object.assign(new EventEmitter(), { pid: 101, exitCode: null, signalCode: null });
    const replacement = Object.assign(new EventEmitter(), { pid: 202, exitCode: null, signalCode: null });
    const options = createExecutorOptions(serverDir, {
      serverProcRef: { current: oldServer },
      proxyController: {
        pid: 91,
        async enterMaintenance() { return { targetHost: '127.0.0.1', targetPort: 6101 }; },
        async flipUpstream() {},
        async drainConnections() {},
      },
    });
    const executor = createDevServerReloadExecutor(options, {
      preflightDevServerRestartImpl: async () => {},
      waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
      pickNextFreeTcpPortImpl: async () => 5102,
      pmSpawnScriptImpl: async () => replacement,
      waitForServerReadyImpl: async () => {},
      listListenPidsImpl: async (port) => Number(port) === 5101 ? [101] : [302],
      getProcessGroupIdImpl: async (pid) => Number(pid) === 302 ? 202 : Number(pid),
      killProcessGroupOwnedByStackImpl: async () => {
        oldServer.exitCode = 0;
        oldServer.emit('exit', 0, null);
        return { killed: true };
      },
      recordStackRuntimeServerActivationImpl: async () => {},
      logger: { log() {}, error() {} },
    });
    const exits = [];
    executor.setUnexpectedExitHandler((event) => exits.push(event));

    await executor.restart({ generation: 12, changedDescriptors: ['server:app'] });
    assert.deepEqual(exits, [], 'planned incumbent shutdown must not request recovery');

    replacement.exitCode = 1;
    replacement.emit('exit', 1, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(exits.length, 1);
    assert.equal(exits[0].pid, 202);
  });
});

test('proxy exclusiveDb restart never starts recovery while failed replacement cleanup is unconfirmed', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    const updates = [];
    const lifecycle = [];
    const executor = createDevServerReloadExecutor(
      createExecutorOptions(serverDir, {
        proxyController: {
          pid: process.pid,
          enterMaintenance() {
            calls.push(['maintenance']);
            return { targetHost: '127.0.0.1', targetPort: 6101 };
          },
          flipUpstream({ targetPort }) { calls.push(['flip', targetPort]); },
          drainConnections(args) { calls.push(['drain', args?.targetPort ?? null]); },
        },
      }),
      {
        preflightDevServerRestartImpl: async () => {},
        waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
        pickNextFreeTcpPortImpl: async () => 5102,
        pmSpawnScriptImpl: async ({ env }) => {
          calls.push(['spawn', Number(env.PORT), env.HAPPIER_STACK_MIGRATE_MODE]);
          return { pid: 202, exitCode: null };
        },
        waitForServerReadyImpl: async () => { throw new Error('replacement not ready'); },
        listListenPidsImpl: async () => [101],
        getProcessGroupIdImpl: async (pid) => Number(pid),
        killProcessGroupOwnedByStackImpl: async (pid) => {
          calls.push(['owned-kill', pid]);
          return Number(pid) === 101 ? { killed: true } : { killed: false };
        },
        terminateSpawnedChildImpl: async () => {
          calls.push(['fallback-kill']);
          return false;
        },
        recordStackRuntimeUpdateImpl: async (_path, patch) => updates.push(patch),
        recordStackRuntimeServerLifecycleImpl: async (_path, transition) => lifecycle.push(transition),
        logger: { log() {}, error() {} },
      },
    );

    await assert.rejects(
      () => restartThroughCoordinator(executor, { generation: 22, changedDescriptors: ['server:prisma'] }),
      /provisional.*termination.*not.*confirmed/i,
    );
    await assert.rejects(
      () => restartThroughCoordinator(executor, { generation: 23, changedDescriptors: ['server:prisma'] }),
      /provisional.*termination.*not.*confirmed/i,
    );

    assert.equal(calls.filter(([name]) => name === 'spawn').length, 1);
    assert.deepEqual(calls, [
      ['maintenance'],
      ['owned-kill', 101],
      ['spawn', 5102, 'always'],
      ['owned-kill', 202],
      ['fallback-kill'],
    ]);
    assert.equal(updates.at(-1).processes.serverDrainingPid, 202);
    assert.deepEqual(lifecycle.map(({ phase }) => phase), ['replacing', 'maintenance', 'blocked', 'replacing', 'blocked']);
  });
});

test('proxy exclusiveDb restart never starts recovery after replacement transport commit', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    const updates = [];
    const logs = [];
    const options = createExecutorOptions(serverDir, {
      proxyController: {
        pid: process.pid,
        enterMaintenance() {
          calls.push(['maintenance']);
          return { targetHost: '127.0.0.1', targetPort: 6101 };
        },
        flipUpstream({ targetPort }) { calls.push(['flip', targetPort]); },
        drainConnections(args) {
          calls.push(['drain', args?.targetPort ?? null]);
          throw new Error('maintenance drain failed');
        },
      },
    });
    let spawnCount = 0;
    const executor = createDevServerReloadExecutor(options, {
      preflightDevServerRestartImpl: async () => {},
      waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
      pickNextFreeTcpPortImpl: async () => 5102,
      pmSpawnScriptImpl: async ({ env }) => {
        spawnCount += 1;
        calls.push(['spawn', Number(env.PORT), env.HAPPIER_STACK_MIGRATE_MODE]);
        return { pid: spawnCount === 1 ? 202 : 203, exitCode: null };
      },
      waitForServerReadyImpl: async () => {},
      listListenPidsImpl: async () => [spawnCount === 0 ? 101 : 302],
      getProcessGroupIdImpl: async (pid) => Number(pid) === 101 ? 7 : 44,
      killProcessGroupOwnedByStackImpl: async (pid) => {
        calls.push(['kill', pid]);
        return { killed: true };
      },
      recordStackRuntimeUpdateImpl: async (_path, patch) => updates.push(patch),
      logger: { log() {}, error(message) { logs.push(message); } },
    });

    await assert.rejects(
      () => executor.restart({ generation: 23, changedDescriptors: ['server:prisma'] }),
      /maintenance drain failed/,
    );

    assert.equal(spawnCount, 1);
    assert.equal(options.serverProcRef.current.pid, 202);
    assert.equal(updates.at(-1).ports.serverBackend, 5102);
    assert.equal(logs.some((line) => /committed at the proxy.*replacement remains active/.test(line)), true);
  });
});

test('proxy exclusiveDb restart recovers when failed flip observation proves the replacement was not activated', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    const updates = [];
    const logs = [];
    const maintenanceCalls = [];
    let flipCount = 0;
    let upstream = 6101;
    const options = createExecutorOptions(serverDir, {
      proxyController: {
        pid: process.pid,
        enterMaintenance(options) { maintenanceCalls.push(options ?? {}); return { targetHost: '127.0.0.1', targetPort: 6101 }; },
        flipUpstream({ targetPort }) {
          calls.push(['flip']);
          flipCount += 1;
          if (flipCount === 1) throw new Error('flip response lost');
          upstream = Number(targetPort);
        },
        getUpstream() { return { targetHost: '127.0.0.1', targetPort: upstream }; },
        drainConnections() {},
      },
    });
    let spawnCount = 0;
    const executor = createDevServerReloadExecutor(options, {
      preflightDevServerRestartImpl: async () => {}, waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
      pickNextFreeTcpPortImpl: async () => 5102,
      pmSpawnScriptImpl: async ({ env }) => {
        spawnCount += 1;
        calls.push(['spawn', Number(env.PORT), env.HAPPIER_STACK_MIGRATE_MODE]);
        return { pid: 202, exitCode: null };
      },
      waitForServerReadyImpl: async () => {}, listListenPidsImpl: async () => [spawnCount === 0 ? 101 : 302],
      getProcessGroupIdImpl: async (pid) => Number(pid) === 101 ? 7 : 44,
      killProcessGroupOwnedByStackImpl: async (pid) => { calls.push(['kill', pid]); return { killed: true }; },
      recordStackRuntimeUpdateImpl: async (_path, patch) => updates.push(patch),
      logger: { log() {}, error(message) { logs.push(message); } },
    });

    await assert.rejects(() => restartThroughCoordinator(executor, { changedDescriptors: ['server:prisma'] }), /flip response lost/);
    assert.equal(spawnCount, 2);
    assert.equal(options.serverProcRef.current.pid, 202);
    assert.equal(upstream, 5101);
    assert.equal(logs.some((line) => /activation outcome is unresolved/.test(line)), false);
    assert.equal(maintenanceCalls.length, 1);
  });
});

test('proxy exclusiveDb restart preserves replacement when flip committed before acknowledgement was lost', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let spawnCount = 0;
    let upstream = 6101;
    const options = createExecutorOptions(serverDir, { proxyController: {
      pid: process.pid,
      enterMaintenance() { upstream = 6101; return { targetHost: '127.0.0.1', targetPort: 6101 }; },
      flipUpstream({ targetPort }) { upstream = Number(targetPort); throw new Error('flip response lost'); },
      getUpstream() { return { targetHost: '127.0.0.1', targetPort: upstream }; },
      drainConnections() {},
    } });
    const executor = createDevServerReloadExecutor(options, {
      preflightDevServerRestartImpl: async () => {}, waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
      pickNextFreeTcpPortImpl: async () => 5102,
      pmSpawnScriptImpl: async () => ({ pid: 202 + spawnCount++, exitCode: null, signalCode: null }),
      waitForServerReadyImpl: async () => {}, listListenPidsImpl: async (port) => Number(port) === 5101 ? [101] : [302],
      getProcessGroupIdImpl: async (pid) => Number(pid) === 101 ? 7 : 44,
      killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
      recordStackRuntimeUpdateImpl: async () => {}, logger: { log() {}, error() {} },
    });
    await assert.rejects(() => executor.restart({ generation: 31, changedDescriptors: ['server:prisma'] }),
      (error) => error?.serverRestartFailure?.transportCommitted === true);
    assert.equal(upstream, 5102);
    assert.equal(options.serverProcRef.current.pid, 202);
    assert.equal(spawnCount, 1);
  });
});

test('proxy exclusiveDb restart preserves the ambiguity fence when authoritative upstream observation fails', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let spawnCount = 0;
    const maintenanceCalls = [];
    const logs = [];
    const options = createExecutorOptions(serverDir, { proxyController: {
      pid: process.pid,
      enterMaintenance(args) { maintenanceCalls.push(args ?? {}); return { targetHost: '127.0.0.1', targetPort: 6101 }; },
      flipUpstream() { throw new Error('flip response lost'); },
      getUpstream() { throw new Error('proxy observation unavailable'); },
      drainConnections() {},
    } });
    const executor = createDevServerReloadExecutor(options, {
      preflightDevServerRestartImpl: async () => {}, waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
      pickNextFreeTcpPortImpl: async () => 5102,
      pmSpawnScriptImpl: async () => ({ pid: 202 + spawnCount++, exitCode: null, signalCode: null }),
      waitForServerReadyImpl: async () => {}, listListenPidsImpl: async (port) => Number(port) === 5101 ? [101] : [302],
      getProcessGroupIdImpl: async (pid) => Number(pid) === 101 ? 7 : 44,
      killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
      recordStackRuntimeUpdateImpl: async () => {}, logger: { log() {}, error(message) { logs.push(String(message)); } },
    });
    await assert.rejects(() => executor.restart({ generation: 32, changedDescriptors: ['server:prisma'] }), (error) => {
      assert.equal(error.serverRestartFailure?.activationCommitUnknown, true);
      assert.equal(error.serverRestartFailure?.activationTargetObserved, 'inconclusive');
      assert.equal(error.reloadRetryAfterMs, undefined);
      return true;
    });
    await assert.rejects(() => executor.restart({ generation: 33, changedDescriptors: ['server:prisma'] }), /remains unresolved/i);
    assert.equal(spawnCount, 1);
    assert.equal(options.serverProcRef.current.pid, 101);
    assert.equal(maintenanceCalls.length, 1);
    assert.equal(logs.some((line) => /activation outcome is unresolved/.test(line)), true);
  });
});

test('proxy exclusiveDb restart keeps old backend serving when safe-stop proof fails before old backend is stopped', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    const lifecycle = [];
    const proxy = {
      enterMaintenance() {
        calls.push(['maintenance']);
      },
      flipUpstream({ targetPort }) {
        calls.push(['flip', targetPort]);
      },
      drainConnections(args) {
        calls.push(['drain', args?.targetPort ?? null, args?.graceMs ?? null]);
      },
    };

    const executor = createDevServerReloadExecutor(
      createExecutorOptions(serverDir, { proxyController: proxy }),
      {
        preflightDevServerRestartImpl: async () => {},
        listListenPidsImpl: async () => [],
        getProcessGroupIdImpl: async (pid) => Number(pid),
        isTcpPortFreeImpl: async () => false,
        isPidAliveImpl: () => true,
        recordStackRuntimeServerLifecycleImpl: async (_path, transition) => lifecycle.push(transition),
        logger: { log() {}, error() {} },
      }
    );

    await assert.rejects(
      () => restartThroughCoordinator(executor, { generation: 28, changedDescriptors: ['server:prisma'] }),
      (error) => /not provably stack-owned/.test(String(error?.message))
        && error?.reloadRetryAfterMs === undefined,
    );

    assert.deepEqual(calls, []);
    assert.deepEqual(lifecycle.map(({ phase }) => phase), ['replacing', 'blocked']);
    assert.equal(lifecycle.at(-1).disposition.code, 'restart_failed');
  });
});

test('proxy exclusiveDb restart retries transient inconclusive ownership within one bounded precheck', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    let attempts = 0;
    const proxy = {
      async enterMaintenance() {
        calls.push(['maintenance']);
        return { targetHost: '127.0.0.1', targetPort: 6101 };
      },
      async flipUpstream({ targetPort }) { calls.push(['flip', targetPort]); },
      async drainConnections(args) { calls.push(['drain', args?.targetPort ?? null]); },
    };
    const executor = createDevServerReloadExecutor(
      createExecutorOptions(serverDir, { proxyController: proxy }),
      {
        preflightDevServerRestartImpl: async () => {},
        listListenPidsImpl: async () => {
          attempts += 1;
          if (attempts < 3) {
            const error = new Error('listener discovery timed out');
            error.code = 'ELISTENERDISCOVERYINCONCLUSIVE';
            error.observation = { status: 'timeout', supported: true, pids: [], reason: 'listener-discovery-timeout' };
            throw error;
          }
          return [101];
        },
        getProcessGroupIdImpl: async (pid) => Number(pid),
        killProcessGroupOwnedByStackImpl: async () => ({ killed: false }),
        listenerOwnershipTimeoutMs: 250,
        listenerOwnershipRetryDelayMs: 0,
        logger: { log() {}, error() {} },
      },
    );

    await assert.rejects(() => executor.restart(), /could not be stopped safely/);
    assert.equal(attempts, 3);
    assert.deepEqual(calls, [
      ['maintenance'],
      ['flip', 5101],
      ['drain', 6101],
    ]);
  });
});
