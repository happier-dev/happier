import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createListenerOwnershipObservationScope,
  resolveSpawnedProcessGroupListenPid,
  resolveStackOwnedListenPid,
  resolveStackPidOwnership,
} from './listener_ownership.mjs';

test('spawned listener proof keeps the production ownership deadline at three seconds', async () => {
  let timeoutMs;
  const pid = await resolveSpawnedProcessGroupListenPid(
    { port: 4101, spawnedPid: 301 },
    {
      listListenPidsWithStatusImpl: async (_port, options) => {
        timeoutMs = options.timeoutMs;
        return { status: 'ok', supported: true, pids: [301] };
      },
      getProcessGroupIdImpl: async (candidatePid) => candidatePid,
    },
  );

  assert.equal(pid, 301);
  assert.ok(timeoutMs >= 1_900 && timeoutMs <= 2_000);
});

test('spawned listener proof prefers a delayed process-group result over inconclusive broad discovery', async () => {
  const observations = [];
  const pid = await resolveSpawnedProcessGroupListenPid(
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
        return { status: 'timeout', supported: true, pids: [], reason: 'listener-discovery-timeout' };
      },
      getProcessGroupIdImpl: async (candidatePid) => candidatePid,
    },
  );

  assert.equal(pid, 301);
  assert.equal(observations.some((options) => options.processGroupId === 301), true);
  assert.equal(observations.some((options) => options.processGroupId == null), false);
});

test('spawned listener proof retries a transient empty process-group observation before accepting readiness', async () => {
  let groupAttempts = 0;
  let broadAttempts = 0;
  const pid = await resolveSpawnedProcessGroupListenPid(
    { port: 4101, spawnedPid: 301 },
    {
      listenerOwnershipTimeoutMs: 100,
      listenerOwnershipRetryDelayMs: 0,
      listListenPidsWithStatusImpl: async (_port, { processGroupId }) => {
        if (processGroupId) {
          groupAttempts += 1;
          return groupAttempts === 1
            ? { status: 'ok', supported: true, pids: [] }
            : { status: 'ok', supported: true, pids: [301] };
        }
        broadAttempts += 1;
        return { status: 'ok', supported: true, pids: [] };
      },
      getProcessGroupIdImpl: async (candidatePid) => candidatePid,
    },
  );

  assert.equal(pid, 301);
  assert.equal(groupAttempts, 2);
  assert.equal(broadAttempts, 0);
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
          return { status: 'timeout', supported: true, pids: [], reason: 'listener-discovery-timeout' };
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
  assert.equal(broadAttempts, 0);
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

test('broad listener proof allows a loaded discovery command to exceed 250ms', async () => {
  const pid = await resolveStackOwnedListenPid(
    { port: 4101, stackName: 'test', envPath: '/tmp/test-env' },
    {
      listenerRetryDelayMs: 0,
      listListenPidsWithStatusImpl: async (_port, { signal }) => await new Promise((resolve) => {
        const timer = setTimeout(() => {
          resolve({ status: 'ok', supported: true, pids: [] });
        }, 300);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve({ status: 'timeout', supported: true, pids: [], reason: 'listener-discovery-timeout' });
        }, { once: true });
      }),
    },
  );

  assert.equal(pid, null);
});

test('command-scoped ownership preserves unsupported listener evidence as inconclusive', async () => {
  let listenerObservations = 0;
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
  });

  await assert.rejects(
    () => resolveStackOwnedListenPid(
      { port: 4101, stackName: 'test', envPath: '/tmp/test.env' },
      { observationScope: scope },
    ),
    (error) => error?.code === 'ELISTENERDISCOVERYINCONCLUSIVE'
      && error?.observation?.status === 'unsupported',
  );
  assert.equal(listenerObservations, 1);
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
