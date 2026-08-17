import assert from 'node:assert/strict';
import test from 'node:test';

import {
  requestInitialDevRefreshes,
  startDevReloadCoordinator,
} from './devReloadCoordinator.mjs';
import { watchDebounced } from '../proc/watch.mjs';

function descriptor({ id, target, signature = '0' }) {
  let current = signature;
  return {
    id,
    target,
    paths: [`/tmp/${id}`],
    set(value) {
      current = value;
    },
    readSignature() {
      return current;
    },
  };
}

test('requestInitialDevRefreshes refreshes enabled server and daemon owners behind the admitted runtime', async () => {
  const requested = [];
  const pending = requestInitialDevRefreshes({
    reloadWatcher: {
      requestReload(target) {
        requested.push(target);
        return Promise.resolve();
      },
    },
    serverReloadEnabled: true,
    daemonReloadEnabled: true,
  });

  assert.deepEqual(requested, ['server', 'daemon']);
  await Promise.all(pending);
});

function deferredAsyncDescriptor({ id, target, signature = '0' }) {
  let current = signature;
  let activeReads = 0;
  let maxActiveReads = 0;
  let readCalls = 0;
  const pendingReads = [];
  return {
    id,
    target,
    paths: [`/tmp/${id}`],
    set(value) {
      current = value;
    },
    readSignatureAsync() {
      readCalls += 1;
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      return new Promise((resolve) => {
        pendingReads.push(() => {
          activeReads -= 1;
          resolve(current);
        });
      });
    },
    resolvePendingReads() {
      for (const resolveRead of pendingReads.splice(0)) resolveRead();
    },
    resetMetrics() {
      readCalls = 0;
      maxActiveReads = activeReads;
    },
    metrics() {
      return { activeReads, maxActiveReads, readCalls, pendingReads: pendingReads.length };
    },
  };
}

function executor(target, calls, overrides = {}) {
  return {
    target,
    ...(typeof overrides.setUnexpectedExitHandler === 'function' ? {
      setUnexpectedExitHandler(handler) {
        return overrides.setUnexpectedExitHandler(handler);
      },
    } : {}),
    ...(typeof overrides.publishFailureDisposition === 'function' ? {
      async publishFailureDisposition(disposition) {
        return await overrides.publishFailureDisposition(disposition);
      },
    } : {}),
    ...(typeof overrides.emitTransitionEvent === 'function' ? {
      emitTransitionEvent(event, details) {
        return overrides.emitTransitionEvent(event, details);
      },
    } : {}),
    ...(typeof overrides.recoverUnexpectedExit === 'function' ? {
      async recoverUnexpectedExit(event) {
        return await overrides.recoverUnexpectedExit(event);
      },
    } : {}),
    ...(typeof overrides.createPlan === 'function' ? {
      createPlan(context) {
        return overrides.createPlan(context);
      },
    } : {}),
    ...(typeof overrides.publishLifecycle === 'function' ? {
      async publishLifecycle(transition) {
        calls.push([target, 'lifecycle', transition]);
        return await overrides.publishLifecycle(transition);
      },
    } : {}),
    async build(context) {
      calls.push(`${target}:build:${context.cycle}`);
      return await overrides.build?.(context);
    },
    async restart(context) {
      calls.push(`${target}:restart:${context.cycle}`);
      return await overrides.restart?.(context);
    },
  };
}

async function observeComposedFilesystemThenPoll({ laterPollSignature = null } = {}) {
  const calls = [];
  const activations = [];
  const debounceTimers = [];
  let emitFilesystemEvent;
  let poll;
  let releaseFirstRestart;
  let markFirstRestartStarted;
  const firstRestartStarted = new Promise((resolve) => { markFirstRestartStarted = resolve; });
  const firstRestartBlocked = new Promise((resolve) => { releaseFirstRestart = resolve; });
  const app = descriptor({ id: 'server:app', target: 'server' });
  const coordinator = startDevReloadCoordinator({
    enabled: true,
    descriptors: [app],
    executors: [executor('server', calls, {
      async restart(context) {
        activations.push(context.generation);
        if (context.generation === 1) {
          markFirstRestartStarted();
          await firstRestartBlocked;
        }
      },
    })],
    debounceMs: 500,
    pollIntervalMs: 2000,
    logger: { log() {}, warn() {}, error() {} },
  }, {
    watchDebouncedImpl(options) {
      return watchDebounced({
        ...options,
        watchImpl: (_path, _watchOptions, handler) => {
          emitFilesystemEvent = handler;
          return { close() {} };
        },
        setIntervalImpl(callback, ms) {
          assert.equal(ms, 2000);
          poll = callback;
          return { unref() {} };
        },
        clearIntervalImpl() {},
        setTimeoutImpl(callback) {
          const timer = { callback, canceled: false };
          debounceTimers.push(timer);
          return timer;
        },
        clearTimeoutImpl(timer) {
          timer.canceled = true;
        },
      });
    },
  });
  assert.ok(coordinator);

  await new Promise((resolve) => setImmediate(resolve));
  await poll();
  app.set('1');
  emitFilesystemEvent('change', 'app.ts');
  const filesystemDebounce = debounceTimers.shift();
  assert.ok(filesystemDebounce && !filesystemDebounce.canceled);
  filesystemDebounce.callback();
  await firstRestartStarted;

  if (laterPollSignature !== null) app.set(laterPollSignature);
  await poll();
  const pollScheduledDebounce = debounceTimers.some((timer) => !timer.canceled);
  for (const timer of debounceTimers.splice(0)) {
    if (!timer.canceled) timer.callback();
  }
  releaseFirstRestart();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await coordinator.close();
  return { activations, pollScheduledDebounce };
}

test('filesystem admission and default poll correlation preserve exactly-once activation', async () => {
  assert.deepEqual(await observeComposedFilesystemThenPoll(), {
    activations: [1],
    pollScheduledDebounce: false,
  });
  assert.deepEqual(await observeComposedFilesystemThenPoll({ laterPollSignature: '2' }), {
    activations: [1, 2],
    pollScheduledDebounce: true,
  });
});

test('admits one generation-correlated source transition before preflight', async () => {
  const calls = [];
  const transitions = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      emitTransitionEvent(event, details) {
        transitions.push({ event, ...details });
      },
    })],
    calls,
  });

  server.set('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });

  assert.deepEqual(transitions, [{
    event: 'source_generation_admitted',
    generation: 1,
    changedDescriptors: ['server:app'],
    targets: ['server'],
  }]);
  assert.deepEqual(calls.slice(1), ['server:build:1', 'server:restart:1']);
});

test('marks a changed descriptor read error as inconclusive migration evidence', async () => {
  const calls = [];
  const contexts = [];
  const shared = descriptor({ id: 'shared:protocol', target: 'shared' });
  const onChange = startCoordinator({
    descriptors: [shared],
    executors: [executor('server', calls, {
      async restart(context) {
        contexts.push(context);
      },
    })],
    calls,
  });

  shared.set('error:permission denied');
  await onChange({ eventType: 'change', filename: 'v1.ts' });

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].descriptorEvidenceConclusive, false);
  assert.deepEqual(contexts[0].changedDescriptors, ['shared:protocol']);
});

test('does not treat a stable unreadable Prisma descriptor as proof that migrations are unchanged', async () => {
  const calls = [];
  const contexts = [];
  const shared = descriptor({ id: 'shared:protocol', target: 'shared' });
  const prisma = descriptor({
    id: 'server:prisma',
    target: 'server',
    signature: 'error:permission denied',
  });
  const onChange = startCoordinator({
    descriptors: [shared, prisma],
    executors: [executor('server', calls, {
      async restart(context) {
        contexts.push(context);
      },
    })],
    calls,
  });

  shared.set('1');
  await onChange({ eventType: 'change', filename: 'v1.ts' });

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].descriptorEvidenceConclusive, false);
  assert.deepEqual(contexts[0].changedDescriptors, ['shared:protocol']);
});

test('source transition observer failure cannot suppress the admitted generation', async () => {
  const calls = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      emitTransitionEvent() { throw new Error('observer unavailable'); },
    })],
    calls,
  });

  server.set('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });

  assert.deepEqual(calls.slice(1), ['server:build:1', 'server:restart:1']);
});

test('reload coordinator publishes planned, retry-scheduled, and build-blocked lifecycle truth', async () => {
  const calls = [];
  const scheduled = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let restartAttempts = 0;
  const serverExecutor = executor('server', calls, {
    createPlan(context) {
      return {
        mode: 'exclusiveDb',
        generation: context.generation,
        reason: 'overlap_capability_unproven',
      };
    },
    publishLifecycle() {},
    restart() {
      restartAttempts += 1;
      const error = new Error('release evidence inconclusive');
      error.reloadRetryAfterMs = 25;
      throw error;
    },
  });
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [serverExecutor],
    calls,
    coordinatorBoundary: {
      setTimeoutImpl(callback, delayMs) {
        const timer = { callback, delayMs, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      clearTimeoutImpl() {},
    },
  });

  server.set('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });

  assert.equal(restartAttempts, 1);
  assert.deepEqual(calls.filter((entry) => Array.isArray(entry)), [
    ['server', 'lifecycle', {
      phase: 'planned',
      plan: { mode: 'exclusiveDb', generation: 1, reason: 'overlap_capability_unproven' },
    }],
    ['server', 'lifecycle', {
      phase: 'retry-scheduled',
      plan: { mode: 'exclusiveDb', generation: 1, reason: 'overlap_capability_unproven' },
      retryAfterMs: 25,
    }],
  ]);

  serverExecutor.build = async () => { throw new Error('preflight failed'); };
  server.set('2');
  await onChange({ eventType: 'change', filename: 'schema.prisma' });
  assert.deepEqual(calls.filter((entry) => Array.isArray(entry)).at(-2), [
    'server',
    'lifecycle',
    { phase: 'planned', plan: { mode: 'exclusiveDb', generation: 2, reason: 'overlap_capability_unproven' } },
  ]);
  assert.deepEqual(calls.filter((entry) => Array.isArray(entry)).at(-1), [
    'server',
    'lifecycle',
    {
      phase: 'blocked',
      plan: { mode: 'exclusiveDb', generation: 2, reason: 'overlap_capability_unproven' },
      disposition: { code: 'build_failed' },
    },
  ]);
});

test('a later daemon build failure terminalizes the server lifecycle already published as planned', async () => {
  const calls = [];
  const lifecycle = [];
  const shared = descriptor({ id: 'shared:protocol', target: 'shared' });
  const onChange = startCoordinator({
    descriptors: [shared],
    executors: [
      executor('server', calls, {
        createPlan(context) {
          return {
            mode: 'exclusiveDb',
            generation: context.generation,
            reason: 'server_reload',
          };
        },
        publishLifecycle(transition) {
          lifecycle.push(transition);
        },
      }),
      executor('daemon', calls, {
        build() {
          throw new Error('daemon build failed');
        },
      }),
    ],
    calls,
  });

  shared.set('1');
  await onChange({ eventType: 'change', filename: 'types.ts' });

  assert.deepEqual(lifecycle.map(({ phase }) => phase), ['planned', 'blocked']);
  assert.equal(lifecycle[1].disposition.code, 'build_failed');
  assert.equal(lifecycle[1].plan.generation, 1);
});

function startCoordinator({ descriptors, executors, calls, logger = { error() {} }, coordinatorBoundary = {} }) {
  let onChange = null;
  let onObservation = null;
  const watcher = startDevReloadCoordinator(
    { enabled: true, descriptors, executors, logger },
    {
      watchDebouncedImpl: ({ paths, onChange: captured, onObservation: capturedObservation, readSignature, pollIntervalMs }) => {
        calls.push(`watch:${paths.sort().join('|')}:${typeof readSignature}:${pollIntervalMs}`);
        onChange = captured;
        onObservation = capturedObservation;
        onChange.readSignature = readSignature;
        return { close() {} };
      },
      ...coordinatorBoundary,
    },
  );
  assert.ok(watcher);
  assert.equal(typeof onChange, 'function');
  onChange.observe = (event) => onObservation?.(event);
  onChange.watcher = watcher;
  return onChange;
}

test('explicit startup reconciliation rebuilds one requested target without a filesystem edit', async () => {
  const calls = [];
  const daemon = descriptor({ id: 'daemon:cli', target: 'daemon' });
  const onChange = startCoordinator({
    descriptors: [daemon],
    executors: [executor('daemon', calls)],
    calls,
  });

  await onChange.watcher.requestReload('daemon');

  assert.deepEqual(calls.slice(1), ['daemon:build:1', 'daemon:restart:1']);
});

test('reload coordinator uses asynchronous descriptor signatures for background polling', async () => {
  const calls = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let asyncReads = 0;
  server.readSignatureAsync = async () => {
    asyncReads += 1;
    return server.readSignature();
  };
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls)],
    calls,
  });

  const signaturePromise = onChange.readSignature();
  assert.equal(typeof signaturePromise?.then, 'function');
  assert.equal(await signaturePromise, 'server:app\u00000');
  assert.equal(asyncReads, 1, 'startup baseline and overlapping poll must share one asynchronous scan');
});

test('construction shares one signature scan between coordinator and watcher baselines', async () => {
  const server = deferredAsyncDescriptor({ id: 'server:app', target: 'server' });
  let watcherBaseline;
  const coordinator = startDevReloadCoordinator(
    {
      enabled: true,
      descriptors: [server],
      executors: [executor('server', [])],
      logger: { error() {} },
    },
    {
      watchDebouncedImpl({ readSignature }) {
        watcherBaseline = readSignature();
        return { close() {} };
      },
    },
  );

  const constructionMetrics = server.metrics();
  server.resolvePendingReads();
  await watcherBaseline;
  coordinator.close();

  assert.equal(constructionMetrics.readCalls, 1);
  assert.equal(constructionMetrics.maxActiveReads, 1);
});

test('polling and filesystem classification share one in-flight signature scan', async () => {
  const calls = [];
  const server = deferredAsyncDescriptor({ id: 'server:app', target: 'server' });
  let onChange;
  let readSignature;
  let watcherBaseline;
  const coordinator = startDevReloadCoordinator(
    {
      enabled: true,
      descriptors: [server],
      executors: [executor('server', calls)],
      logger: { error() {} },
    },
    {
      watchDebouncedImpl(boundary) {
        onChange = boundary.onChange;
        readSignature = boundary.readSignature;
        watcherBaseline = readSignature();
        return { close() {} };
      },
    },
  );

  server.resolvePendingReads();
  await watcherBaseline;
  await new Promise((resolve) => setImmediate(resolve));
  server.resetMetrics();
  server.set('1');

  const poll = readSignature();
  const filesystemChange = onChange({ eventType: 'change', filename: 'app.ts' });
  await new Promise((resolve) => setImmediate(resolve));
  const overlapMetrics = server.metrics();
  server.resolvePendingReads();
  await new Promise((resolve) => setImmediate(resolve));
  server.resolvePendingReads();
  await new Promise((resolve) => setImmediate(resolve));
  server.resolvePendingReads();
  await Promise.all([poll, filesystemChange]);
  coordinator.close();

  assert.equal(overlapMetrics.readCalls, 1);
  assert.equal(overlapMetrics.maxActiveReads, 1);
  assert.deepEqual(calls, ['server:build:1', 'server:restart:1']);
});

test('a filesystem edit observed during the startup baseline is not absorbed by that baseline', async () => {
  const calls = [];
  const server = deferredAsyncDescriptor({ id: 'server:app', target: 'server' });
  let onChange;
  let watcherBaseline;
  const coordinator = startDevReloadCoordinator(
    {
      enabled: true,
      descriptors: [server],
      executors: [executor('server', calls)],
      logger: { error() {} },
    },
    {
      watchDebouncedImpl(boundary) {
        onChange = boundary.onChange;
        watcherBaseline = boundary.readSignature();
        return { close() {} };
      },
    },
  );

  const startupEdit = onChange({
    eventType: 'change',
    filename: 'app.ts',
    signatureInitializedAtObservation: false,
  });
  server.set('1');
  server.resolvePendingReads();
  await watcherBaseline;
  await new Promise((resolve) => setImmediate(resolve));
  server.resolvePendingReads();
  await new Promise((resolve) => setImmediate(resolve));
  server.resolvePendingReads();
  await new Promise((resolve) => setImmediate(resolve));
  server.resolvePendingReads();
  await startupEdit;
  coordinator.close();

  assert.deepEqual(calls, ['server:build:1', 'server:restart:1']);
});

test('a startup-baseline event restarts only the consumer that owns its watched path', async () => {
  const calls = [];
  const daemon = descriptor({ id: 'daemon:cli', target: 'daemon' });
  const server = descriptor({ id: 'server:app', target: 'server' });
  const onChange = startCoordinator({
    descriptors: [daemon, server],
    executors: [
      executor('daemon', calls),
      executor('server', calls),
    ],
    calls,
  });

  daemon.set('1');
  await onChange({
    eventType: 'change',
    filename: 'index.ts',
    watchPath: '/tmp/daemon:cli',
    signatureInitializedAtObservation: false,
  });

  assert.deepEqual(
    calls.filter((call) => typeof call === 'string' && /:(?:build|restart):/.test(call)),
    ['daemon:build:1', 'daemon:restart:1'],
  );
});

test('reload coordinator establishes its startup baseline without synchronous descriptor scans', async () => {
  const calls = [];
  let syncReads = 0;
  let asyncReads = 0;
  const server = {
    id: 'server:app',
    target: 'server',
    paths: ['/tmp/server-app'],
    readSignature() {
      syncReads += 1;
      return '0';
    },
    async readSignatureAsync() {
      asyncReads += 1;
      return '0';
    },
  };

  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls)],
    calls,
  });

  assert.equal(syncReads, 0, 'coordinator construction must not block the stable proxy event loop');
  assert.ok(asyncReads >= 1);
  await onChange.readSignature();
  assert.equal(syncReads, 0);
});

test('duplicate descriptor ids use one merged-path signature observation per cycle', async () => {
  const calls = [];
  let firstReads = 0;
  let secondReads = 0;
  const first = {
    id: 'shared:protocol',
    target: 'shared',
    paths: ['/tmp/hstack-duplicate-signature-path'],
    readSignature: () => 'first',
    async readSignatureAsync() {
      firstReads += 1;
      return 'first';
    },
  };
  const second = {
    ...first,
    readSignature: () => 'second',
    async readSignatureAsync() {
      secondReads += 1;
      return 'second';
    },
  };
  const onChange = startCoordinator({
    descriptors: [first, second],
    executors: [executor('server', calls), executor('daemon', calls)],
    calls,
  });

  assert.equal(await onChange.readSignature(), 'shared:protocol\u0000');
  assert.equal(firstReads, 0);
  assert.equal(secondReads, 0);
});

test('a restart failure can request one bounded coordinator retry without another filesystem edit', async () => {
  const calls = [];
  const scheduled = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let attempts = 0;
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      restart() {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('release evidence inconclusive');
          error.reloadRetryAfterMs = 25;
          throw error;
        }
      },
    })],
    calls,
    coordinatorBoundary: {
      setTimeoutImpl(callback, delayMs) {
        const timer = { callback, delayMs, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      clearTimeoutImpl() {},
    },
  });

  server.set('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });
  assert.equal(attempts, 1);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delayMs, 25);

  await onChange({ eventType: 'change', filename: 'duplicate.ts' });
  assert.equal(attempts, 1, 'only the scheduled timer callback may start the retry');

  await scheduled[0].callback();
  assert.equal(attempts, 2);
  assert.equal(scheduled.length, 1, 'the retry must not create a second retry manager');

  await scheduled[0].callback();
  assert.equal(attempts, 2, 'success must make the completed retry callback stale');
});

test('a retryable build rejection gets one bounded retry while ordinary build failures stay terminal for an unchanged signature', async () => {
  const calls = [];
  const scheduled = [];
  const lifecycle = [];
  const daemon = descriptor({ id: 'daemon:cli', target: 'daemon' });
  let attempts = 0;
  const onChange = startCoordinator({
    descriptors: [daemon],
    executors: [executor('daemon', calls, {
      build() {
        attempts += 1;
        const error = new Error(attempts < 3 ? 'mixed-input build rejected' : 'TypeScript compilation failed');
        if (attempts < 3) error.reloadRetryAfterMs = 25;
        throw error;
      },
      publishLifecycle(transition) {
        lifecycle.push(transition);
      },
    })],
    calls,
    coordinatorBoundary: {
      setTimeoutImpl(callback, delayMs) {
        const timer = { callback, delayMs, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      clearTimeoutImpl() {},
    },
  });

  daemon.set('1');
  await onChange({ eventType: 'change', filename: 'index.ts' });
  assert.equal(attempts, 1);
  assert.deepEqual(scheduled.map(({ delayMs }) => delayMs), [25]);
  assert.deepEqual(lifecycle.map(({ phase }) => phase), ['planned', 'retry-scheduled']);

  await onChange({ eventType: 'change', filename: 'duplicate.ts' });
  assert.equal(attempts, 1, 'duplicate notifications must not bypass the scheduled build retry');

  await scheduled[0].callback();
  assert.equal(attempts, 2);
  assert.equal(scheduled.length, 1, 'the retried build rejection must consume the existing retry episode');
  assert.deepEqual(lifecycle.map(({ phase }) => phase), [
    'planned',
    'retry-scheduled',
    'planned',
    'blocked',
  ]);

  await onChange({ eventType: 'change', filename: 'duplicate-after-retry.ts' });
  assert.equal(attempts, 2, 'the consumed retry must stay terminal until the source signature changes');

  daemon.set('2');
  await onChange({ eventType: 'change', filename: 'compile-error.ts' });
  await onChange({ eventType: 'change', filename: 'duplicate-compile-error.ts' });
  assert.equal(attempts, 3, 'an ordinary build failure must stay terminal for its source signature');
  assert.equal(scheduled.length, 1, 'an ordinary build failure must not schedule a retry');
  assert.deepEqual(lifecycle.map(({ phase }) => phase).slice(-2), ['planned', 'blocked']);
});

test('the coordinator alone projects transient retry and exhausted terminal disposition', async () => {
  const calls = [];
  const scheduled = [];
  const dispositions = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      restart() {
        const error = new Error('replacement exited early');
        error.reloadRetryAfterMs = 25;
        throw error;
      },
      publishFailureDisposition(disposition) {
        dispositions.push(disposition);
      },
    })],
    calls,
    coordinatorBoundary: {
      setTimeoutImpl(callback, delayMs) {
        const timer = { callback, delayMs, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      clearTimeoutImpl() {},
    },
  });

  server.set('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });
  assert.equal(dispositions.length, 1);
  assert.equal(dispositions[0].retryScheduled, true);
  assert.equal(dispositions[0].retryAfterMs, 25);

  await scheduled[0].callback();
  assert.equal(dispositions.length, 2);
  assert.equal(dispositions[1].retryScheduled, false);
  assert.equal(dispositions[1].retryAfterMs, null);
});

test('an unexpected active-server exit re-enters the existing coordinator and close disarms it', async () => {
  const calls = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let unexpectedExitHandler = null;
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      setUnexpectedExitHandler(handler) {
        unexpectedExitHandler = handler;
      },
    })],
    calls,
  });

  assert.equal(typeof unexpectedExitHandler, 'function');
  await unexpectedExitHandler({ code: 1, signal: null });
  assert.deepEqual(
    calls.filter((call) => typeof call === 'string' && /:(?:build|restart):/.test(call)),
    ['server:build:1', 'server:restart:1'],
  );

  await onChange.watcher.close();
  assert.equal(unexpectedExitHandler, null);
});

test('an unexpected active-server exit restores admitted prior availability before source preparation', async () => {
  const calls = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let unexpectedExitHandler = null;
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      setUnexpectedExitHandler(handler) {
        unexpectedExitHandler = handler;
      },
      async recoverUnexpectedExit() {
        calls.push('server:recover-prior');
      },
    })],
    calls,
  });

  await unexpectedExitHandler({ code: 1, signal: null });

  assert.deepEqual(
    calls.filter((call) => typeof call === 'string').slice(1),
    ['server:recover-prior', 'server:build:1', 'server:restart:1'],
  );
  await onChange.watcher.close();
});

test('a pathless no-delta observation does not supersede an active forced reload', async () => {
  const calls = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let unexpectedExitHandler = null;
  let notifyBuildStarted;
  const buildStarted = new Promise((resolve) => { notifyBuildStarted = resolve; });
  let releaseBuild;
  const buildBlocked = new Promise((resolve) => { releaseBuild = resolve; });
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      setUnexpectedExitHandler(handler) {
        unexpectedExitHandler = handler;
      },
      async build(context) {
        if (context.generation === 1) {
          notifyBuildStarted();
          await buildBlocked;
        }
      },
    })],
    calls,
  });

  const recovery = unexpectedExitHandler({ code: 1, signal: null });
  await buildStarted;
  assert.equal(onChange.observe({ eventType: 'change', filename: null }), true);
  releaseBuild();
  await recovery;

  assert.deepEqual(
    calls.filter((call) => typeof call === 'string' && /:(?:build|restart):/.test(call)),
    ['server:build:1', 'server:restart:1'],
  );

  await onChange.watcher.close();
});

test('a pathless observation supersedes an active reload when its descriptor signature changed', async () => {
  const calls = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let unexpectedExitHandler = null;
  let notifyBuildStarted;
  const buildStarted = new Promise((resolve) => { notifyBuildStarted = resolve; });
  let releaseBuild;
  const buildBlocked = new Promise((resolve) => { releaseBuild = resolve; });
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      setUnexpectedExitHandler(handler) {
        unexpectedExitHandler = handler;
      },
      async build(context) {
        if (context.generation === 1) {
          notifyBuildStarted();
          await buildBlocked;
        }
      },
    })],
    calls,
  });

  const recovery = unexpectedExitHandler({ code: 1, signal: null });
  await buildStarted;
  server.set('1');
  assert.equal(onChange.observe({ eventType: 'change', filename: null }), true);
  releaseBuild();
  await recovery;

  assert.deepEqual(
    calls.filter((call) => typeof call === 'string' && /:(?:build|restart):/.test(call)),
    ['server:build:1', 'server:build:2', 'server:restart:2'],
  );

  await onChange.watcher.close();
});

test('retry remains authoritative when retry lifecycle projection fails', async () => {
  const calls = [];
  const scheduled = [];
  const errors = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let attempts = 0;
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      publishLifecycle(transition) {
        if (transition.phase === 'retry-scheduled') throw new Error('runtime projection unavailable');
      },
      restart() {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('release evidence inconclusive');
          error.reloadRetryAfterMs = 25;
          throw error;
        }
      },
    })],
    calls,
    logger: { log() {}, warn() {}, error(message) { errors.push(String(message)); } },
    coordinatorBoundary: {
      setTimeoutImpl(callback, delayMs) {
        const timer = { callback, delayMs, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      clearTimeoutImpl() {},
    },
  });

  server.set('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });

  assert.equal(scheduled.length, 1, 'projection failure must not suppress the authoritative retry');
  assert.ok(errors.some((message) => message.includes('runtime projection unavailable')));
  await onChange({ eventType: 'change', filename: 'duplicate.ts' });
  assert.equal(attempts, 1, 'projection failure must not let a duplicate event bypass the scheduled retry');
  await scheduled[0].callback();
  assert.equal(attempts, 2);
  assert.equal(scheduled.length, 1, 'projection failure must not duplicate the bounded retry');
});

test('the same failed signature cannot re-arm another retry after its bounded retry is consumed', async () => {
  const calls = [];
  const scheduled = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let attempts = 0;
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      restart() {
        attempts += 1;
        const error = new Error('still unavailable');
        error.reloadRetryAfterMs = 25;
        throw error;
      },
    })],
    calls,
    coordinatorBoundary: {
      setTimeoutImpl(callback, delayMs) {
        const timer = { callback, delayMs, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      clearTimeoutImpl() {},
    },
  });

  server.set('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });
  await scheduled[0].callback();

  assert.equal(attempts, 2);
  assert.equal(scheduled.length, 1, 'unchanged failure must consume its only retry');

  await onChange({ eventType: 'change', filename: 'duplicate.ts' });
  assert.equal(attempts, 2, 'duplicate watcher notifications must not bypass the consumed retry episode');
});

test('executor backoff defers the dirty episode instead of committing a skipped restart', async () => {
  const calls = [];
  const scheduled = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let attempts = 0;
  const serverExecutor = executor('server', calls, {
    restart() {
      attempts += 1;
      return attempts === 1
        ? { skipped: true, reason: 'backoff', retryAfterMs: 41 }
        : { restarted: true };
    },
  });
  serverExecutor.getBackoffRemainingMs = () => {
    throw new Error('the coordinator must not re-read a changing backoff clock');
  };
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [serverExecutor],
    calls,
    coordinatorBoundary: {
      setTimeoutImpl(callback, delayMs) {
        const timer = { callback, delayMs, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      clearTimeoutImpl() {},
    },
  });

  server.set('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });

  assert.equal(attempts, 1);
  assert.deepEqual(scheduled.map(({ delayMs }) => delayMs), [41]);

  await scheduled[0].callback();
  assert.equal(attempts, 2);
});

test('closing the coordinator cancels a pending retry and makes its callback stale', async () => {
  const calls = [];
  const scheduled = [];
  const cleared = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let attempts = 0;
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      restart() {
        attempts += 1;
        const error = new Error('temporarily unavailable');
        error.reloadRetryAfterMs = 25;
        throw error;
      },
    })],
    calls,
    coordinatorBoundary: {
      setTimeoutImpl(callback, delayMs) {
        const timer = { callback, delayMs, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      clearTimeoutImpl(timer) { cleared.push(timer); },
    },
  });

  server.set('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });
  const staleTimer = scheduled[0];
  onChange.watcher.close();

  assert.deepEqual(cleared, [staleTimer]);
  await staleTimer.callback();
  assert.equal(attempts, 1);
});

test('closing the coordinator prevents an in-flight restart failure from scheduling a retry', async () => {
  const calls = [];
  const scheduled = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let rejectRestart;
  let restartStarted;
  const didStartRestart = new Promise((resolve) => {
    restartStarted = resolve;
  });
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      restart() {
        restartStarted();
        return new Promise((_resolve, reject) => {
          rejectRestart = reject;
        });
      },
    })],
    calls,
    coordinatorBoundary: {
      setTimeoutImpl(callback, delayMs) {
        const timer = { callback, delayMs, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      clearTimeoutImpl() {},
    },
  });

  server.set('1');
  const change = onChange({ eventType: 'change', filename: 'app.ts' });
  await didStartRestart;
  onChange.watcher.close();
  const error = new Error('release evidence inconclusive after close');
  error.reloadRetryAfterMs = 25;
  rejectRestart(error);
  await change;

  assert.equal(scheduled.length, 0, 'teardown must not create new lifecycle work');
});

test('closing the coordinator joins the in-flight cycle before resolving', async () => {
  const calls = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let releaseRestart;
  let markRestartStarted;
  const restartStarted = new Promise((resolve) => { markRestartStarted = resolve; });
  const restartBlocked = new Promise((resolve) => { releaseRestart = resolve; });
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      async restart() {
        markRestartStarted();
        await restartBlocked;
      },
    })],
    calls,
  });

  server.set('1');
  const change = onChange({ eventType: 'change', filename: 'app.ts' });
  await restartStarted;
  let closeResolved = false;
  const close = Promise.resolve(onChange.watcher.close()).then(() => { closeResolved = true; });
  await Promise.resolve();
  assert.equal(closeResolved, false, 'close must join the active restart cycle');

  releaseRestart();
  await Promise.all([change, close]);
  assert.equal(closeResolved, true);
});

test('closing during executor-facing generation revalidation revokes activation authority', async () => {
  const calls = [];
  const server = deferredAsyncDescriptor({ id: 'server:app', target: 'server' });
  let markExecutorRevalidationStarted;
  const executorRevalidationStarted = new Promise((resolve) => { markExecutorRevalidationStarted = resolve; });
  let revalidationResult = null;
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      async restart(context) {
        const revalidation = context.revalidateGeneration();
        markExecutorRevalidationStarted();
        revalidationResult = await revalidation;
        throw new Error('stop after observing executor-facing revalidation');
      },
    })],
    calls,
  });

  server.resolvePendingReads();
  await new Promise((resolve) => setImmediate(resolve));
  server.set('1');
  const change = onChange({ eventType: 'change', filename: 'app.ts' });
  for (let read = 0; read < 2; read += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(server.metrics().pendingReads, 1);
    server.resolvePendingReads();
  }
  await executorRevalidationStarted;
  assert.equal(server.metrics().pendingReads, 1);

  const close = onChange.watcher.close();
  server.resolvePendingReads();
  await Promise.all([change, close]);

  assert.equal(revalidationResult, false);
});

test('a changed signature fences a stale generation before destructive restart activation', async () => {
  const calls = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let releaseBuild;
  let markBuildStarted;
  const buildStarted = new Promise((resolve) => { markBuildStarted = resolve; });
  const buildBlocked = new Promise((resolve) => { releaseBuild = resolve; });
  const activations = [];
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      async build(context) {
        if (context.generation === 1) {
          markBuildStarted();
          await buildBlocked;
        }
      },
      async restart(context) {
        assert.equal(await context.revalidateGeneration(), true);
        activations.push(context.generation);
      },
    })],
    calls,
  });

  server.set('1');
  const first = onChange({ eventType: 'change', filename: 'first.ts' });
  await buildStarted;
  server.set('2');
  const trailing = onChange({ eventType: 'change', filename: 'second.ts' });
  releaseBuild();
  await Promise.all([first, trailing]);

  assert.deepEqual(activations, [2]);
});

test('a terminally published daemon build activates before a superseding watch generation replans', async () => {
  const calls = [];
  const daemon = descriptor({ id: 'daemon:app', target: 'daemon' });
  const activations = [];
  const onChange = startCoordinator({
    descriptors: [daemon],
    executors: [executor('daemon', calls, {
      async build(context) {
        if (context.generation === 1) {
          daemon.set('2');
          return { allowSupersededActivation: true };
        }
        return undefined;
      },
      async restart(context) {
        activations.push(context.generation);
      },
    })],
    calls,
  });

  daemon.set('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });

  assert.deepEqual(activations, [1, 2]);
});

test('terminal publication authority cannot bypass stale-generation fencing for the server target', async () => {
  const calls = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  const activations = [];
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      async build(context) {
        if (context.generation === 1) {
          server.set('2');
          return { allowSupersededActivation: true };
        }
        return undefined;
      },
      async restart(context) {
        activations.push(context.generation);
      },
    })],
    calls,
  });

  server.set('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });

  assert.deepEqual(activations, [2]);
});

test('a named Prisma observation during the pre-activation sampling gap revokes the app-only generation', async () => {
  for (const eventType of ['change', 'rename']) {
    const calls = [];
    const app = descriptor({ id: 'server:app', target: 'server' });
    let prismaSignature = '0';
    let hideNextPrismaSignature = false;
    const prisma = {
      id: 'server:prisma',
      target: 'server',
      paths: ['/tmp/server:prisma'],
      set(value) {
        prismaSignature = value;
      },
      hideNextRead() {
        hideNextPrismaSignature = true;
      },
      readSignature() {
        if (hideNextPrismaSignature) {
          hideNextPrismaSignature = false;
          return '0';
        }
        return prismaSignature;
      },
    };
    let observe = () => {};
    const activations = [];
    const onChange = startCoordinator({
      descriptors: [app, prisma],
      executors: [executor('server', calls, {
        async restart(context) {
          if (context.generation === 1) {
            assert.equal(await context.revalidateGeneration(), true);
            prisma.set('1');
            prisma.hideNextRead();
            observe({ eventType, filename: 'schema.prisma' });
          }
          if (await context.revalidateGeneration()) activations.push(context.generation);
        },
      })],
      calls,
    });
    observe = onChange.observe;

    app.set('1');
    await onChange({ eventType: 'change', filename: 'app.ts' });

    assert.deepEqual(
      activations,
      [2],
      `${eventType} must revoke the stale pre-activation generation`,
    );
  }
});

test('an ignored test-only observation does not revoke an in-flight production generation', async () => {
  const calls = [];
  const app = descriptor({ id: 'server:app', target: 'server' });
  let observe = () => {};
  const activations = [];
  const onChange = startCoordinator({
    descriptors: [app],
    executors: [executor('server', calls, {
      async restart(context) {
        if (context.generation === 1) {
          observe({ eventType: 'change', filename: 'session.spec.ts' });
        }
        if (await context.revalidateGeneration()) activations.push(context.generation);
      },
    })],
    calls,
  });
  observe = onChange.observe;

  app.set('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });

  assert.deepEqual(activations, [1]);
});

test('a handled debounce delivery cannot suppress a distinct edit during the replanned cycle', async () => {
  const calls = [];
  const app = descriptor({ id: 'server:app', target: 'server' });
  let prismaSignature = '0';
  let hideNextPrismaSignature = false;
  const prisma = {
    id: 'server:prisma',
    target: 'server',
    paths: ['/tmp/server:prisma'],
    set(value) {
      prismaSignature = value;
    },
    hideNextRead() {
      hideNextPrismaSignature = true;
    },
    readSignature() {
      if (hideNextPrismaSignature) {
        hideNextPrismaSignature = false;
        return String(Number(prismaSignature) - 1);
      }
      return prismaSignature;
    },
  };
  let observe = () => {};
  let deliverDebounced = () => {};
  const activations = [];
  const onChange = startCoordinator({
    descriptors: [app, prisma],
    executors: [executor('server', calls, {
      async restart(context) {
        if (context.generation <= 2) {
          assert.equal(await context.revalidateGeneration(), true);
          prisma.set(String(context.generation));
          prisma.hideNextRead();
          observe({ eventType: 'change', filename: 'schema.prisma' });
          deliverDebounced({
            eventType: 'change',
            filename: 'schema.prisma',
            observationHandled: true,
          });
        }
        if (await context.revalidateGeneration()) activations.push(context.generation);
      },
    })],
    calls,
  });
  observe = onChange.observe;
  deliverDebounced = onChange;

  app.set('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });

  assert.deepEqual(activations, [3]);
});

test('a new signature cancels the old retry and starts a fresh bounded retry episode', async () => {
  const calls = [];
  const scheduled = [];
  const cleared = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let attempts = 0;
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [executor('server', calls, {
      restart() {
        attempts += 1;
        const error = new Error('temporarily unavailable');
        error.reloadRetryAfterMs = 25;
        throw error;
      },
    })],
    calls,
    coordinatorBoundary: {
      setTimeoutImpl(callback, delayMs) {
        const timer = { callback, delayMs, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      clearTimeoutImpl(timer) { cleared.push(timer); },
    },
  });

  server.set('1');
  await onChange({ eventType: 'change', filename: 'first.ts' });
  const staleTimer = scheduled[0];

  server.set('2');
  await onChange({ eventType: 'change', filename: 'second.ts' });

  assert.deepEqual(cleared, [staleTimer]);
  assert.equal(scheduled.length, 2);
  await staleTimer.callback();
  assert.equal(attempts, 2, 'a canceled timer must not replay an old signature episode');
});

test('shared edits build all targets before restarting server then daemon', async () => {
  const calls = [];
  const shared = descriptor({ id: 'shared:protocol', target: 'shared' });
  const onChange = startCoordinator({
    descriptors: [shared],
    executors: [executor('daemon', calls), executor('server', calls)],
    calls,
  });

  shared.set('1');
  await onChange({ eventType: 'change', filename: 'index.ts' });

  assert.deepEqual(calls.slice(1), [
    'server:build:1',
    'daemon:build:1',
    'server:restart:1',
    'daemon:restart:1',
  ]);
});

test('a skipped build is not admitted for restart', async () => {
  const calls = [];
  const daemon = descriptor({ id: 'daemon:cli', target: 'daemon' });
  const onChange = startCoordinator({
    descriptors: [daemon],
    executors: [{
      target: 'daemon',
      async build() {
        calls.push('daemon:build');
        return { skipped: true, reason: 'cli-build-mode_never' };
      },
      async restart() {
        calls.push('daemon:restart');
        return { restarted: true };
      },
    }],
    calls,
  });

  daemon.set('1');
  await onChange({ eventType: 'change', filename: 'index.ts' });

  assert.deepEqual(calls.slice(1), ['daemon:build']);
});

test('failed build skips restarts and later changes can retry', async () => {
  const calls = [];
  const errors = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  const onChange = startCoordinator({
    descriptors: [server],
    executors: [
      executor('server', calls, {
        build() {
          throw new Error('preflight failed');
        },
      }),
    ],
    calls,
    logger: { error(message) { errors.push(String(message)); } },
  });

  server.set('1');
  await onChange({});
  server.set('2');
  await onChange({});

  assert.deepEqual(calls.slice(1), ['server:build:1', 'server:build:2']);
  assert.ok(errors.some((message) => message.includes('preflight failed')));
});

test('failed shared transaction stays dirty until all affected targets restart', async () => {
  const calls = [];
  let daemonBuildAttempts = 0;
  const shared = descriptor({ id: 'shared:protocol', target: 'shared' });
  const daemon = descriptor({ id: 'daemon:cli', target: 'daemon' });
  const onChange = startCoordinator({
    descriptors: [shared, daemon],
    executors: [
      executor('server', calls),
      executor('daemon', calls, {
        build() {
          daemonBuildAttempts += 1;
          if (daemonBuildAttempts === 1) {
            throw new Error('daemon build failed');
          }
        },
      }),
    ],
    calls,
  });

  shared.set('1');
  await onChange({});
  assert.deepEqual(calls.slice(1), ['server:build:1', 'daemon:build:1']);

  daemon.set('1');
  await onChange({});
  assert.deepEqual(calls.slice(1), [
    'server:build:1',
    'daemon:build:1',
    'server:build:2',
    'daemon:build:2',
    'server:restart:2',
    'daemon:restart:2',
  ]);
});

test('changes during a running cycle collapse into one trailing cycle', async () => {
  const calls = [];
  const daemon = descriptor({ id: 'daemon:cli', target: 'daemon' });
  let onChange = null;
  onChange = startCoordinator({
    descriptors: [daemon],
    executors: [
      executor('daemon', calls, {
        async restart(context) {
          if (context.cycle === 1) {
            daemon.set('2');
            await onChange({});
            daemon.set('3');
            await onChange({});
          }
        },
      }),
    ],
    calls,
  });

  daemon.set('1');
  await onChange({});

  assert.deepEqual(calls.slice(1), [
    'daemon:build:1',
    'daemon:restart:1',
    'daemon:build:2',
    'daemon:restart:2',
  ]);
});

test('a successful activation can request one forced trailing build without another filesystem edit', async () => {
  const calls = [];
  const daemon = descriptor({ id: 'daemon:cli-publication', target: 'daemon' });
  const onChange = startCoordinator({
    descriptors: [daemon],
    executors: [
      executor('daemon', calls, {
        build(context) {
          return context.cycle === 1 ? { requestFollowup: true } : undefined;
        },
      }),
    ],
    calls,
  });

  daemon.set('1');
  await onChange({ eventType: 'change', filename: '.build-manifest.json' });

  assert.deepEqual(calls.slice(1), [
    'daemon:build:1',
    'daemon:restart:1',
    'daemon:build:2',
    'daemon:restart:2',
  ]);
});

test('a superseded generation clears its server lifecycle plan before the trailing generation is planned', async () => {
  const calls = [];
  const lifecycle = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let onChange = null;
  onChange = startCoordinator({
    descriptors: [server],
    executors: [
      executor('server', calls, {
        createPlan(context) {
          return { mode: 'exclusiveDb', generation: context.generation };
        },
        publishLifecycle(transition) {
          lifecycle.push(transition);
        },
        async build(context) {
          if (context.cycle === 1) {
            server.set('2');
            await onChange({ eventType: 'change', filename: 'second.ts' });
            return { skipped: true, reason: 'superseded-preflight' };
          }
        },
      }),
    ],
    calls,
  });

  server.set('1');
  await onChange({ eventType: 'change', filename: 'first.ts' });

  assert.deepEqual(lifecycle.map(({ phase }) => phase), ['planned', 'idle', 'planned']);
  assert.deepEqual(calls.filter((call) => String(call).startsWith('server:restart:')), ['server:restart:2']);
});

test('a failed idle projection does not suppress the trailing superseding generation', async () => {
  const calls = [];
  const errors = [];
  const server = descriptor({ id: 'server:app', target: 'server' });
  let onChange = null;
  onChange = startCoordinator({
    descriptors: [server],
    executors: [
      executor('server', calls, {
        publishLifecycle(transition) {
          if (transition.phase === 'idle') {
            throw new Error('runtime projection unavailable');
          }
        },
        async build(context) {
          if (context.cycle === 1) {
            server.set('2');
            await onChange({ eventType: 'change', filename: 'second.ts' });
            return { skipped: true, reason: 'superseded-preflight' };
          }
        },
      }),
    ],
    calls,
    logger: { log() {}, warn() {}, error(message) { errors.push(String(message)); } },
  });

  server.set('1');
  await onChange({ eventType: 'change', filename: 'first.ts' });

  assert.deepEqual(calls.filter((call) => String(call).startsWith('server:restart:')), ['server:restart:2']);
  assert.ok(errors.some((message) => message.includes('runtime projection unavailable')));
});

test('a superseded activation-capable build reaches its executor while exactly one latest generation remains pending', async () => {
  const calls = [];
  const daemon = descriptor({ id: 'daemon:cli', target: 'daemon' });
  let onChange = null;
  onChange = startCoordinator({
    descriptors: [daemon],
    executors: [
      executor('daemon', calls, {
        async build(context) {
          if (context.cycle === 1) {
            daemon.set('2');
            await onChange({ eventType: 'change', filename: 'second.ts' });
            return { ok: true, allowSupersededActivation: true };
          }
          return { ok: true };
        },
        async restart(context) {
          calls.push(`generation-current:${context.generation}:${await context.revalidateGeneration()}`);
        },
      }),
    ],
    calls,
  });

  daemon.set('1');
  await onChange({ eventType: 'change', filename: 'first.ts' });

  assert.deepEqual(calls.slice(1), [
    'daemon:build:1',
    'daemon:restart:1',
    'generation-current:1:false',
    'daemon:build:2',
    'daemon:restart:2',
    'generation-current:2:true',
  ]);
});
