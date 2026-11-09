import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createListenerOwnershipObservationScope,
  resolveSpawnedListenerOwnershipTimeoutMs,
  resolveSpawnedProcessGroupListenPid,
  resolveStackOwnedListenPid,
  resolveStackPidOwnership,
} from './listener_ownership.mjs';

test('spawned listener ownership timeout defaults for load and accepts a bounded Stack override', () => {
  assert.equal(resolveSpawnedListenerOwnershipTimeoutMs({}), 60_000);
  assert.equal(resolveSpawnedListenerOwnershipTimeoutMs({
    HAPPIER_STACK_LISTENER_OWNERSHIP_TIMEOUT_MS: '90000',
  }), 90_000);
  assert.equal(resolveSpawnedListenerOwnershipTimeoutMs({
    HAPPIER_STACK_LISTENER_OWNERSHIP_TIMEOUT_MS: 'invalid',
  }), 60_000);
});

test('a delayed process-group result still needs conclusive broad discovery', async () => {
  const observations = [];
  const resolve = (broad) => resolveSpawnedProcessGroupListenPid(
    { port: 4101, spawnedPid: 301 },
    {
      listenerOwnershipTimeoutMs: 3_000,
      listenerOwnershipRetryDelayMs: 0,
      listListenPidsWithStatusImpl: async (_port, options) => {
        observations.push(options);
        if (options.processGroupId === 301) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return { status: 'ok', supported: true, pids: [301] };
        }
        return broad;
      },
      getProcessGroupIdImpl: async (candidatePid) => candidatePid,
    },
  );

  for (const inconclusive of [
    { status: 'timeout', supported: true, pids: [], reason: 'listener-discovery-timeout' },
    { status: 'error', supported: true, pids: [], reason: 'listener-discovery-error' },
    { status: 'unsupported', supported: false, pids: [], reason: 'missing-listener-discovery-command' },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(resolve(inconclusive), (error) => {
      assert.equal(error.code, 'ELISTENERDISCOVERYINCONCLUSIVE');
      assert.equal(error.observation.reason, inconclusive.reason);
      return true;
    });
  }
  assert.equal(await resolve({ status: 'ok', supported: true, pids: [301] }), 301);
  assert.equal(observations.some((options) => options.processGroupId === 301), true);
  assert.equal(observations.some((options) => options.processGroupId == null), true);
});

test('spawned listener proof tolerates listener discovery delayed beyond three seconds under load', async () => {
  const availableAt = Date.now() + 3_200;
  const pid = await resolveSpawnedProcessGroupListenPid(
    { port: 4101, spawnedPid: 301 },
    {
      listenerOwnershipRetryDelayMs: 0,
      listListenPidsWithStatusImpl: async (_port, { processGroupId, signal }) => {
        if (!processGroupId) {
          return { status: 'ok', supported: true, pids: [301] };
        }
        return await new Promise((resolve) => {
          const remainingMs = Math.max(0, availableAt - Date.now());
          const timer = setTimeout(() => {
            resolve({ status: 'ok', supported: true, pids: [301] });
          }, remainingMs);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve({ status: 'timeout', supported: true, pids: [], reason: 'listener-discovery-timeout' });
          }, { once: true });
        });
      },
      getProcessGroupIdImpl: async (candidatePid) => candidatePid,
    },
  );

  assert.equal(pid, 301);
});

test('spawned listener proof lets one process-group discovery consume its reserved subdeadline', async () => {
  let processGroupAttempts = 0;
  let broadAttempts = 0;
  const timeoutBudgets = [];
  const pid = await resolveSpawnedProcessGroupListenPid(
    { port: 4101, spawnedPid: 301 },
    {
      listenerOwnershipTimeoutMs: 2_100,
      listenerOwnershipRetryDelayMs: 0,
      listListenPidsWithStatusImpl: async (_port, { processGroupId, signal, timeoutMs }) => {
        if (!processGroupId) {
          broadAttempts += 1;
          return { status: 'ok', supported: true, pids: [301] };
        }
        processGroupAttempts += 1;
        timeoutBudgets.push(timeoutMs);
        return await new Promise((resolve) => {
          const timer = setTimeout(() => {
            resolve({ status: 'ok', supported: true, pids: [301] });
          }, 1_100);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve({ status: 'timeout', supported: true, pids: [], reason: 'listener-discovery-timeout' });
          }, { once: true });
        });
      },
      getProcessGroupIdImpl: async (candidatePid) => candidatePid,
    },
  );

  assert.equal(pid, 301);
  assert.equal(processGroupAttempts, 1);
  // One bounded look for conflicts, never a retry loop.
  assert.equal(broadAttempts, 1);
  assert.ok(timeoutBudgets[0] > 1_100);
});

test('spawned listener proof fails closed when group and broad discovery stay inconclusive', async () => {
  await assert.rejects(
    () => resolveSpawnedProcessGroupListenPid(
      { port: 4101, spawnedPid: 301 },
      {
        listenerOwnershipTimeoutMs: 60,
        listenerOwnershipRetryDelayMs: 0,
        listListenPidsWithStatusImpl: async () => ({
          status: 'timeout',
          supported: true,
          pids: [],
          reason: 'listener-discovery-timeout',
        }),
        getProcessGroupIdImpl: async () => 301,
      },
    ),
    (error) => error?.code === 'ELISTENERDISCOVERYINCONCLUSIVE',
  );
});

test('spawned listener proof rejects a listener from a foreign process group', async () => {
  await assert.rejects(
    () => resolveSpawnedProcessGroupListenPid(
      { port: 4101, spawnedPid: 301 },
      {
        listenerOwnershipTimeoutMs: 200,
        listenerOwnershipRetryDelayMs: 0,
        listListenPidsWithStatusImpl: async (_port, options) => options.processGroupId
          ? { status: 'ok', supported: true, pids: [] }
          : { status: 'ok', supported: true, pids: [999] },
        getProcessGroupIdImpl: async (candidatePid) => candidatePid === 301 ? 301 : 999,
      },
    ),
    (error) => error?.code !== 'ELISTENERDISCOVERYINCONCLUSIVE'
      && /another process/.test(String(error?.message)),
  );
});

test('command-scoped listener observation enforces one total deadline and reuses its terminal verdict', async () => {
  let now = 1_000;
  const timeoutBudgets = [];
  const scope = createListenerOwnershipObservationScope({
    totalTimeoutMs: 120,
    retryDelayMs: 10,
    nowImpl: () => now,
    delayImpl: async (ms) => { now += ms; },
    listListenPidsWithStatusImpl: async (_port, { timeoutMs }) => {
      timeoutBudgets.push(timeoutMs);
      now += timeoutMs;
      return { status: 'timeout', supported: true, pids: [], reason: 'listener-discovery-timeout' };
    },
  });

  const first = await scope.observe(4101);
  const second = await scope.observe(4101);

  assert.equal(first.status, 'timeout');
  assert.equal(second, first);
  assert.deepEqual(timeoutBudgets, [120]);
  assert.equal(scope.remainingMs(), 0);
});

test('process-group corroboration retries within a bounded sub-deadline and preserves broad listener budget', async () => {
  let now = 1_000;
  const observations = [];
  const scope = createListenerOwnershipObservationScope({
    totalTimeoutMs: 100,
    attemptTimeoutMs: 20,
    processGroupAttemptTimeoutMs: 20,
    retryDelayMs: 0,
    nowImpl: () => now,
    delayImpl: async (ms) => { now += ms; },
    listListenPidsWithStatusImpl: async (_port, options) => {
      observations.push(options);
      now += options.timeoutMs;
      return options.processGroupId
        ? { status: 'timeout', supported: true, pids: [], reason: 'listener-discovery-timeout' }
        : { status: 'ok', supported: true, pids: [301] };
    },
  });

  const corroboration = await scope.observeProcessGroup(4101, 44);
  const broad = await scope.observe(4101);

  assert.equal(corroboration.status, 'timeout');
  assert.deepEqual(broad, { status: 'ok', supported: true, pids: [301] });
  assert.ok(observations.filter((options) => options.processGroupId === 44).length >= 2);
  assert.equal(observations.filter((options) => options.processGroupId == null).length, 1);
  assert.ok(scope.remainingMs() > 0);
});

test('process-group listener proof allows a loaded discovery command to exceed 250ms', async () => {
  const scope = createListenerOwnershipObservationScope({
    totalTimeoutMs: 3_000,
    retryDelayMs: 0,
    listListenPidsWithStatusImpl: async (_port, { signal }) => await new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ status: 'ok', supported: true, pids: [301] });
      }, 300);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve({ status: 'timeout', supported: true, pids: [], reason: 'listener-discovery-timeout' });
      }, { once: true });
    }),
  });

  assert.deepEqual(await scope.observeProcessGroup(4101, 44), {
    status: 'ok',
    supported: true,
    pids: [301],
  });
  assert.ok(scope.remainingMs() > 0);
});

test('command-scoped ownership and availability preserve unsupported listener evidence as inconclusive', async () => {
  let listenerObservations = 0;
  let bindingProbes = 0;
  const scope = createListenerOwnershipObservationScope({
    totalTimeoutMs: 50,
    retryInconclusive: false,
    listListenPidsWithStatusImpl: async () => {
      listenerObservations += 1;
      return {
        status: 'unsupported',
        supported: false,
        pids: [],
        reason: 'missing-listener-discovery-command',
      };
    },
    probeTcpPortBindingImpl: async () => {
      bindingProbes += 1;
      return { status: 'free' };
    },
  });

  await assert.rejects(
    () => resolveStackOwnedListenPid(
      { port: 4101, stackName: 'test', envPath: '/tmp/test.env' },
      { observationScope: scope },
    ),
    (error) => error?.code === 'ELISTENERDISCOVERYINCONCLUSIVE'
      && error?.observation?.status === 'unsupported',
  );
  const availability = await scope.checkPortFree(4101);

  assert.equal(availability.status, 'inconclusive');
  assert.equal(availability.observation.status, 'unsupported');
  assert.equal(listenerObservations, 1);
  assert.equal(bindingProbes, 0);
});

test('command-scoped listener observation aborts an in-flight boundary at the wall-clock deadline', async () => {
  let activeDiscoveries = 0;
  const scope = createListenerOwnershipObservationScope({
    totalTimeoutMs: 30,
    attemptTimeoutMs: 10,
    retryInconclusive: false,
    listListenPidsWithStatusImpl: async (_port, { signal }) => await new Promise((resolve) => {
      activeDiscoveries += 1;
      const timer = setTimeout(() => {
        activeDiscoveries -= 1;
        resolve({ status: 'ok', supported: true, pids: [301] });
      }, 120);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        activeDiscoveries -= 1;
      }, { once: true });
    }),
  });

  const startedAt = Date.now();
  const observation = await scope.observe(4101);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(observation.status, 'timeout');
  assert.ok(elapsedMs < 80, `deadline settled after ${elapsedMs}ms`);
  assert.equal(activeDiscoveries, 0);
});

test('ownership resolution retries inconclusive listener evidence and then resolves the owned listener', async () => {
  let attempts = 0;
  const pid = await resolveStackOwnedListenPid(
    { port: 4101, stackName: 'test', envPath: '/tmp/test-env' },
    {
      listenerRetryDelayMs: 0,
      listListenPidsWithStatusImpl: async () => {
        attempts += 1;
        if (attempts < 3) {
          return { status: 'timeout', supported: true, pids: [], reason: 'listener-discovery-timeout' };
        }
        return { status: 'ok', supported: true, pids: [301] };
      },
      isPidOwnedByStackImpl: async () => true,
      getProcessGroupIdImpl: async () => 301,
    },
  );

  assert.equal(pid, 301);
  assert.equal(attempts, 3);
});

test('ownership resolution fails closed after bounded inconclusive listener evidence', async () => {
  let attempts = 0;
  await assert.rejects(
    () => resolveStackOwnedListenPid(
      { port: 4101, stackName: 'test', envPath: '/tmp/test-env' },
      {
        listenerTotalTimeoutMs: 60,
        listenerRetryDelayMs: 20,
        listListenPidsWithStatusImpl: async () => {
          attempts += 1;
          return { status: 'error', supported: true, pids: [], reason: 'listener-discovery-error' };
        },
      },
    ),
    (error) => error?.code === 'ELISTENERDISCOVERYINCONCLUSIVE',
  );
  assert.ok(attempts >= 2 && attempts <= 4, `expected bounded retries, got ${attempts}`);
});

test('ownership resolution retries typed inconclusive process identity within the same scope', async () => {
  let identityAttempts = 0;
  const scope = createListenerOwnershipObservationScope({
    totalTimeoutMs: 500,
    retryDelayMs: 0,
    listListenPidsWithStatusImpl: async () => ({ status: 'ok', supported: true, pids: [301] }),
  });

  const pid = await resolveStackOwnedListenPid(
    { port: 4101, stackName: 'test', envPath: '/tmp/test-env' },
    {
      observationScope: scope,
      resolvePidStackOwnershipImpl: async () => {
        identityAttempts += 1;
        return identityAttempts < 3
          ? { status: 'inconclusive', owned: null, reason: 'process-identity-timeout' }
          : { status: 'owned', owned: true, reason: 'env_file' };
      },
      getProcessGroupIdImpl: async () => 301,
    },
  );

  assert.equal(pid, 301);
  assert.equal(identityAttempts, 3);
  assert.deepEqual(await scope.observe(4101), { status: 'ok', supported: true, pids: [301] });
});

test('ownership resolution fails closed on terminal typed process identity evidence', async () => {
  await assert.rejects(
    () => resolveStackOwnedListenPid(
      { port: 4101, stackName: 'test', envPath: '/tmp/test-env' },
      {
        listenerTotalTimeoutMs: 100,
        listenerRetryDelayMs: 0,
        listListenPidsWithStatusImpl: async () => ({ status: 'ok', supported: true, pids: [301] }),
        resolvePidStackOwnershipImpl: async () => ({
          status: 'inconclusive',
          owned: null,
          reason: 'process-identity-unavailable',
        }),
      },
    ),
    (error) => error?.code === 'ELISTENERDISCOVERYINCONCLUSIVE'
      && ['process-identity-unavailable', 'process-identity-timeout'].includes(error?.observation?.reason),
  );
});

test('process identity observation enforces the command wall-clock deadline and caches timeout', async () => {
  let attempts = 0;
  let active = 0;
  let aborted = false;
  const scope = createListenerOwnershipObservationScope({ totalTimeoutMs: 30 });

  const startedAt = Date.now();
  const ownership = await resolveStackPidOwnership(
    { pid: 301, stackName: 'test', envPath: '/tmp/test-env' },
    {
      observationScope: scope,
      resolvePidStackOwnershipImpl: async (_pid, _context, { signal }) => await new Promise((resolve) => {
        attempts += 1;
        active += 1;
        const timer = setTimeout(() => {
          active -= 1;
          resolve({ status: 'owned', owned: true, reason: 'late-owned' });
        }, 120);
        signal.addEventListener('abort', () => {
          aborted = true;
        }, { once: true });
      }),
    },
  );
  const elapsedMs = Date.now() - startedAt;
  assert.equal(ownership.status, 'inconclusive');
  assert.equal(ownership.reason, 'process-identity-timeout');
  assert.ok(elapsedMs < 80, `identity deadline settled after ${elapsedMs}ms`);
  assert.equal(aborted, true);
  assert.equal(active, 1, 'hostile adapter intentionally ignores abort and remains late');

  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(active, 0);
  const cached = await resolveStackPidOwnership(
    { pid: 301, stackName: 'test', envPath: '/tmp/test-env' },
    { observationScope: scope },
  );
  assert.equal(cached, ownership);
  assert.equal(cached.status, 'inconclusive');
  assert.equal(attempts, 1);
});

test('process identity deadline leaves no active work when the boundary honors abort', async () => {
  let active = 0;
  const scope = createListenerOwnershipObservationScope({ totalTimeoutMs: 30 });
  const ownership = await resolveStackPidOwnership(
    { pid: 302, stackName: 'test', envPath: '/tmp/test-env' },
    {
      observationScope: scope,
      resolvePidStackOwnershipImpl: async (_pid, _context, { signal }) => await new Promise((resolve) => {
        active += 1;
        const timer = setTimeout(() => {
          active -= 1;
          resolve({ status: 'owned', owned: true, reason: 'late-owned' });
        }, 120);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          active -= 1;
          resolve({ status: 'inconclusive', owned: null, reason: 'process-identity-timeout' });
        }, { once: true });
      }),
    },
  );
  assert.equal(ownership.status, 'inconclusive');
  assert.equal(ownership.reason, 'process-identity-timeout');
  assert.equal(active, 0);
});

test('expired command scope never starts process identity observation and caches timeout', async () => {
  let calls = 0;
  const scope = createListenerOwnershipObservationScope({ totalTimeoutMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 5));

  const first = await resolveStackPidOwnership(
    { pid: 303, stackName: 'test', envPath: '/tmp/test-env' },
    {
      observationScope: scope,
      resolvePidStackOwnershipImpl: async () => {
        calls += 1;
        return { status: 'owned', owned: true, reason: 'should-not-run' };
      },
    },
  );
  assert.deepEqual(first, {
    status: 'inconclusive',
    owned: null,
    reason: 'process-identity-timeout',
  });
  assert.equal(calls, 0);

  const cached = await resolveStackPidOwnership(
    { pid: 303, stackName: 'test', envPath: '/tmp/test-env' },
    { observationScope: scope },
  );
  assert.equal(cached, first);
  assert.equal(calls, 0);
});

test('a narrow process-group result does not hide a foreign listener from broad discovery', async () => {
  const resolve = (groups) => resolveSpawnedProcessGroupListenPid(
    { port: 4101, spawnedPid: 301 },
    {
      listenerOwnershipTimeoutMs: 1_000,
      listListenPidsWithStatusImpl: async (_port, options) => (options.processGroupId === 301
        ? { status: 'ok', supported: true, pids: [302] }
        : { status: 'ok', supported: true, pids: [302, 400] }),
      getProcessGroupIdImpl: async (pid) => groups[pid] ?? null,
    },
  );

  await assert.rejects(resolve({ 301: 301, 302: 301, 400: 77 }), /answered by another process/);
  await assert.rejects(resolve({ 301: 301, 302: 301 }), /answered by another process/);
  assert.equal(await resolve({ 301: 301, 302: 301, 400: 301 }), 302);
});

test('a second group proof in the same scope does not repeat broad corroboration', async () => {
  let broadReads = 0;
  const scope = createListenerOwnershipObservationScope({
    totalTimeoutMs: 1_000,
    listListenPidsWithStatusImpl: async (_port, options) => {
      if (!options.processGroupId) broadReads += 1;
      return { status: 'ok', supported: true, pids: [301] };
    },
  });
  const options = { observationScope: scope, getProcessGroupIdImpl: async () => 301 };
  await resolveSpawnedProcessGroupListenPid({ port: 4101, spawnedPid: 301 }, options);
  await resolveSpawnedProcessGroupListenPid({ port: 4101, spawnedPid: 301 }, options);
  assert.equal(broadReads, 1);
});

test('a listener found through the resolved process group is also checked against broad discovery', async () => {
  await assert.rejects(
    resolveSpawnedProcessGroupListenPid(
      { port: 4101, spawnedPid: 301 },
      {
        listenerOwnershipTimeoutMs: 1_000,
        listListenPidsWithStatusImpl: async (_port, { processGroupId }) => {
          if (processGroupId === 301) return { status: 'ok', supported: true, pids: [] };
          if (processGroupId === 44) return { status: 'ok', supported: true, pids: [302] };
          return { status: 'ok', supported: true, pids: [302, 400] };
        },
        getProcessGroupIdImpl: async (pid) => ({ 301: 44, 302: 44, 400: 77 })[pid] ?? null,
      },
    ),
    /answered by another process/,
  );
});

test('the spawned process is never foreign to its own proof', async () => {
  const pid = await resolveSpawnedProcessGroupListenPid(
    { port: 4101, spawnedPid: 301 },
    {
      listenerOwnershipTimeoutMs: 1_000,
      listListenPidsWithStatusImpl: async (_port, { processGroupId }) => (processGroupId === 301
        ? { status: 'ok', supported: true, pids: [302] }
        : { status: 'ok', supported: true, pids: [301, 302] }),
      getProcessGroupIdImpl: async () => null,
    },
  );
  assert.equal(pid, 302);
});

test('inconclusive broad corroboration is one attempt, not a retry loop', async () => {
  let broadAttempts = 0;
  await assert.rejects(
    resolveSpawnedProcessGroupListenPid(
      { port: 4101, spawnedPid: 301 },
      {
        listenerOwnershipTimeoutMs: 1_000,
        listenerOwnershipRetryDelayMs: 0,
        listListenPidsWithStatusImpl: async (_port, { processGroupId }) => {
          if (processGroupId) return { status: 'ok', supported: true, pids: [301] };
          broadAttempts += 1;
          return { status: 'timeout', supported: true, pids: [], reason: 'listener-discovery-timeout' };
        },
        getProcessGroupIdImpl: async (candidatePid) => candidatePid,
      },
    ),
    (error) => error.code === 'ELISTENERDISCOVERYINCONCLUSIVE',
  );
  assert.equal(broadAttempts, 1);
});

test('a process probe that ignores its abort is still cut off at the scope deadline', async () => {
  const scope = createListenerOwnershipObservationScope({ totalTimeoutMs: 60 });
  const outcome = await Promise.race([
    scope.withProcessProbeBudget(() => new Promise(() => {})),
    new Promise((resolve) => setTimeout(() => resolve('still-pending'), 1_000)),
  ]);
  assert.deepEqual(outcome, { status: 'inconclusive', reason: 'process-identity-timeout' });
});

test('a process probe that ignores its abort is still cut off by the caller', async () => {
  const controller = new AbortController();
  const scope = createListenerOwnershipObservationScope({ totalTimeoutMs: 30_000 });
  const pending = scope.withProcessProbeBudget(() => new Promise(() => {}), { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  const outcome = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve('still-pending'), 1_000)),
  ]);
  assert.deepEqual(outcome, { status: 'inconclusive', reason: 'process-identity-cancelled' });
});

test('a process probe that settles keeps its own answer', async () => {
  const scope = createListenerOwnershipObservationScope({ totalTimeoutMs: 1_000 });
  assert.deepEqual(await scope.withProcessProbeBudget(async () => ({ status: 'ok' })), { status: 'ok' });
  await assert.rejects(scope.withProcessProbeBudget(async () => {
    throw new Error('probe failed');
  }), /probe failed/);
});
