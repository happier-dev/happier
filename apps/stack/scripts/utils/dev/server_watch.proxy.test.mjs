import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createDevServerReloadDescriptors,
  createDevServerReloadExecutor,
  createDevServerReloadPlan,
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
    serverEnv: {
      HAPPIER_DB_PROVIDER: 'sqlite',
      HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: '1200ms',
      PORT: '5101',
    },
    runtimeStatePath: join(serverDir, 'stack.runtime.json'),
    stackName: 'proxy-test',
    envPath: join(serverDir, 'env'),
    children: [],
    serverProcRef: { current: { pid: 101, exitCode: null } },
    isShuttingDown: () => false,
    ...overrides,
  };
}

test('failed proxy activation acknowledgement fences a second restart while replacement remains alive', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let spawnCount = 0;
    const options = executorOptions(serverDir, {
      proxyController: {
        pid: process.pid,
        async enterMaintenance() { return { targetHost: '127.0.0.1', targetPort: 6101 }; },
        async flipUpstream() { throw new Error('flip response lost'); },
        getUpstream() { return { targetHost: '127.0.0.1', targetPort: 6201 }; },
        async drainConnections() {},
      },
    });
    const executor = createDevServerReloadExecutor(options, {
      ensureSourceServerWorkspacePackagesBuiltImpl: async () => {},
      preflightDevServerRestartImpl: async () => {},
      waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
      pickNextFreeTcpPortImpl: async () => 5102,
      pmSpawnScriptImpl: async () => ({ pid: 202 + spawnCount++, exitCode: null, signalCode: null }),
      waitForServerReadyImpl: async () => {},
      listListenPidsImpl: async (port) => Number(port) === 5101 ? [101] : [302],
      getProcessGroupIdImpl: async (pid) => Number(pid) === 101 ? 101 : 202,
      killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
      isPidAliveImpl: () => true,
      logger: { log() {}, error() {} },
    });

    await assert.rejects(() => executor.restart({ generation: 1, changedDescriptors: ['server:prisma'] }),
      (error) => error?.serverRestartFailure?.activationCommitUnknown === true && error.reloadRetryAfterMs === undefined);
    await assert.rejects(() => executor.restart({ generation: 2, changedDescriptors: ['server:prisma'] }),
      /remains unresolved/i);
    assert.equal(spawnCount, 1);
  });
});

test('committed-before-lost proxy acknowledgement preserves replacement upstream and identity', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let spawnCount = 0;
    let upstream = 6101;
    const options = executorOptions(serverDir, { proxyController: {
      pid: process.pid,
      async enterMaintenance() { upstream = 6101; return { targetHost: '127.0.0.1', targetPort: 6101 }; },
      async flipUpstream({ targetPort }) { upstream = Number(targetPort); throw new Error('flip response lost'); },
      getUpstream() { return { targetHost: '127.0.0.1', targetPort: upstream }; },
      async drainConnections() {},
    } });
    const executor = createDevServerReloadExecutor(options, {
      ensureSourceServerWorkspacePackagesBuiltImpl: async () => {}, preflightDevServerRestartImpl: async () => {},
      waitForTcpPortFreeImpl: async () => ({ status: 'free' }), pickNextFreeTcpPortImpl: async () => 5102,
      pmSpawnScriptImpl: async () => ({ pid: 202 + spawnCount++, exitCode: null, signalCode: null }),
      waitForServerReadyImpl: async () => {}, listListenPidsImpl: async (port) => Number(port) === 5101 ? [101] : [302],
      getProcessGroupIdImpl: async (pid) => Number(pid) === 101 ? 101 : 202,
      killProcessGroupOwnedByStackImpl: async () => ({ killed: true }), logger: { log() {}, error() {} },
    });
    await assert.rejects(() => executor.restart({ generation: 2, changedDescriptors: ['server:prisma'] }),
      (error) => error?.serverRestartFailure?.transportCommitted === true);
    assert.equal(upstream, 5102);
    assert.equal(options.serverProcRef.current.pid, 202);
    assert.equal(spawnCount, 1);
  });
});

test('failed authoritative upstream observation preserves ambiguity without retarget, retry, or second spawn', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let spawnCount = 0;
    const maintenanceCalls = [];
    const logs = [];
    const options = executorOptions(serverDir, { proxyController: {
      pid: process.pid,
      async enterMaintenance(args) { maintenanceCalls.push(args ?? {}); return { targetHost: '127.0.0.1', targetPort: 6101 }; },
      async flipUpstream() { throw new Error('flip response lost'); },
      getUpstream() { throw new Error('proxy observation unavailable'); },
      async drainConnections() {},
    } });
    const executor = createDevServerReloadExecutor(options, {
      ensureSourceServerWorkspacePackagesBuiltImpl: async () => {}, preflightDevServerRestartImpl: async () => {},
      waitForTcpPortFreeImpl: async () => ({ status: 'free' }), pickNextFreeTcpPortImpl: async () => 5102,
      pmSpawnScriptImpl: async () => ({ pid: 202 + spawnCount++, exitCode: null, signalCode: null }),
      waitForServerReadyImpl: async () => {}, listListenPidsImpl: async (port) => Number(port) === 5101 ? [101] : [302],
      getProcessGroupIdImpl: async (pid) => Number(pid) === 101 ? 101 : 202,
      killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
      logger: { log() {}, error(message) { logs.push(String(message)); } },
    });
    await assert.rejects(() => executor.restart({ generation: 3, changedDescriptors: ['server:prisma'] }), (error) => {
      assert.equal(error.serverRestartFailure?.activationCommitUnknown, true);
      assert.equal(error.serverRestartFailure?.activationTargetObserved, 'inconclusive');
      assert.equal(error.reloadRetryAfterMs, undefined);
      return true;
    });
    await assert.rejects(() => executor.restart({ generation: 4, changedDescriptors: ['server:prisma'] }), /remains unresolved/i);
    assert.equal(spawnCount, 1);
    assert.equal(options.serverProcRef.current.pid, 101);
    assert.equal(maintenanceCalls.length, 1);
    assert.equal(logs.some((line) => /restart failed after stopping|activation/i.test(line)), true);
  });
});

test('authoritative non-candidate upstream cleans the provisional child and admits a later restart', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let spawnCount = 0;
    let incumbentAlive = true;
    const killed = [];
    const options = executorOptions(serverDir, { proxyController: {
      pid: process.pid,
      async enterMaintenance() { return { targetHost: '127.0.0.1', targetPort: 6101 }; },
      async flipUpstream() { throw new Error('flip response lost'); },
      getUpstream() { return { targetHost: '127.0.0.1', targetPort: 6101 }; },
      async drainConnections() {},
    } });
    const executor = createDevServerReloadExecutor(options, {
      ensureSourceServerWorkspacePackagesBuiltImpl: async () => {},
      preflightDevServerRestartImpl: async () => {},
      waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
      pickNextFreeTcpPortImpl: async () => 5102 + spawnCount,
      pmSpawnScriptImpl: async () => ({ pid: 202 + spawnCount++, exitCode: null, signalCode: null }),
      waitForServerReadyImpl: async () => {},
      listListenPidsImpl: async (port) => Number(port) === 5101 && incumbentAlive
        ? [101]
        : [201 + spawnCount],
      getProcessGroupIdImpl: async (pid) => Number(pid),
      killProcessGroupOwnedByStackImpl: async (pid) => {
        killed.push(Number(pid));
        if (Number(pid) === 101) incumbentAlive = false;
        return { killed: true };
      },
      isPidAliveImpl: (pid) => Number(pid) === 101 ? incumbentAlive : true,
      logger: { log() {}, error() {} },
    });

    await assert.rejects(
      () => executor.restart({ generation: 5, changedDescriptors: ['server:prisma'] }),
      (error) => error?.serverRestartFailure?.activationCommitUnknown !== true,
    );
    await assert.rejects(
      () => executor.restart({ generation: 6, changedDescriptors: ['server:prisma'] }),
      (error) => !/remains unresolved/i.test(String(error?.message ?? '')),
    );

    assert.equal(spawnCount, 2);
    assert.deepEqual(killed.filter((pid) => pid >= 202), [202, 203]);
  });
});

test('migration admission uses conclusive reload generation descriptors and otherwise applies', () => {
  assert.equal(createDevServerReloadPlan({
    changedDescriptors: ['server:app'],
    generation: 7,
  }).migrationMode, 'skip');
  assert.deepEqual(createDevServerReloadPlan({
    changedDescriptors: ['shared:protocol', 'daemon:cli'],
    generation: 8,
  }), {
    mode: 'exclusiveDb',
    migrationMode: 'skip',
    generation: 8,
    reason: 'app_only_descriptor_unchanged',
  });
  assert.equal(createDevServerReloadPlan({
    changedDescriptors: ['server:prisma'],
    generation: 9,
  }).migrationMode, 'apply');
  assert.equal(createDevServerReloadPlan({
    changedDescriptors: ['server:app'],
  }).migrationMode, 'apply');
  assert.equal(createDevServerReloadPlan({
    changedDescriptors: ['server:unknown'],
    generation: 10,
  }).migrationMode, 'apply');
  assert.equal(createDevServerReloadPlan({
    changedDescriptors: ['shared:protocol', 'migration:unknown'],
    generation: 11,
  }).migrationMode, 'apply');
  assert.deepEqual(createDevServerReloadPlan({
    changedDescriptors: ['shared:protocol', 'daemon:cli'],
    descriptorEvidenceConclusive: false,
    generation: 12,
  }), {
    mode: 'exclusiveDb',
    migrationMode: 'apply',
    generation: 12,
    reason: 'migration_evidence_inconclusive',
  });
});

test('reload build delegates prerequisite admission once to validation and leaves the incumbent running on failure', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const transitionEvents = [];
    const calls = [];
    let preflightInput = null;
    const executor = createDevServerReloadExecutor(
      executorOptions(serverDir),
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

for (const observation of [
  { status: 'timeout', supported: true, pids: [], reason: 'listener-discovery-timeout' },
  { status: 'error', supported: true, pids: [], reason: 'listener-discovery-error' },
  { status: 'unsupported', supported: false, pids: [], reason: 'missing-listener-discovery-command' },
]) {
  test(`exclusive reload classifies ${observation.status} listener evidence without destructive mutation`, async (t) => {
    await withTempServerDir(t, async (serverDir) => {
      const calls = [];
      const incumbent = { pid: 101, exitCode: null };
      const serverProcRef = { current: incumbent };
      const activations = [];
      const executor = createDevServerReloadExecutor(
        executorOptions(serverDir, {
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
          listListenPidsWithStatusImpl: async () => observation,
          getProcessGroupIdImpl: async () => null,
          isPidAliveImpl: () => true,
          killProcessGroupOwnedByStackImpl: async () => {
            calls.push('kill');
            return { killed: true };
          },
          recordStackRuntimeServerActivationImpl: async (_path, activation) => activations.push(activation),
          logger: { log() {}, error() {} },
        },
      );

      await assert.rejects(
        () => executor.restart({ generation: 1, changedDescriptors: ['server:prisma'] }),
        (error) => error?.code === 'ELISTENERDISCOVERYINCONCLUSIVE'
          && error?.observation?.status === observation.status
          && error?.reloadRetryAfterMs === (observation.status === 'unsupported' ? undefined : 250),
      );

      assert.deepEqual(calls, []);
      assert.equal(serverProcRef.current, incumbent);
      assert.deepEqual(activations, []);
    });
  });
}

test('real app and Prisma descriptor changes select migrations independently', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const sourcesDir = join(serverDir, 'sources');
    const prismaDir = join(serverDir, 'prisma');
    await mkdir(sourcesDir, { recursive: true });
    await mkdir(prismaDir, { recursive: true });
    await writeFile(join(sourcesDir, 'start.ts'), 'export const app = 1;\n');
    await writeFile(join(prismaDir, 'schema.prisma'), 'model A { id Int @id }\n');

    let onChange = null;
    let readWatcherSignature = null;
    const plans = [];
    const coordinator = startDevReloadCoordinator({
      descriptors: createDevServerReloadDescriptors({ serverDir }),
      executors: [{
        target: 'server',
        createPlan(context) {
          const plan = createDevServerReloadPlan(context);
          plans.push({ plan, changedDescriptors: context.changedDescriptors });
          return plan;
        },
        async build() {},
        async restart() {},
      }],
      logger: { log() {}, warn() {}, error() {} },
    }, {
      watchDebouncedImpl: ({ onChange: handler, readSignature }) => {
        onChange = handler;
        readWatcherSignature = readSignature;
        return { close() {} };
      },
    });
    t.after(() => coordinator?.close?.());

    await readWatcherSignature();
    await writeFile(join(prismaDir, 'schema.prisma'), 'model A { id Int @id; next Int? }\n');
    await onChange();
    await writeFile(join(sourcesDir, 'start.ts'), 'export const app = 22;\n');
    await onChange();

    assert.deepEqual(plans, [
      {
        changedDescriptors: ['server:prisma'],
        plan: {
          mode: 'exclusiveDb',
          migrationMode: 'apply',
          generation: 1,
          reason: 'prisma_changed',
        },
      },
      {
        changedDescriptors: ['server:app'],
        plan: {
          mode: 'exclusiveDb',
          migrationMode: 'skip',
          generation: 2,
          reason: 'app_only_descriptor_unchanged',
        },
      },
    ]);
  });
});


test('proxy exclusiveDb restart enters maintenance, swaps backend, flips upstream, and records runtime', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    const transitionEvents = [];
    const updates = [];
    const lifecycle = [];
    const oldServer = { pid: 101, exitCode: null };
    const proxy = {
      pid: process.pid,
      async enterMaintenance({ retryAfterMs }) {
        calls.push(['maintenance', retryAfterMs]);
        return { targetHost: '127.0.0.1', targetPort: 6101 };
      },
      async flipUpstream({ targetPort }) {
        calls.push(['flip-request', targetPort]);
        await Promise.resolve();
        calls.push(['flip-ack', targetPort]);
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
        killProcessGroupOwnedByStackImpl: async (pid, options) => {
          if (Number(pid) === 101) {
            assert.equal(getSpawnedProcessPlannedExitReason(oldServer), 'dev-reload');
            assert.equal(options.graceMs, 1450);
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
          calls.push(['spawn', Number(env.PORT), env.HAPPIER_STACK_MIGRATE_MODE]);
          return { pid: 202, exitCode: null };
        },
        waitForServerReadyImpl: async (url) => {
          calls.push(['ready', url]);
        },
        listListenPidsImpl: async (port) => (Number(port) === 5101 ? [101] : [302]),
        isPidAliveImpl: () => true,
        getProcessGroupIdImpl: async (pid) => (
          Number(pid) === 101 ? 101 :
          Number(pid) === 202 || Number(pid) === 302 ? 202 :
          Number(pid)
        ),
        recordStackRuntimeServerActivationImpl: async (_path, activation) => {
          updates.push(activation);
        },
        recordStackRuntimeServerLifecycleImpl: async (_path, transition) => {
          lifecycle.push(transition);
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
      },
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
      ['drain', { targetHost: '127.0.0.1', targetPort: 6101, graceMs: 2000 }],
      ['drain', { targetHost: '127.0.0.1', targetPort: 5101, graceMs: 2000 }],
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
    assert.deepEqual(lifecycle, [
      {
        phase: 'replacing',
        plan: {
          mode: 'exclusiveDb',
          migrationMode: 'skip',
          generation: 7,
          reason: 'app_only_descriptor_unchanged',
        },
      },
      {
        phase: 'maintenance',
        plan: {
          mode: 'exclusiveDb',
          migrationMode: 'skip',
          generation: 7,
          reason: 'app_only_descriptor_unchanged',
        },
      },
    ]);
    assert.deepEqual(updates, [
      {
        listenerPid: 302,
        wrapperPid: 202,
        stablePort: 4101,
        backendPort: 5102,
        proxyPid: process.pid,
        drainingPid: null,
        mode: 'proxy',
        restartMode: 'exclusiveDb',
        reloadGeneration: 7,
      },
    ]);
  });
});

test('maintenance lifecycle publication failure restores the incumbent before any destructive stop', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const options = executorOptions(serverDir);
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
      ensureSourceServerWorkspacePackagesBuiltImpl: async () => {},
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
    const options = executorOptions(serverDir);
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
      ensureSourceServerWorkspacePackagesBuiltImpl: async () => {},
      preflightDevServerRestartImpl: async () => {},
      listListenPidsImpl: async (port) => Number(port) === 5101 ? [101] : [202],
      getProcessGroupIdImpl: async (pid) => Number(pid),
      killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
      waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
      pickNextFreeTcpPortImpl: async () => 5102,
      pmSpawnScriptImpl: async () => replacement,
      waitForServerReadyImpl: async () => {},
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
    const options = executorOptions(serverDir);
    let revalidations = 0;
    const activations = [];
    const executor = createDevServerReloadExecutor(options, {
      ensureSourceServerWorkspacePackagesBuiltImpl: async () => {},
      preflightDevServerRestartImpl: async () => {},
      listListenPidsImpl: async (port) => Number(port) === 5101 ? [101] : [202],
      getProcessGroupIdImpl: async (pid) => Number(pid),
      killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
      waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
      pmSpawnScriptImpl: async () => replacement,
      waitForServerReadyImpl: async () => {},
      recordStackRuntimeServerActivationImpl: async (_path, activation) => activations.push(activation),
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

test('proxy post-flip drain failure keeps the committed replacement authoritative and blocks without retry authorization', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const lifecycle = [];
    const transitionEvents = [];
    const drainPorts = [];
    const flipPorts = [];
    const killPids = [];
    const oldServer = { pid: 101, exitCode: null };
    const replacement = { pid: 202, exitCode: null };
    const serverProcRef = { current: oldServer };
    const readinessPhases = [];
    const executor = createDevServerReloadExecutor(
      executorOptions(serverDir, {
        serverProcRef,
        proxyController: {
          pid: process.pid,
          async enterMaintenance() {
            return { targetHost: '127.0.0.1', targetPort: 6101 };
          },
          flipUpstream({ targetPort }) {
            flipPorts.push(Number(targetPort));
          },
          async drainConnections({ targetPort }) {
            drainPorts.push(Number(targetPort));
            if (Number(targetPort) === 6101) throw new Error('old target drain unavailable');
          },
        },
      }),
      {
        ensureSourceServerWorkspacePackagesBuiltImpl: async () => {},
        preflightDevServerRestartImpl: async () => {},
        killProcessGroupOwnedByStackImpl: async (pid) => {
          killPids.push(Number(pid));
          return { killed: true };
        },
        waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
        pickNextFreeTcpPortImpl: async () => 5102,
        pmSpawnScriptImpl: async ({ options }) => {
          options?.onLine?.({ stream: 'stdout', line: '{"happierStackTransition":"migration_started"}' });
          options?.onLine?.({ stream: 'stdout', line: '{"happierStackTransition":"migration_completed"}' });
          return replacement;
        },
        waitForServerReadyImpl: async (_url, options) => {
          readinessPhases.push(options?.startupDeadline?.getPhase());
        },
        listListenPidsImpl: async (port) => (Number(port) === 5101 ? [101] : [302]),
        isPidAliveImpl: () => true,
        getProcessGroupIdImpl: async (pid) => (
          Number(pid) === 101 ? 101 : Number(pid) === 202 || Number(pid) === 302 ? 202 : Number(pid)
        ),
        recordStackRuntimeServerActivationImpl: async () => {},
        recordStackRuntimeServerLifecycleImpl: async (_path, transition) => {
          lifecycle.push(transition);
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
      () => restartThroughCoordinator(executor, { generation: 8, changedDescriptors: ['server:prisma'] }),
      (error) => {
        assert.match(error?.message ?? '', /old target drain unavailable/);
        assert.equal(error?.serverRestartFailure?.kind, 'post_commit');
        assert.equal(error?.serverRestartFailure?.transportCommitted, true);
        assert.equal(error?.serverRestartFailure?.serviceRestored, true);
        assert.equal(error?.reloadRetryAfterMs, undefined);
        return true;
      },
    );

    assert.equal(serverProcRef.current, replacement);
    assert.deepEqual(readinessPhases, ['readiness']);
    assert.deepEqual(flipPorts, [5102]);
    assert.deepEqual(killPids, [101], 'only the retired server may receive destructive authorization');
    assert.deepEqual(drainPorts, [6101], 'the authoritative replacement target must not be drained');
    assert.deepEqual(
      transitionEvents
        .filter((event) => event.event.startsWith('migration_'))
        .map(({ event, disposition }) => [event, disposition ?? null]),
      [
        ['migration_started', null],
        ['migration_completed', 'succeeded'],
      ],
    );
    assert.deepEqual(
      transitionEvents
        .filter((event) => event.event === 'backend_activation_acknowledged' || event.event === 'maintenance_exited')
        .map(({ event }) => event),
      ['backend_activation_acknowledged', 'maintenance_exited'],
      'acknowledged replacement exits maintenance before fallible target draining',
    );
    assert.deepEqual(lifecycle.map(({ phase }) => phase), ['replacing', 'maintenance', 'blocked']);
  });
});

test('proxy committed replacement publication failure keeps the active replacement and reports post-commit attention', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const lifecycle = [];
    const logs = [];
    const oldServer = { pid: 101, exitCode: null };
    const replacement = { pid: 202, exitCode: null };
    const serverProcRef = { current: oldServer };
    const executor = createDevServerReloadExecutor(
      executorOptions(serverDir, {
        serverProcRef,
        proxyController: {
          pid: process.pid,
          async enterMaintenance() {
            return { targetHost: '127.0.0.1', targetPort: 6101 };
          },
          flipUpstream() {},
          async drainConnections() {},
        },
      }),
      {
        ensureSourceServerWorkspacePackagesBuiltImpl: async () => {},
        preflightDevServerRestartImpl: async () => {},
        killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
        waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
        pickNextFreeTcpPortImpl: async () => 5102,
        pmSpawnScriptImpl: async () => replacement,
        waitForServerReadyImpl: async (_url, options) => {
          assert.equal(options?.startupDeadline?.getPhase(), 'readiness');
        },
        listListenPidsImpl: async (port) => (Number(port) === 5101 ? [101] : [302]),
        getProcessGroupIdImpl: async (pid) => (
          Number(pid) === 101 ? 101 : Number(pid) === 202 || Number(pid) === 302 ? 202 : Number(pid)
        ),
        recordStackRuntimeServerActivationImpl: async () => {
          throw new Error('runtime publication unavailable');
        },
        recordStackRuntimeServerLifecycleImpl: async (_path, transition) => {
          lifecycle.push(transition);
        },
        logger: {
          log(message) { logs.push(String(message)); },
          error(message) { logs.push(String(message)); },
        },
      },
    );

    await assert.rejects(
      () => restartThroughCoordinator(executor, { generation: 7, changedDescriptors: ['server:app'] }),
      (error) => {
        assert.match(error?.message ?? '', /runtime publication unavailable/);
        assert.equal(error?.serverRestartFailure?.kind, 'post_commit');
        assert.equal(error?.serverRestartFailure?.transportCommitted, true);
        assert.equal(error?.serverRestartFailure?.serviceRestored, true);
        return true;
      },
    );

    assert.equal(serverProcRef.current, replacement, 'the committed replacement must remain authoritative');
    assert.deepEqual(lifecycle.map(({ phase }) => phase), ['replacing', 'maintenance', 'blocked']);
    assert.equal(logs.some((line) => line.includes('server restarted behind proxy')), false);
    assert.equal(logs.some((line) => line.includes('replacement remains active')), true);
  });
});

test('direct committed replacement publication failure keeps the active replacement and reports post-commit attention', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const lifecycle = [];
    const logs = [];
    const exits = [];
    const oldServer = { pid: 101, exitCode: null };
    const replacement = Object.assign(new EventEmitter(), { pid: 202, exitCode: null, signalCode: null });
    const serverProcRef = { current: oldServer };
    let oldAlive = true;
    const executor = createDevServerReloadExecutor(
      executorOptions(serverDir, {
        serverPort: 4101,
        serverBindPort: 4101,
        internalServerUrl: 'http://127.0.0.1:4101',
        serverProcRef,
        proxyController: null,
      }),
      {
        ensureSourceServerWorkspacePackagesBuiltImpl: async () => {},
        preflightDevServerRestartImpl: async () => {},
        killProcessGroupOwnedByStackImpl: async () => {
          oldAlive = false;
          return { killed: true };
        },
        waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
        pmSpawnScriptImpl: async () => replacement,
        waitForServerReadyImpl: async (_url, options) => {
          assert.equal(options?.startupDeadline?.getPhase(), 'readiness');
        },
        listListenPidsImpl: async () => oldAlive ? [101] : [302],
        listListenPidsWithStatusImpl: async (_port, options) => ({
          status: 'ok',
          supported: true,
          pids: Number(options?.processGroupId) === 202 ? [302] : [101],
        }),
        isPidAliveImpl: (pid) => Number(pid) !== 101 || oldAlive,
        getProcessGroupIdImpl: async (pid) => Number(pid) === 202 || Number(pid) === 302 ? 202 : Number(pid),
        recordStackRuntimeServerActivationImpl: async () => {
          throw new Error('runtime publication unavailable');
        },
        recordStackRuntimeServerLifecycleImpl: async (_path, transition) => {
          lifecycle.push(transition);
        },
        logger: {
          log(message) { logs.push(String(message)); },
          error(message) { logs.push(String(message)); },
        },
      },
    );
    executor.setUnexpectedExitHandler((event) => exits.push(event));

    await assert.rejects(
      () => restartThroughCoordinator(executor, { generation: 7, changedDescriptors: ['server:app'] }),
      (error) => {
        assert.match(error?.message ?? '', /runtime publication unavailable/);
        assert.equal(error?.serverRestartFailure?.kind, 'post_commit');
        assert.equal(error?.serverRestartFailure?.serviceRestored, true);
        assert.equal(error?.serverRestartFailure?.directReplacementActive, true);
        return true;
      },
    );

    assert.equal(serverProcRef.current, replacement, 'the direct replacement must remain authoritative');
    assert.deepEqual(lifecycle.map(({ phase }) => phase), ['replacing', 'blocked']);
    assert.equal(logs.some((line) => line.includes('server restarted (')), false);
    assert.equal(logs.some((line) => line.includes('replacement remains active')), true);
    replacement.exitCode = 1;
    replacement.emit('exit', 1, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(exits.length, 1);
    assert.equal(exits[0].pid, 202);
  });
});

test('exclusiveDb proxy restart does not spawn after inconclusive post-stop release evidence', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let spawnCalls = 0;
    const lifecycle = [];
    const maintenanceCalls = [];
    const executor = createDevServerReloadExecutor(
      executorOptions(serverDir, {
        proxyController: {
          async enterMaintenance(options) {
            maintenanceCalls.push(options);
            return { targetHost: '127.0.0.1', targetPort: 6101 };
          },
          flipUpstream() {},
          async drainConnections() {},
        },
      }),
      {
        ensureSourceServerWorkspacePackagesBuiltImpl: async () => {},
        preflightDevServerRestartImpl: async () => {},
        killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
        waitForTcpPortFreeImpl: async () => ({
          status: 'inconclusive',
          reason: 'interface-inventory-unavailable',
        }),
        pmSpawnScriptImpl: async () => {
          spawnCalls += 1;
          return { pid: 202, exitCode: null };
        },
        listListenPidsImpl: async () => [101],
        isPidAliveImpl: () => true,
        getProcessGroupIdImpl: async (pid) => Number(pid),
        recordStackRuntimeServerLifecycleImpl: async (_path, transition) => {
          lifecycle.push(transition);
          if (transition.phase === 'unavailable') throw new Error('terminal projection unavailable');
        },
        logger: { log() {}, error() {} },
      },
    );

    await assert.rejects(
      () => restartThroughCoordinator(executor),
      (error) => {
        assert.equal(error.code, 'ESERVERBACKENDPORTRELEASEINCONCLUSIVE');
        assert.equal(error.reloadRetryAfterMs, 250);
        return true;
      },
    );
    assert.equal(spawnCalls, 0);
    assert.deepEqual(lifecycle.map(({ phase }) => phase), ['replacing', 'maintenance', 'retry-scheduled']);
    assert.deepEqual(maintenanceCalls.at(-1), {
      retryAfterMs: 250,
      retryable: true,
      message: 'Server reload recovery pending',
    });
  });
});

test('server executor renders retryability only from the coordinator committed disposition', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const lifecycle = [];
    const maintenance = [];
    const executor = createDevServerReloadExecutor(
      executorOptions(serverDir, {
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
      executorOptions(serverDir, {
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
    const options = executorOptions(serverDir, { serverProcRef: { current: child } });
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
    const options = executorOptions(serverDir, {
      serverProcRef: { current: oldServer },
      proxyController: {
        pid: 91,
        async enterMaintenance() { return { targetHost: '127.0.0.1', targetPort: 6101 }; },
        async flipUpstream() {},
        async drainConnections() {},
      },
    });
    const executor = createDevServerReloadExecutor(options, {
      ensureSourceServerWorkspacePackagesBuiltImpl: async () => {},
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

test('confirmed terminal post-stop failure publishes unavailable state without stale server membership', async (t) => {
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

    const executor = createDevServerReloadExecutor(
      executorOptions(serverDir, {
        runtimeStatePath,
        proxyController: {
          pid: process.pid,
          async enterMaintenance() { return { targetHost: '127.0.0.1', targetPort: 6101 }; },
          async flipUpstream() {},
          async drainConnections() {},
        },
      }),
      {
        ensureSourceServerWorkspacePackagesBuiltImpl: async () => {},
        preflightDevServerRestartImpl: async () => {},
        killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
        waitForTcpPortFreeImpl: async () => ({ status: 'occupied', reason: 'address-in-use' }),
        listListenPidsImpl: async () => [101],
        getProcessGroupIdImpl: async (pid) => Number(pid),
        logger: { log() {}, error() {} },
      },
    );

    await assert.rejects(
      () => restartThroughCoordinator(executor, { generation: 5, changedDescriptors: ['server:prisma'] }, { retryScheduled: false }),
      (error) => error?.code === 'ESERVERBACKENDPORTOCCUPIED'
        && error?.reloadRetryAfterMs === undefined,
    );

    const runtimeState = await readStackRuntimeStateFile(runtimeStatePath);
    assert.equal(runtimeState.serverLifecycle.phase, 'unavailable');
    assert.equal(runtimeState.serverLifecycle.disposition.code, 'readiness');
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
        isPidAliveImpl: () => true,
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

test('exclusiveDb proxy restart terminates through the listener identity when the wrapper leads its process group', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const killedPids = [];
    const proxy = {
      async enterMaintenance() {
        return { targetHost: '127.0.0.1', targetPort: 6101 };
      },
      async flipUpstream() {},
      async drainConnections() {},
    };

    const executor = createDevServerReloadExecutor(
      executorOptions(serverDir, { proxyController: proxy }),
      {
        ensureSourceServerWorkspacePackagesBuiltImpl: async () => {},
        preflightDevServerRestartImpl: async () => {},
        killProcessGroupOwnedByStackImpl: async (pid) => {
          killedPids.push(Number(pid));
          return Number(pid) === 201 ? { killed: true } : { killed: false };
        },
        waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
        pickNextFreeTcpPortImpl: async () => 5102,
        pmSpawnScriptImpl: async () => ({ pid: 202, exitCode: null, signalCode: null }),
        waitForServerReadyImpl: async () => {},
        listListenPidsImpl: async (port) => Number(port) === 5101 ? [201] : [302],
        getProcessGroupIdImpl: async (pid) => {
          if (Number(pid) === 101 || Number(pid) === 201) return 900;
          if (Number(pid) === 202 || Number(pid) === 302) return 901;
          return Number(pid);
        },
        isTcpPortFreeImpl: async () => true,
        isPidAliveImpl: () => true,
        logger: { log() {}, error() {} },
      },
    );

    await executor.restart({ generation: 2, changedDescriptors: ['server:app'] });
    assert.deepEqual(killedPids, [201]);
  });
});

test('exclusiveDb proxy recovery remains retryable across an unchanged failure and a later edit', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    let oldAlive = true;
    let spawnAttempts = 0;
    let stoppedBackendDiscoveryCalls = 0;
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
          if (Number(pid) === 101) oldAlive = false;
          return { killed: true };
        },
        waitForTcpPortFreeImpl: async (port) => {
          calls.push(['wait-free', port]);
          return { status: 'free' };
        },
        pickNextFreeTcpPortImpl: async () => 5102,
        pmSpawnScriptImpl: async ({ env }) => {
          calls.push(['spawn', Number(env.PORT)]);
          spawnAttempts += 1;
          return { pid: 201 + spawnAttempts, exitCode: null };
        },
        waitForServerReadyImpl: async (url) => {
          calls.push(['ready', url]);
          if (spawnAttempts <= 2) throw new Error('replacement not ready');
        },
        listListenPidsWithStatusImpl: async (port) => {
          if (Number(port) === 5101) {
            if (oldAlive) return { status: 'ok', supported: true, pids: [101] };
            stoppedBackendDiscoveryCalls += 1;
            return {
              status: 'timeout',
              supported: true,
              pids: [],
              reason: 'listener-discovery-timeout',
            };
          }
          return {
            status: 'ok',
            supported: true,
            pids: spawnAttempts > 2 ? [301 + spawnAttempts] : [],
          };
        },
        getProcessGroupIdImpl: async (pid) => {
          const value = Number(pid);
          return value >= 302 ? value - 100 : value;
        },
        isTcpPortFreeImpl: async () => true,
        isPidAliveImpl: (pid) => Number(pid) === 101 && oldAlive,
        logger: { log() {}, error() {} },
      },
    );

    await assert.rejects(
      () => restartThroughCoordinator(executor),
      (error) => {
        assert.match(error.message, /replacement not ready/);
        assert.equal(error.reloadRetryAfterMs, 250);
        return true;
      },
    );
    assert.deepEqual(calls, [
      ['maintenance', 2000],
      ['kill', 101],
      ['wait-free', 5101],
      ['spawn', 5102],
      ['ready', 'http://127.0.0.1:5102'],
      ['kill', 202],
      ['drain', { targetHost: '127.0.0.1', targetPort: 5102, graceMs: 2000 }],
      ['maintenance', 250],
    ]);

    await assert.rejects(
      () => restartThroughCoordinator(executor, {}, { retryScheduled: false }),
      (error) => {
        assert.match(error.message, /replacement not ready/);
        assert.equal(error.reloadRetryAfterMs, 250);
        return true;
      },
    );
    await executor.restart();
    assert.equal(spawnAttempts, 3);
    assert.equal(
      stoppedBackendDiscoveryCalls,
      2,
      'each unannotated failed replacement must re-check whether the incumbent service is actually unavailable',
    );
    assert.equal(calls.filter(([name, pid]) => name === 'kill' && pid === 101).length, 1);
    assert.equal(calls.filter(([name, port]) => name === 'wait-free' && port === 5101).length, 3);
    assert.ok(calls.some(([name, port]) => name === 'flip' && port === 5102));
  });
});

for (const availability of [
  {
    status: 'occupied',
    reason: 'address-in-use',
    expectedCode: 'ESERVERBACKENDPORTOCCUPIED',
    expectedRetryAfterMs: undefined,
  },
  {
    status: 'inconclusive',
    reason: 'interface-inventory-unavailable',
    expectedCode: 'ESERVERBACKENDPORTRELEASEINCONCLUSIVE',
    expectedRetryAfterMs: 250,
  },
]) {
  test(`already-exited proxy retry refuses ${availability.status} canonical bind evidence without listener discovery`, async (t) => {
    await withTempServerDir(t, async (serverDir) => {
      let listenerDiscoveryCalls = 0;
      let killCalls = 0;
      let spawnCalls = 0;
      const executor = createDevServerReloadExecutor(
        executorOptions(serverDir, {
          serverProcRef: { current: { pid: 101, exitCode: 1, signalCode: null } },
          proxyController: {
            async enterMaintenance() {
              return { targetHost: '127.0.0.1', targetPort: 6101 };
            },
            async flipUpstream() {},
            async drainConnections() {},
          },
        }),
        {
          ensureSourceServerWorkspacePackagesBuiltImpl: async () => {},
          preflightDevServerRestartImpl: async () => {},
          listListenPidsWithStatusImpl: async () => {
            listenerDiscoveryCalls += 1;
            return {
              status: 'timeout',
              supported: true,
              pids: [],
              reason: 'listener-discovery-timeout',
            };
          },
          isPidAliveImpl: () => true,
          killProcessGroupOwnedByStackImpl: async () => {
            killCalls += 1;
            return { killed: true };
          },
          waitForTcpPortFreeImpl: async () => availability,
          pmSpawnScriptImpl: async () => {
            spawnCalls += 1;
            return { pid: 202, exitCode: null, signalCode: null };
          },
          logger: { log() {}, error() {} },
        },
      );

      await assert.rejects(
        () => executor.restart({ generation: 2, changedDescriptors: ['server:prisma'] }),
        (error) => error?.code === availability.expectedCode
          && error?.reloadRetryAfterMs === availability.expectedRetryAfterMs,
      );
      assert.equal(listenerDiscoveryCalls, 0);
      assert.equal(killCalls, 0);
      assert.equal(spawnCalls, 0);
    });
  });
}

for (const mode of ['proxy', 'direct']) {
  for (const availability of [
    { status: 'free', expectedCode: null },
    { status: 'occupied', reason: 'address-in-use', expectedCode: 'ESERVERBACKENDPORTOCCUPIED' },
    {
      status: 'inconclusive',
      reason: 'interface-inventory-unavailable',
      expectedCode: 'ESERVERBACKENDPORTRELEASEINCONCLUSIVE',
    },
  ]) {
    test(`${mode} live-to-dead race uses canonical ${availability.status} bind evidence without a second kill`, async (t) => {
      await withTempServerDir(t, async (serverDir) => {
        const calls = [];
        const transitions = [];
        let incumbentLivenessChecks = 0;
        let spawnCalls = 0;
        const proxyController = mode === 'proxy'
          ? {
              async enterMaintenance() {
                calls.push('maintenance');
                return { targetHost: '127.0.0.1', targetPort: 6101 };
              },
              async flipUpstream() {},
              async drainConnections() {},
            }
          : null;
        const executor = createDevServerReloadExecutor(
          executorOptions(serverDir, {
            ...(mode === 'direct'
              ? {
                  serverPort: 4101,
                  serverBindPort: 4101,
                  internalServerUrl: 'http://127.0.0.1:4101',
                }
              : {}),
            proxyController,
          }),
          {
            ensureSourceServerWorkspacePackagesBuiltImpl: async () => {},
            preflightDevServerRestartImpl: async () => {},
            listListenPidsWithStatusImpl: async (_port, options) => ({
              status: 'ok',
              supported: true,
              pids: Number(options?.processGroupId) === 202 ? [302] : [],
            }),
            getProcessGroupIdImpl: async (pid) => (
              Number(pid) === 202 || Number(pid) === 302 ? 202 : Number(pid)
            ),
            isPidAliveImpl: (pid) => {
              if (Number(pid) !== 101) return true;
              incumbentLivenessChecks += 1;
              return incumbentLivenessChecks === 1;
            },
            waitForTcpPortFreeImpl: async (port) => {
              calls.push(`wait:${port}`);
              return availability;
            },
            killProcessGroupOwnedByStackImpl: async () => {
              calls.push('kill');
              return { killed: true };
            },
            pickNextFreeTcpPortImpl: async () => 5102,
            pmSpawnScriptImpl: async () => {
              spawnCalls += 1;
              return { pid: 202, exitCode: null, signalCode: null };
            },
            waitForServerReadyImpl: async () => {},
            recordStackRuntimeServerActivationImpl: async () => {},
            logger: {
              log(message) {
                if (String(message).startsWith('{')) transitions.push(JSON.parse(message));
              },
              error() {},
            },
          },
        );

        if (availability.expectedCode == null) {
          await executor.restart({ generation: 3, changedDescriptors: ['server:app'] });
          assert.equal(spawnCalls, 1);
          assert.equal(calls.filter((call) => call.startsWith('wait:')).length, 2);
        } else {
          await assert.rejects(
            () => executor.restart({ generation: 3, changedDescriptors: ['server:app'] }),
            (error) => error?.code === availability.expectedCode,
          );
          assert.equal(spawnCalls, 0);
          assert.equal(transitions.some(({ event }) => event === 'old_server_exited'), false);
          if (mode === 'proxy') assert.equal(calls.includes('maintenance'), false);
        }
        assert.equal(calls.includes('kill'), false);
      });
    });
  }
}

test('exclusiveDb proxy restart fails closed when provisional cleanup cannot be confirmed', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const runtimeStatePath = join(serverDir, 'stack.runtime.json');
    await recordStackRuntimeStart(runtimeStatePath, {
      stackName: 'proxy-test',
      ownerPid: process.pid,
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
    let oldAlive = true;
    let spawnCalls = 0;
    const executor = createDevServerReloadExecutor(
      executorOptions(serverDir, {
        runtimeStatePath,
        proxyController: {
          async enterMaintenance() {
            return { targetHost: '127.0.0.1', targetPort: 6101 };
          },
          flipUpstream() {
            assert.fail('an ambiguous provisional child must not become active');
          },
          async drainConnections() {},
        },
      }),
      {
        ensureSourceServerWorkspacePackagesBuiltImpl: async () => {},
        preflightDevServerRestartImpl: async () => {},
        killProcessGroupOwnedByStackImpl: async (pid) => {
          if (Number(pid) === 101) {
            oldAlive = false;
            return { killed: true };
          }
          return { killed: false };
        },
        killSpawnedChildImpl: async () => ({ ok: false }),
        waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
        pickNextFreeTcpPortImpl: async () => 5102,
        pmSpawnScriptImpl: async () => {
          spawnCalls += 1;
          return { pid: 202, exitCode: null };
        },
        waitForServerReadyImpl: async () => {
          throw new Error('replacement not ready');
        },
        listListenPidsImpl: async (port) => (Number(port) === 5101 && oldAlive ? [101] : []),
        getProcessGroupIdImpl: async (pid) => Number(pid),
        isTcpPortFreeImpl: async () => true,
        isPidAliveImpl: (pid) => Number(pid) === 101 && oldAlive,
        logger: { log() {}, error() {} },
      },
    );

    await assert.rejects(
      () => restartThroughCoordinator(executor),
      (error) => {
        assert.equal(error.code, 'ESERVERPROVISIONALCLEANUPINCOMPLETE');
        assert.equal(error.reloadRetryAfterMs, undefined);
        assert.match(error.message, /termination was not confirmed/);
        return true;
      },
    );
    assert.equal(spawnCalls, 1);
    const runtimeState = await readStackRuntimeStateFile(runtimeStatePath);
    assert.equal(runtimeState.serverLifecycle.phase, 'blocked');
    assert.equal(runtimeState.processes.serverPid, process.pid);
    assert.equal(runtimeState.processes.serverWrapperPid, process.pid);
    assert.equal(runtimeState.processes.serverBackendPid, process.pid);
    assert.equal(runtimeState.processes.serverDrainingPid, process.pid);
    assert.equal(runtimeState.ports.serverBackend, 5101);
  });
});

test('direct restart can relaunch current code after a safe post-stop spawn failure', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let oldAlive = true;
    let spawnAttempts = 0;
    let nowMs = 1_000;
    const options = executorOptions(serverDir, { proxyController: null });
    const executor = createDevServerReloadExecutor(options, {
      ensureSourceServerWorkspacePackagesBuiltImpl: async () => {},
      preflightDevServerRestartImpl: async () => {},
      killProcessGroupOwnedByStackImpl: async (pid) => {
        if (Number(pid) === 101) oldAlive = false;
        return { killed: true };
      },
      waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
      isTcpPortFreeImpl: async () => true,
      isPidAliveImpl: (pid) => Number(pid) === 101 && oldAlive,
      pmSpawnScriptImpl: async () => {
        spawnAttempts += 1;
        if (spawnAttempts === 1) throw new Error('spawn unavailable');
        return { pid: 202, exitCode: null };
      },
      waitForServerReadyImpl: async () => {},
      listListenPidsImpl: async (port) => {
        if (Number(port) === 4101 && oldAlive) return [101];
        return spawnAttempts > 1 ? [302] : [];
      },
      getProcessGroupIdImpl: async (pid) => (
        Number(pid) === 202 || Number(pid) === 302 ? 202 : Number(pid)
      ),
      recordStackRuntimeServerActivationImpl: async () => {},
      nowImpl: () => nowMs,
      restartFailurePolicy: { maxFailures: 1, windowMs: 60_000, backoffMs: 30_000 },
      logger: { log() {}, error() {} },
    });

    await assert.rejects(
      () => executor.restart(),
      (error) => {
        assert.match(error.message, /spawn unavailable/);
        assert.equal(error.reloadRetryAfterMs, 250);
        return true;
      },
    );
    assert.equal(executor.getBackoffRemainingMs(), 30_000);
    assert.deepEqual(
      await executor.restart(),
      { skipped: true, reason: 'backoff', retryAfterMs: 30_001 },
    );
    nowMs += 30_001;
    await executor.restart();
    assert.equal(spawnAttempts, 2);
    assert.equal(options.serverProcRef.current.pid, 202);
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

    await assert.rejects(
      () => executor.restart(),
      (error) => /not provably stack-owned/.test(String(error?.message))
        && error?.reloadRetryAfterMs === undefined,
    );
    assert.deepEqual(calls, []);
  });
});

test('unexpected source exit restores the admitted prior runtime before the next source build', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    const exited = new EventEmitter();
    exited.pid = 101;
    exited.exitCode = 1;
    const fallback = new EventEmitter();
    fallback.pid = 202;
    fallback.exitCode = null;
    fallback.signalCode = null;
    const serverProcRef = { current: exited };
    const runtimeServerDir = join(serverDir, 'prior-runtime', 'server');
    const executor = createDevServerReloadExecutor(
      executorOptions(serverDir, {
        serverProcRef,
        serverEnv: {
          HAPPIER_DB_PROVIDER: 'sqlite',
          HAPPIER_SERVER_LIGHT_DATA_DIR: join(serverDir, 'data'),
          HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: '1200ms',
          PORT: '5101',
        },
        priorRuntimeServerLaunchSpec: {
          source: 'runtime',
          serverDir: runtimeServerDir,
          command: join(runtimeServerDir, 'happier-server'),
          args: [],
        },
        proxyController: {
          pid: process.pid,
          async flipUpstream({ targetPort }) {
            calls.push(['flip', targetPort]);
          },
        },
      }),
      {
        pickNextFreeTcpPortImpl: async () => 5102,
        spawnPriorRuntimeServerImpl: ({ launchSpec, env }) => {
          calls.push(['spawn-prior', launchSpec.command, Number(env.PORT)]);
          assert.equal(env.HAPPIER_SQLITE_AUTO_MIGRATE, '0');
          assert.equal(env.HAPPIER_SQLITE_MIGRATIONS_DIR, join(runtimeServerDir, 'prisma', 'sqlite', 'migrations'));
          return fallback;
        },
        waitForServerReadyImpl: async (url) => calls.push(['ready', url]),
        listListenPidsImpl: async () => [302],
        getProcessGroupIdImpl: async (pid) => Number(pid) === 302 ? 202 : Number(pid),
        recordStackRuntimeServerActivationImpl: async (_path, activation) => calls.push(['record', activation]),
        logger: { log() {}, warn() {}, error() {} },
      },
    );

    const result = await executor.recoverUnexpectedExit({ child: exited, pid: 101, code: 1, signal: null });

    assert.equal(result.recovered, true);
    assert.equal(serverProcRef.current, fallback);
    assert.deepEqual(calls.slice(0, 3), [
      ['spawn-prior', join(runtimeServerDir, 'happier-server'), 5102],
      ['ready', 'http://127.0.0.1:5102'],
      ['flip', 5102],
    ]);
    assert.equal(calls[3][0], 'record');
    assert.equal(calls[3][1].backendPort, 5102);
    assert.equal(calls[3][1].listenerPid, 302);
  });
});

test('failed destructive source replacement restores the admitted prior runtime before reporting failure', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const fallback = new EventEmitter();
    fallback.pid = 202;
    fallback.exitCode = null;
    fallback.signalCode = null;
    const oldServer = { pid: 101, exitCode: null, signalCode: null };
    const serverProcRef = { current: oldServer };
    const runtimeServerDir = join(serverDir, 'prior-runtime', 'server');
    const flips = [];
    const executor = createDevServerReloadExecutor(
      executorOptions(serverDir, {
        serverProcRef,
        serverEnv: {
          HAPPIER_DB_PROVIDER: 'sqlite',
          HAPPIER_SERVER_LIGHT_DATA_DIR: join(serverDir, 'data'),
          HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: '1200ms',
          PORT: '5101',
        },
        priorRuntimeServerLaunchSpec: {
          source: 'runtime',
          serverDir: runtimeServerDir,
          command: join(runtimeServerDir, 'happier-server'),
          args: [],
        },
        proxyController: {
          pid: process.pid,
          async enterMaintenance() { return { targetHost: '127.0.0.1', targetPort: 6101 }; },
          async flipUpstream({ targetPort }) { flips.push(targetPort); },
          async drainConnections() {},
        },
      }),
      {
        preflightDevServerRestartImpl: async () => {},
        listListenPidsImpl: async (port) => Number(port) === 5101 ? [101] : [302],
        getProcessGroupIdImpl: async (pid) => Number(pid) === 302 ? 202 : Number(pid),
        killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
        waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
        pickNextFreeTcpPortImpl: async () => 5102,
        pmSpawnScriptImpl: async () => { throw new Error('current source cannot start'); },
        spawnPriorRuntimeServerImpl: async () => fallback,
        waitForServerReadyImpl: async () => {},
        recordStackRuntimeServerActivationImpl: async () => {},
        isPidAliveImpl: () => true,
        logger: { log() {}, warn() {}, error() {} },
      },
    );

    await executor.build({ generation: 7, changedDescriptors: ['server:app'] });
    await assert.rejects(
      () => executor.restart({ generation: 7, changedDescriptors: ['server:app'] }),
      (error) => error?.serverRestartFailure?.serviceRestored === true,
    );

    assert.equal(serverProcRef.current, fallback);
    assert.deepEqual(flips, [5102]);
  });
});
