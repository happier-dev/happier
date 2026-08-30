import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isDevRuntimeReloadIgnoredPath,
  readDevReloadWatchChangeSignature,
  readDevReloadWatchChangeSignatureAsync,
  resolveDevReloadPollIntervalMs,
  startDevReloadCoordinator,
} from './devReloadCoordinator.mjs';
import { createDevServerReloadPlan } from './server.mjs';
import { watchDebounced } from '../proc/watch.mjs';

function createDescriptor({ id, target, initial = '0', paths = [`/tmp/${id}`] }) {
  let signature = initial;
  return {
    id,
    target,
    paths,
    setSignature(value) {
      signature = value;
    },
    readSignature() {
      return signature;
    },
  };
}

function createDeferredAsyncDescriptor({ id, target, initial = '0' }) {
  let current = initial;
  let activeReads = 0;
  let maxActiveReads = 0;
  let readCalls = 0;
  const pendingReads = [];
  return {
    id,
    target,
    paths: [`/tmp/${id}`],
    setSignature(value) {
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
    metrics() {
      return { activeReads, maxActiveReads, readCalls, pendingReads: pendingReads.length };
    },
  };
}

function createExecutor(target, calls, overrides = {}) {
  return {
    target,
    ...(typeof overrides.createPlan === 'function' ? {
      createPlan(context) {
        return overrides.createPlan(context);
      },
    } : {}),
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
    ...(typeof overrides.publishLifecycle === 'function' ? {
      async publishLifecycle(transition) {
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
  const app = createDescriptor({ id: 'server:app', target: 'server' });
  const coordinator = startDevReloadCoordinator({
    enabled: true,
    descriptors: [app],
    executors: [createExecutor('server', calls, {
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
  app.setSignature('1');
  emitFilesystemEvent('change', 'app.ts');
  const filesystemDebounce = debounceTimers.shift();
  assert.ok(filesystemDebounce && !filesystemDebounce.canceled);
  filesystemDebounce.callback();
  await firstRestartStarted;

  if (laterPollSignature !== null) app.setSignature(laterPollSignature);
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
  const server = createDescriptor({ id: 'server:app', target: 'server' });
  const { onChange } = startCoordinator({
    descriptors: [server],
    executors: [createExecutor('server', calls, {
      emitTransitionEvent(event, details) {
        transitions.push({ event, ...details });
      },
    })],
    calls,
  });

  server.setSignature('1');
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
  const shared = createDescriptor({ id: 'shared:protocol', target: 'shared' });
  const { onChange } = startCoordinator({
    descriptors: [shared],
    executors: [createExecutor('server', calls, {
      async restart(context) {
        contexts.push(context);
      },
    })],
    calls,
  });

  shared.setSignature('error:permission denied');
  await onChange({ eventType: 'change', filename: 'v1.ts' });

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].descriptorEvidenceConclusive, false);
  assert.deepEqual(contexts[0].changedDescriptors, ['shared:protocol']);
});

test('does not treat a stable unreadable Prisma descriptor as proof that migrations are unchanged', async () => {
  const calls = [];
  const contexts = [];
  const shared = createDescriptor({ id: 'shared:protocol', target: 'shared' });
  const prisma = createDescriptor({
    id: 'server:prisma',
    target: 'server',
    initial: 'error:permission denied',
  });
  const { onChange } = startCoordinator({
    descriptors: [shared, prisma],
    executors: [createExecutor('server', calls, {
      async restart(context) {
        contexts.push(context);
      },
    })],
    calls,
  });

  shared.setSignature('1');
  await onChange({ eventType: 'change', filename: 'v1.ts' });

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].descriptorEvidenceConclusive, false);
  assert.deepEqual(contexts[0].changedDescriptors, ['shared:protocol']);
});

test('source transition observer failure cannot suppress the admitted generation', async () => {
  const calls = [];
  const server = createDescriptor({ id: 'server:app', target: 'server' });
  const { onChange } = startCoordinator({
    descriptors: [server],
    executors: [createExecutor('server', calls, {
      emitTransitionEvent() { throw new Error('observer unavailable'); },
    })],
    calls,
  });

  server.setSignature('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });

  assert.deepEqual(calls.slice(1), ['server:build:1', 'server:restart:1']);
});

function startCoordinator({
  descriptors,
  executors,
  calls = [],
  isShuttingDown = () => false,
  logger,
  coordinatorBoundary = {},
} = {}) {
  let capturedOnChange = null;
  let capturedOnObservation = null;
  let capturedReadSignature = null;
  const watcher = startDevReloadCoordinator(
    {
      enabled: true,
      descriptors,
      executors,
      isShuttingDown,
      logger: logger ?? { log() {}, warn() {}, error() {} },
    },
    {
      watchDebouncedImpl: ({ paths, onChange, onObservation, readSignature }) => {
        calls.push(`watch:${paths.sort().join('|')}`);
        capturedOnChange = onChange;
        capturedOnObservation = onObservation;
        capturedReadSignature = readSignature;
        return { close() { calls.push('closed'); } };
      },
      ...coordinatorBoundary,
    }
  );

  assert.ok(watcher);
  assert.equal(typeof capturedOnChange, 'function');
  return {
    watcher,
    onChange: capturedOnChange,
    readSignature: capturedReadSignature,
    onObservation(event) {
      return capturedOnObservation?.(event);
    },
  };
}

test('explicit startup reconciliation rebuilds one requested target without a filesystem edit', async () => {
  const calls = [];
  const daemon = createDescriptor({ id: 'daemon:cli', target: 'daemon' });
  const { watcher } = startCoordinator({
    descriptors: [daemon],
    executors: [createExecutor('daemon', calls)],
    calls,
  });

  await watcher.requestReload('daemon');

  assert.deepEqual(calls.slice(1), ['daemon:build:1', 'daemon:restart:1']);
});

test('construction shares one signature scan between coordinator and watcher baselines', async () => {
  const server = createDeferredAsyncDescriptor({ id: 'server:app', target: 'server' });
  let watcherBaseline;
  const coordinator = startDevReloadCoordinator(
    {
      enabled: true,
      descriptors: [server],
      executors: [createExecutor('server', [])],
      logger: { log() {}, warn() {}, error() {} },
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
  await coordinator.close();

  assert.equal(constructionMetrics.readCalls, 1);
  assert.equal(constructionMetrics.maxActiveReads, 1);
});

test('construction, polling, and generation revalidation never call a synchronous reader when async exists', async () => {
  const calls = [];
  let syncReads = 0;
  let signature = '0';
  const descriptor = {
    id: 'daemon:cli',
    target: 'daemon',
    paths: ['/tmp/daemon-cli'],
    readSignature() {
      syncReads += 1;
      throw new Error('synchronous recursive scan must not run');
    },
    async readSignatureAsync() {
      return signature;
    },
  };
  let readPollSignature;
  let onChange;
  const coordinator = startDevReloadCoordinator(
    {
      enabled: true,
      descriptors: [descriptor],
      executors: [createExecutor('daemon', calls, {
        async restart(context) {
          assert.equal(await context.revalidateGeneration(), true);
        },
      })],
      logger: { log() {}, warn() {}, error() {} },
    },
    {
      watchDebouncedImpl(boundary) {
        readPollSignature = boundary.readSignature;
        onChange = boundary.onChange;
        return { close() {} };
      },
    },
  );

  await readPollSignature();
  signature = '1';
  await onChange({ eventType: 'poll', filename: null });
  await coordinator.close();

  assert.equal(syncReads, 0);
  assert.deepEqual(calls, ['daemon:build:1', 'daemon:restart:1']);
});

test('a filesystem edit observed during the startup baseline is not absorbed by that baseline', async () => {
  const calls = [];
  const server = createDeferredAsyncDescriptor({ id: 'server:app', target: 'server' });
  let onChange;
  let watcherBaseline;
  const coordinator = startDevReloadCoordinator(
    {
      enabled: true,
      descriptors: [server],
      executors: [createExecutor('server', calls)],
      logger: { log() {}, warn() {}, error() {} },
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
  server.setSignature('1');
  server.resolvePendingReads();
  await watcherBaseline;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    server.resolvePendingReads();
  }
  await startupEdit;
  await coordinator.close();

  assert.deepEqual(calls, ['server:build:1', 'server:restart:1']);
});

test('a startup-baseline event restarts only the consumer that owns its watched path', async () => {
  const calls = [];
  const daemon = createDescriptor({ id: 'daemon:cli', target: 'daemon', paths: ['/tmp/daemon-cli'] });
  const server = createDescriptor({ id: 'server:app', target: 'server', paths: ['/tmp/server-app'] });
  const { onChange } = startCoordinator({
    descriptors: [daemon, server],
    executors: [
      createExecutor('daemon', calls),
      createExecutor('server', calls),
    ],
    calls,
  });

  daemon.setSignature('1');
  await onChange({
    eventType: 'change',
    filename: 'index.ts',
    watchPath: '/tmp/daemon-cli',
    signatureInitializedAtObservation: false,
  });

  assert.deepEqual(calls.slice(1), ['daemon:build:1', 'daemon:restart:1']);
});

test('daemon-only and server-only changes build and restart only their target', async () => {
  const calls = [];
  const daemon = createDescriptor({ id: 'daemon:cli', target: 'daemon' });
  const server = createDescriptor({ id: 'server:app', target: 'server' });
  const { onChange } = startCoordinator({
    descriptors: [daemon, server],
    executors: [
      createExecutor('daemon', calls),
      createExecutor('server', calls),
    ],
    calls,
  });

  daemon.setSignature('1');
  await onChange({ eventType: 'change', filename: 'index.ts' });
  assert.deepEqual(calls.slice(1), ['daemon:build:1', 'daemon:restart:1']);

  calls.length = 1;
  server.setSignature('1');
  await onChange({ eventType: 'change', filename: null });
  assert.deepEqual(calls.slice(1), ['server:build:2', 'server:restart:2']);
});

test('shared edits build both targets first and restart server before daemon sequentially', async () => {
  const calls = [];
  let serverRestartResolved = false;
  const shared = createDescriptor({ id: 'shared:protocol', target: 'shared' });
  const { onChange } = startCoordinator({
    descriptors: [shared],
    executors: [
      createExecutor('daemon', calls, {
        restart() {
          assert.equal(serverRestartResolved, true, 'daemon restart must wait for server restart');
        },
      }),
      createExecutor('server', calls, {
        async restart() {
          await Promise.resolve();
          serverRestartResolved = true;
        },
      }),
    ],
    calls,
  });

  shared.setSignature('1');
  await onChange({ eventType: 'change', filename: 'mutations.ts' });

  assert.deepEqual(calls.slice(1), [
    'server:build:1',
    'daemon:build:1',
    'server:restart:1',
    'daemon:restart:1',
  ]);
});

test('build failure skips all restarts and keeps coordinator alive', async () => {
  const calls = [];
  const errors = [];
  const shared = createDescriptor({ id: 'shared:cli-common', target: 'shared' });
  const { onChange } = startCoordinator({
    descriptors: [shared],
    executors: [
      createExecutor('server', calls, {
        build() {
          throw new Error('server preflight failed');
        },
      }),
      createExecutor('daemon', calls),
    ],
    calls,
    logger: { log() {}, warn() {}, error(message) { errors.push(String(message)); } },
  });

  shared.setSignature('1');
  await onChange({ eventType: 'change', filename: 'types.ts' });

  assert.deepEqual(calls.slice(1), ['server:build:1']);
  assert.ok(errors.some((message) => message.includes('server preflight failed')));

  shared.setSignature('2');
  await onChange({ eventType: 'change', filename: 'types.ts' });
  assert.deepEqual(calls.slice(1), ['server:build:1', 'server:build:2']);
});

test('a later target build failure blocks every lifecycle projection already published as planned', async () => {
  const calls = [];
  const lifecycle = [];
  const shared = createDescriptor({ id: 'shared:protocol', target: 'shared' });
  const serverPlan = { mode: 'exclusiveDb', generation: 1, reason: 'source-change' };
  const { onChange } = startCoordinator({
    descriptors: [shared],
    executors: [
      createExecutor('server', calls, {
        createPlan() {
          return serverPlan;
        },
        publishLifecycle(transition) {
          lifecycle.push(transition);
        },
      }),
      createExecutor('daemon', calls, {
        build() {
          throw new Error('daemon build failed');
        },
      }),
    ],
    calls,
  });

  shared.setSignature('1');
  await onChange({ eventType: 'change', filename: 'types.ts' });

  assert.deepEqual(lifecycle.map(({ phase }) => phase), ['planned', 'blocked']);
  assert.deepEqual(lifecycle[1].plan, serverPlan);
  assert.equal(lifecycle[1].disposition.code, 'build_failed');
});

test('a generation superseded before restart clears its planned lifecycle projection to idle', async () => {
  const calls = [];
  const lifecycle = [];
  const server = createDescriptor({ id: 'server:app', target: 'server' });
  let onChange = null;
  const coordinator = startCoordinator({
    descriptors: [server],
    executors: [createExecutor('server', calls, {
      createPlan(context) {
        return {
          mode: 'exclusiveDb',
          generation: context.generation,
          reason: 'source-change',
        };
      },
      publishLifecycle(transition) {
        lifecycle.push(transition);
      },
      async build(context) {
        if (context.cycle === 1) {
          server.setSignature('2');
          await onChange({ eventType: 'change', filename: 'second.ts' });
          return { skipped: true, reason: 'already-superseded' };
        }
      },
    })],
    calls,
  });
  onChange = coordinator.onChange;

  server.setSignature('1');
  await onChange({ eventType: 'change', filename: 'first.ts' });

  assert.deepEqual(lifecycle.map(({ phase }) => phase), [
    'planned',
    'idle',
    'planned',
  ]);
  assert.deepEqual(calls.filter((call) => call.includes(':restart:')), ['server:restart:2']);
  assert.deepEqual(calls.filter((call) => call.includes(':build:')), ['server:build:1', 'server:build:2']);
});

test('a failed idle projection does not suppress the trailing superseding generation', async () => {
  const calls = [];
  const errors = [];
  const server = createDescriptor({ id: 'server:app', target: 'server' });
  let onChange = null;
  const coordinator = startCoordinator({
    descriptors: [server],
    executors: [createExecutor('server', calls, {
      publishLifecycle(transition) {
        if (transition.phase === 'idle') {
          throw new Error('runtime projection unavailable');
        }
      },
      async build(context) {
        if (context.cycle === 1) {
          server.setSignature('2');
          await onChange({ eventType: 'change', filename: 'second.ts' });
          return { skipped: true, reason: 'already-superseded' };
        }
      },
    })],
    calls,
    logger: { log() {}, warn() {}, error(message) { errors.push(String(message)); } },
  });
  onChange = coordinator.onChange;

  server.setSignature('1');
  await onChange({ eventType: 'change', filename: 'first.ts' });

  assert.deepEqual(calls.filter((call) => call.includes(':restart:')), ['server:restart:2']);
  assert.ok(errors.some((message) => message.includes('runtime projection unavailable')));
});

test('failed shared transaction stays dirty until all affected targets restart', async () => {
  const calls = [];
  let daemonBuildAttempts = 0;
  const shared = createDescriptor({ id: 'shared:protocol', target: 'shared' });
  const daemon = createDescriptor({ id: 'daemon:cli', target: 'daemon' });
  const { onChange } = startCoordinator({
    descriptors: [shared, daemon],
    executors: [
      createExecutor('server', calls),
      createExecutor('daemon', calls, {
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

  shared.setSignature('1');
  await onChange({ eventType: 'change', filename: 'protocol.ts' });
  assert.deepEqual(calls.slice(1), ['server:build:1', 'daemon:build:1']);

  daemon.setSignature('1');
  await onChange({ eventType: 'change', filename: 'cli.ts' });
  assert.deepEqual(calls.slice(1), [
    'server:build:1',
    'daemon:build:1',
    'server:build:2',
    'daemon:build:2',
    'server:restart:2',
    'daemon:restart:2',
  ]);
});

test('change during a cycle runs exactly one trailing cycle with the latest signature', async () => {
  const calls = [];
  const daemon = createDescriptor({ id: 'daemon:cli', target: 'daemon' });
  let onChange = null;
  const coordinator = startCoordinator({
    descriptors: [daemon],
    executors: [
      createExecutor('daemon', calls, {
        async restart(context) {
          if (context.cycle === 1) {
            daemon.setSignature('2');
            await onChange({ eventType: 'change', filename: 'second.ts' });
            daemon.setSignature('3');
            await onChange({ eventType: 'change', filename: 'third.ts' });
          }
        },
      }),
    ],
    calls,
  });
  onChange = coordinator.onChange;

  daemon.setSignature('1');
  await onChange({ eventType: 'change', filename: 'first.ts' });

  assert.deepEqual(calls.slice(1), [
    'daemon:build:1',
    'daemon:restart:1',
    'daemon:build:2',
    'daemon:restart:2',
  ]);
});

test('a superseded activation-capable build reaches its executor while one trailing latest generation remains pending', async () => {
  const calls = [];
  const daemon = createDescriptor({ id: 'daemon:cli', target: 'daemon' });
  let onChange = null;
  const coordinator = startCoordinator({
    descriptors: [daemon],
    executors: [
      createExecutor('daemon', calls, {
        async build(context) {
          if (context.cycle === 1) {
            daemon.setSignature('2');
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
  onChange = coordinator.onChange;

  daemon.setSignature('1');
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

test('a later Prisma generation invalidates an app-only plan before restart activation', async () => {
  const calls = [];
  const app = createDescriptor({ id: 'server:app', target: 'server' });
  const prisma = createDescriptor({ id: 'server:prisma', target: 'server' });
  let releaseBuild;
  const buildBlocked = new Promise((resolve) => {
    releaseBuild = resolve;
  });
  let notifyBuildStarted;
  const buildStarted = new Promise((resolve) => {
    notifyBuildStarted = resolve;
  });
  const { onChange } = startCoordinator({
    descriptors: [app, prisma],
    executors: [createExecutor('server', calls, {
      async build(context) {
        if (context.cycle === 1) {
          notifyBuildStarted();
          await buildBlocked;
        }
      },
      restart(context) {
        calls.push(`activated:${context.generation}:${context.changedDescriptors.join(',')}`);
      },
    })],
    calls,
  });

  app.setSignature('1');
  const appCycle = onChange({ eventType: 'change', filename: 'app.ts' });
  await buildStarted;

  prisma.setSignature('1');
  const prismaCycle = onChange({ eventType: 'change', filename: 'schema.prisma' });
  releaseBuild();
  await Promise.all([appCycle, prismaCycle]);

  assert.deepEqual(
    calls.filter((call) => call.startsWith('activated:')),
    ['activated:2:server:app,server:prisma'],
  );
});

test('rapid repeated app edits followed by Prisma collapse into one trailing exclusive generation', async () => {
  const calls = [];
  const app = createDescriptor({ id: 'server:app', target: 'server' });
  const prisma = createDescriptor({ id: 'server:prisma', target: 'server' });
  let releaseBuild;
  const buildBlocked = new Promise((resolve) => { releaseBuild = resolve; });
  let notifyBuildStarted;
  const buildStarted = new Promise((resolve) => { notifyBuildStarted = resolve; });
  const { onChange } = startCoordinator({
    descriptors: [app, prisma],
    executors: [createExecutor('server', calls, {
      async build(context) {
        if (context.cycle === 1) {
          notifyBuildStarted();
          await buildBlocked;
        }
      },
      restart(context) {
        const plan = createDevServerReloadPlan({
          dbProvider: 'sqlite',
          changedDescriptors: context.changedDescriptors,
          generation: context.generation,
        });
        calls.push(`activated:${plan.generation}:${plan.mode}:${context.changedDescriptors.join(',')}`);
      },
    })],
    calls,
  });

  app.setSignature('1');
  const first = onChange({ eventType: 'change', filename: 'app-1.ts' });
  await buildStarted;
  app.setSignature('2');
  const second = onChange({ eventType: 'change', filename: 'app-2.ts' });
  app.setSignature('3');
  const third = onChange({ eventType: 'change', filename: 'app-3.ts' });
  prisma.setSignature('1');
  const fourth = onChange({ eventType: 'change', filename: 'schema.prisma' });
  releaseBuild();
  await Promise.all([first, second, third, fourth]);

  assert.deepEqual(calls.filter((call) => call.startsWith('activated:')), [
    'activated:2:exclusiveDb:server:app,server:prisma',
  ]);
});

test('a Prisma observation during the pre-activation sampling gap revokes the app-only generation', async () => {
  const calls = [];
  const app = createDescriptor({ id: 'server:app', target: 'server' });
  let prismaSignature = '0';
  let hideNextPrismaSignature = false;
  const prisma = {
    id: 'server:prisma',
    target: 'server',
    paths: ['/tmp/server:prisma'],
    setSignature(value) {
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
  let onObservation = () => {};
  const coordinator = startCoordinator({
    descriptors: [app, prisma],
    executors: [createExecutor('server', calls, {
      async restart(context) {
        if (context.cycle === 1) {
          assert.equal(await context.revalidateGeneration(), true);
          prisma.setSignature('1');
          prisma.hideNextRead();
          onObservation({ eventType: 'change', filename: 'schema.prisma' });
        }
        if (await context.revalidateGeneration()) {
          calls.push(`activated:${context.generation}:${context.changedDescriptors.join(',')}`);
        }
      },
    })],
    calls,
  });
  onObservation = coordinator.onObservation;

  app.setSignature('1');
  await coordinator.onChange({ eventType: 'change', filename: 'app.ts' });

  assert.deepEqual(calls.filter((call) => call.startsWith('activated:')), [
    'activated:2:server:app,server:prisma',
  ]);
});

test('an ignored test-only observation does not revoke an in-flight production generation', async () => {
  const calls = [];
  const app = createDescriptor({ id: 'server:app', target: 'server' });
  let onObservation = () => {};
  const coordinator = startCoordinator({
    descriptors: [app],
    executors: [createExecutor('server', calls, {
      async restart(context) {
        if (context.generation === 1) {
          onObservation({ eventType: 'change', filename: 'session.spec.ts' });
        }
        if (await context.revalidateGeneration()) calls.push(`activated:${context.generation}`);
      },
    })],
    calls,
  });
  onObservation = coordinator.onObservation;

  app.setSignature('1');
  await coordinator.onChange({ eventType: 'change', filename: 'app.ts' });

  assert.deepEqual(calls.filter((call) => call.startsWith('activated:')), ['activated:1']);
});

test('a handled debounce delivery cannot suppress a distinct edit during the replanned cycle', async () => {
  const calls = [];
  const app = createDescriptor({ id: 'server:app', target: 'server' });
  let prismaSignature = '0';
  let hideNextPrismaSignature = false;
  const prisma = {
    id: 'server:prisma',
    target: 'server',
    paths: ['/tmp/server:prisma'],
    setSignature(value) {
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
  let onObservation = () => {};
  let deliverDebounced = () => {};
  const coordinator = startCoordinator({
    descriptors: [app, prisma],
    executors: [createExecutor('server', calls, {
      async restart(context) {
        if (context.generation <= 2) {
          assert.equal(await context.revalidateGeneration(), true);
          prisma.setSignature(String(context.generation));
          prisma.hideNextRead();
          onObservation({ eventType: 'change', filename: 'schema.prisma' });
          deliverDebounced({
            eventType: 'change',
            filename: 'schema.prisma',
            observationHandled: true,
          });
        }
        if (await context.revalidateGeneration()) calls.push(`activated:${context.generation}`);
      },
    })],
    calls,
  });
  onObservation = coordinator.onObservation;
  deliverDebounced = coordinator.onChange;

  app.setSignature('1');
  await coordinator.onChange({ eventType: 'change', filename: 'app.ts' });

  assert.deepEqual(calls.filter((call) => call.startsWith('activated:')), ['activated:3']);
});

test('duplicate shared events for the same signature coalesce to one transaction', async () => {
  const calls = [];
  const sharedA = createDescriptor({ id: 'shared:agents:a', target: 'shared', paths: ['/tmp/shared-agents'] });
  const sharedB = createDescriptor({ id: 'shared:agents:b', target: 'shared', paths: ['/tmp/shared-agents'] });
  const { onChange } = startCoordinator({
    descriptors: [sharedA, sharedB],
    executors: [
      createExecutor('server', calls),
      createExecutor('daemon', calls),
    ],
    calls,
  });

  sharedA.setSignature('1');
  sharedB.setSignature('1');
  await onChange({ eventType: 'change', filename: 'index.ts' });
  await onChange({ eventType: 'change', filename: 'index.ts' });

  assert.deepEqual(calls.slice(1), [
    'server:build:1',
    'daemon:build:1',
    'server:restart:1',
    'daemon:restart:1',
  ]);
});

test('duplicate shared descriptor ids from daemon and server wiring merge into one transaction', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-duplicate-shared-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const srcDir = join(root, 'src');
  const packageJsonPath = join(root, 'package.json');
  await mkdir(srcDir);
  await writeFile(join(srcDir, 'index.ts'), 'export const value = 1;\n');
  await writeFile(packageJsonPath, '{"name":"@happier-dev/protocol"}\n');

  const calls = [];
  const sharedFromDaemon = { id: 'shared:protocol', target: 'shared', paths: [srcDir] };
  const sharedFromServer = { id: 'shared:protocol', target: 'shared', paths: [packageJsonPath] };
  const { onChange, readSignature } = startCoordinator({
    descriptors: [sharedFromDaemon, sharedFromServer],
    executors: [
      createExecutor('daemon', calls),
      createExecutor('server', calls),
    ],
    calls,
  });

  await readSignature();
  await writeFile(join(srcDir, 'index.ts'), 'export const value = 200;\n');
  await onChange({ eventType: 'change', filename: 'index.ts' });

  assert.deepEqual(calls.slice(1), [
    'server:build:1',
    'daemon:build:1',
    'server:restart:1',
    'daemon:restart:1',
  ]);
});

test('duplicate descriptor ids use one merged-path observation instead of overlapping readers', async () => {
  let firstReads = 0;
  let secondReads = 0;
  const first = {
    id: 'shared:protocol',
    target: 'shared',
    paths: ['/tmp/hstack-duplicate-signature-path/src'],
    async readSignatureAsync() {
      firstReads += 1;
      return 'first';
    },
  };
  const second = {
    ...first,
    paths: ['/tmp/hstack-duplicate-signature-path/package.json'],
    async readSignatureAsync() {
      secondReads += 1;
      return 'second';
    },
  };
  let readPollSignature;
  const coordinator = startDevReloadCoordinator(
    {
      enabled: true,
      descriptors: [first, second],
      executors: [createExecutor('server', []), createExecutor('daemon', [])],
      logger: { log() {}, warn() {}, error() {} },
    },
    {
      watchDebouncedImpl(boundary) {
        readPollSignature = boundary.readSignature;
        return { close() {} };
      },
    },
  );

  assert.equal(await readPollSignature(), 'shared:protocol\u0000');
  await coordinator.close();
  assert.equal(firstReads, 0);
  assert.equal(secondReads, 0);
});

test('signature polling is delegated to watchDebounced with the aggregate descriptor signature', async () => {
  const calls = [];
  const daemon = createDescriptor({ id: 'daemon:cli', target: 'daemon' });
  let capturedOnChange = null;
  let capturedReadSignature = null;
  const watcher = startDevReloadCoordinator(
    {
      enabled: true,
      descriptors: [daemon],
      executors: [createExecutor('daemon', calls)],
      pollIntervalMs: 1234,
      logger: { log() {}, warn() {}, error() {} },
    },
    {
      watchDebouncedImpl: ({ paths, onChange, pollIntervalMs, readSignature }) => {
        calls.push(`watch:${paths.sort().join('|')}`);
        assert.equal(pollIntervalMs, 1234);
        assert.equal(typeof readSignature, 'function');
        capturedOnChange = onChange;
        capturedReadSignature = readSignature;
        return { close() { calls.push('watch:closed'); } };
      },
    },
  );

  assert.ok(watcher);
  assert.equal(typeof capturedOnChange, 'function');
  assert.equal(typeof capturedReadSignature, 'function');
  const before = capturedReadSignature();

  daemon.setSignature('1');
  assert.notEqual(capturedReadSignature(), before);
  await capturedOnChange({ eventType: 'poll', filename: null });

  assert.deepEqual(calls.slice(1), ['daemon:build:1', 'daemon:restart:1']);

  watcher.close();
  assert.ok(calls.includes('watch:closed'));
});

test('resolveDevReloadPollIntervalMs defaults on and supports explicit opt-out', () => {
  assert.equal(resolveDevReloadPollIntervalMs({}), 10_000);
  assert.equal(resolveDevReloadPollIntervalMs({}, { defaultMs: 2000 }), 2000);
  assert.equal(
    resolveDevReloadPollIntervalMs({ HAPPIER_STACK_DEV_RELOAD_POLL_MS: '750' }, { defaultMs: 2000 }),
    750,
  );
  assert.equal(
    resolveDevReloadPollIntervalMs({ HAPPIER_STACK_DEV_RELOAD_POLL_MS: '0' }, { defaultMs: 2000 }),
    0,
  );
  assert.equal(
    resolveDevReloadPollIntervalMs({ HAPPIER_STACK_DEV_RELOAD_POLL_MS: '-1' }, { defaultMs: 2000 }),
    2000,
  );
});

test('reload coordinator logs every initialization bail reason', () => {
  const messages = [];
  const logger = {
    log(message) { messages.push(String(message)); },
    warn(message) { messages.push(String(message)); },
    error(message) { messages.push(String(message)); },
  };
  const executor = createExecutor('daemon', []);
  const descriptor = createDescriptor({ id: 'daemon:cli', target: 'daemon' });

  assert.equal(startDevReloadCoordinator({ enabled: false, descriptors: [descriptor], executors: [executor], logger }), null);
  assert.equal(startDevReloadCoordinator({ enabled: true, descriptors: [], executors: [executor], logger }), null);
  assert.equal(startDevReloadCoordinator({ enabled: true, descriptors: [descriptor], executors: [], logger }), null);
  assert.equal(startDevReloadCoordinator({
    enabled: true,
    descriptors: [{ ...descriptor, paths: [] }],
    executors: [executor],
    logger,
  }), null);

  assert.ok(messages.some((message) => message.includes('disabled')));
  assert.ok(messages.some((message) => message.includes('no valid descriptors')));
  assert.ok(messages.some((message) => message.includes('no executors')));
  assert.ok(messages.some((message) => message.includes('no watch paths')));
});

test('reload coordinator logs a watcher event that has no signature delta', async () => {
  const messages = [];
  const daemon = createDescriptor({ id: 'daemon:cli', target: 'daemon' });
  const { onChange } = startCoordinator({
    descriptors: [daemon],
    executors: [createExecutor('daemon', [])],
    logger: {
      log(message) { messages.push(String(message)); },
      warn(message) { messages.push(String(message)); },
      error(message) { messages.push(String(message)); },
    },
  });

  await onChange({ eventType: 'change', filename: 'runtime.ts' });

  assert.ok(messages.some((message) => message.includes('no signature delta')));
});

test('a restart failure can request one bounded coordinator retry without another filesystem edit', async () => {
  const calls = [];
  const scheduled = [];
  const server = createDescriptor({ id: 'server:app', target: 'server' });
  let restartAttempts = 0;
  const { onChange } = startCoordinator({
    descriptors: [server],
    executors: [createExecutor('server', calls, {
      restart() {
        restartAttempts += 1;
        if (restartAttempts <= 2) {
          const error = new Error('release evidence was temporarily inconclusive');
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

  server.setSignature('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });

  assert.equal(restartAttempts, 1);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delayMs, 25);

  await scheduled[0].callback();

  assert.equal(restartAttempts, 2);
  assert.equal(scheduled.length, 1, 'unchanged failed evidence must not re-arm retries indefinitely');
  await onChange({ eventType: 'change', filename: 'app.ts' });
  assert.equal(restartAttempts, 2, 'duplicate watcher events must not bypass the consumed retry episode');
  assert.deepEqual(calls.slice(1), [
    'server:build:1',
    'server:restart:1',
    'server:build:2',
    'server:restart:2',
  ]);
});

test('the coordinator alone projects transient retry and exhausted terminal disposition', async () => {
  const calls = [];
  const scheduled = [];
  const dispositions = [];
  const server = createDescriptor({ id: 'server:app', target: 'server' });
  const { onChange } = startCoordinator({
    descriptors: [server],
    executors: [createExecutor('server', calls, {
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

  server.setSignature('1');
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
  const server = createDescriptor({ id: 'server:app', target: 'server' });
  let unexpectedExitHandler = null;
  const { watcher } = startCoordinator({
    descriptors: [server],
    executors: [createExecutor('server', calls, {
      setUnexpectedExitHandler(handler) {
        unexpectedExitHandler = handler;
      },
    })],
    calls,
  });

  assert.equal(typeof unexpectedExitHandler, 'function');
  await unexpectedExitHandler({ code: 1, signal: null });
  assert.deepEqual(calls.slice(1), ['server:build:1', 'server:restart:1']);

  await watcher.close();
  assert.equal(unexpectedExitHandler, null);
});

test('an active-server exit remains forced when a no-delta observation supersedes its first cycle', async () => {
  const calls = [];
  const server = createDescriptor({ id: 'server:app', target: 'server' });
  let unexpectedExitHandler = null;
  let notifyBuildStarted;
  const buildStarted = new Promise((resolve) => { notifyBuildStarted = resolve; });
  let releaseBuild;
  const buildBlocked = new Promise((resolve) => { releaseBuild = resolve; });
  const { watcher, onChange } = startCoordinator({
    descriptors: [server],
    executors: [createExecutor('server', calls, {
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
  onChange({ eventType: 'change', filename: 'unrelated-observation.tmp' });
  releaseBuild();
  await recovery;

  assert.deepEqual(calls.slice(1), [
    'server:build:1',
    'server:build:2',
    'server:restart:2',
  ]);

  await watcher.close();
});

test('retry remains authoritative when retry lifecycle projection fails', async () => {
  const calls = [];
  const scheduled = [];
  const errors = [];
  const server = createDescriptor({ id: 'server:app', target: 'server' });
  let attempts = 0;
  const { onChange } = startCoordinator({
    descriptors: [server],
    executors: [createExecutor('server', calls, {
      publishLifecycle(transition) {
        if (transition.phase === 'retry-scheduled') throw new Error('runtime projection unavailable');
      },
      restart() {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('release evidence was temporarily inconclusive');
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

  server.setSignature('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });

  assert.equal(scheduled.length, 1, 'projection failure must not suppress the authoritative retry');
  assert.ok(errors.some((message) => message.includes('runtime projection unavailable')));
  await onChange({ eventType: 'change', filename: 'duplicate.ts' });
  assert.equal(attempts, 1, 'projection failure must not let a duplicate event bypass the scheduled retry');
  await scheduled[0].callback();
  assert.equal(attempts, 2);
  assert.equal(scheduled.length, 1, 'projection failure must not duplicate the bounded retry');
});

test('closing the coordinator during an in-flight failed restart fences later retry scheduling', async () => {
  const calls = [];
  const scheduled = [];
  const server = createDescriptor({ id: 'server:app', target: 'server' });
  let rejectRestart;
  let markRestartStarted;
  const restartStarted = new Promise((resolve) => { markRestartStarted = resolve; });
  const restartResult = new Promise((_resolve, reject) => { rejectRestart = reject; });
  const { watcher, onChange } = startCoordinator({
    descriptors: [server],
    executors: [createExecutor('server', calls, {
      async restart() {
        markRestartStarted();
        return await restartResult;
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

  server.setSignature('1');
  const change = onChange({ eventType: 'change', filename: 'app.ts' });
  await restartStarted;
  watcher.close();
  const error = new Error('release evidence became inconclusive after close');
  error.reloadRetryAfterMs = 25;
  rejectRestart(error);
  await change;

  assert.equal(scheduled.length, 0, 'close must fence retry scheduling from the in-flight failure path');
  assert.equal(calls.at(-1), 'closed');
});

test('closing the coordinator joins the in-flight cycle before resolving', async () => {
  const calls = [];
  const server = createDescriptor({ id: 'server:app', target: 'server' });
  let releaseRestart;
  let markRestartStarted;
  const restartStarted = new Promise((resolve) => { markRestartStarted = resolve; });
  const restartBlocked = new Promise((resolve) => { releaseRestart = resolve; });
  const { watcher, onChange } = startCoordinator({
    descriptors: [server],
    executors: [createExecutor('server', calls, {
      async restart() {
        markRestartStarted();
        await restartBlocked;
      },
    })],
    calls,
  });

  server.setSignature('1');
  const change = onChange({ eventType: 'change', filename: 'app.ts' });
  await restartStarted;
  let closeResolved = false;
  const close = Promise.resolve(watcher.close()).then(() => { closeResolved = true; });
  await Promise.resolve();
  assert.equal(closeResolved, false, 'close must join the active restart cycle');

  releaseRestart();
  await Promise.all([change, close]);
  assert.equal(closeResolved, true);
});

test('closing during the next signature sample fences lifecycle publication and execution', async () => {
  const calls = [];
  const lifecycle = [];
  const server = createDeferredAsyncDescriptor({ id: 'server:app', target: 'server' });
  const executor = createExecutor('server', calls, {
    publishLifecycle(transition) {
      lifecycle.push(transition);
    },
  });
  const { watcher, onChange } = startCoordinator({
    descriptors: [server],
    executors: [executor],
    calls,
  });

  server.resolvePendingReads();
  await new Promise((resolve) => setImmediate(resolve));
  server.setSignature('1');
  const change = onChange({ eventType: 'change', filename: 'app.ts' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.metrics().pendingReads, 1);

  const close = watcher.close();
  server.resolvePendingReads();
  await Promise.all([change, close]);

  assert.deepEqual(lifecycle, []);
  assert.deepEqual(calls.filter((call) => /:(?:build|restart):/.test(call)), []);
});

test('closing during executor-facing generation revalidation revokes activation authority', async () => {
  const calls = [];
  const server = createDeferredAsyncDescriptor({ id: 'server:app', target: 'server' });
  let markExecutorRevalidationStarted;
  const executorRevalidationStarted = new Promise((resolve) => { markExecutorRevalidationStarted = resolve; });
  let revalidationResult = null;
  const { watcher, onChange } = startCoordinator({
    descriptors: [server],
    executors: [createExecutor('server', calls, {
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
  server.setSignature('1');
  const change = onChange({ eventType: 'change', filename: 'app.ts' });
  for (let read = 0; read < 2; read += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(server.metrics().pendingReads, 1);
    server.resolvePendingReads();
  }
  await executorRevalidationStarted;
  assert.equal(server.metrics().pendingReads, 1);

  const close = watcher.close();
  server.resolvePendingReads();
  await Promise.all([change, close]);

  assert.equal(revalidationResult, false);
});

test('a canceled retry callback cannot execute against a newer source-signature episode', async () => {
  const calls = [];
  const scheduled = [];
  const server = createDescriptor({ id: 'server:app', target: 'server' });
  let restartAttempts = 0;
  const { onChange } = startCoordinator({
    descriptors: [server],
    executors: [createExecutor('server', calls, {
      restart() {
        restartAttempts += 1;
        const error = new Error('release evidence remains temporarily inconclusive');
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

  server.setSignature('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });
  server.setSignature('2');
  await onChange({ eventType: 'change', filename: 'app.ts' });

  assert.equal(restartAttempts, 2);
  assert.equal(scheduled.length, 2);

  await scheduled[0].callback();
  assert.equal(restartAttempts, 2, 'a canceled prior-episode callback must be inert');

  await scheduled[1].callback();
  assert.equal(restartAttempts, 3);
  assert.equal(scheduled.length, 2, 'the current episode still receives only one retry');
});

test('executor backoff defers the dirty episode instead of committing a skipped restart', async () => {
  const calls = [];
  const scheduled = [];
  const server = createDescriptor({ id: 'server:app', target: 'server' });
  let restartAttempts = 0;
  const executor = createExecutor('server', calls, {
    restart() {
      restartAttempts += 1;
      return restartAttempts === 1
        ? { skipped: true, reason: 'backoff', retryAfterMs: 41 }
        : { restarted: true };
    },
  });
  executor.getBackoffRemainingMs = () => {
    throw new Error('the coordinator must not re-read a changing backoff clock');
  };
  const { onChange } = startCoordinator({
    descriptors: [server],
    executors: [executor],
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

  server.setSignature('1');
  await onChange({ eventType: 'change', filename: 'app.ts' });

  assert.equal(restartAttempts, 1);
  assert.deepEqual(scheduled.map(({ delayMs }) => delayMs), [41]);

  await scheduled[0].callback();
  assert.equal(restartAttempts, 2);
});

test('watch signature distinguishes same-size edits within one millisecond', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-dev-reload-signature-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const sourcePath = join(root, 'runtime.ts');

  await writeFile(sourcePath, 'one\n', 'utf-8');
  await utimes(sourcePath, 1_000.0001, 1_000.0001);
  const first = readDevReloadWatchChangeSignature([sourcePath]);
  const firstAsync = await readDevReloadWatchChangeSignatureAsync([sourcePath]);

  await writeFile(sourcePath, 'two\n', 'utf-8');
  await utimes(sourcePath, 1_000.0009, 1_000.0009);
  const second = readDevReloadWatchChangeSignature([sourcePath]);
  const secondAsync = await readDevReloadWatchChangeSignatureAsync([sourcePath]);

  assert.equal(firstAsync, first);
  assert.equal(secondAsync, second);
  assert.notEqual(second, first);
});

test('watch signature detects a same-size replacement whose mtime is preserved', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-dev-reload-signature-preserved-mtime-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const sourcePath = join(root, 'runtime.ts');
  const replacementPath = join(root, 'runtime.replacement.ts');

  await writeFile(sourcePath, 'one\n', 'utf-8');
  await utimes(sourcePath, 1_000, 1_000);
  const firstStat = await stat(sourcePath, { bigint: true });
  const first = readDevReloadWatchChangeSignature([sourcePath]);
  const firstAsync = await readDevReloadWatchChangeSignatureAsync([sourcePath]);

  await writeFile(replacementPath, 'two\n', 'utf-8');
  await utimes(replacementPath, 1_000, 1_000);
  await rename(replacementPath, sourcePath);
  const secondStat = await stat(sourcePath, { bigint: true });
  const second = readDevReloadWatchChangeSignature([sourcePath]);
  const secondAsync = await readDevReloadWatchChangeSignatureAsync([sourcePath]);

  assert.equal(secondStat.size, firstStat.size);
  assert.equal(secondStat.mtimeNs, firstStat.mtimeNs);
  assert.notEqual(secondStat.ino, firstStat.ino);
  assert.equal(firstAsync, first);
  assert.equal(secondAsync, second);
  assert.notEqual(second, first);
});

test('runtime reload ignore matching is separator-safe and limited to test-only path conventions', () => {
  for (const path of [
    '/repo/apps/cli/src/testkit/fs/tempDir.ts',
    'C:\\repo\\apps\\cli\\src\\testkit\\fs\\tempDir.ts',
    '/repo/apps/cli/src/agent/tools/trace/testEvents.testkit.ts',
    '/repo/apps/cli/src/vitestSetup.ts',
  ]) {
    assert.equal(isDevRuntimeReloadIgnoredPath(path), true, path);
  }

  for (const path of [
    '/repo/apps/cli/src/testkitRuntime.ts',
    '/repo/apps/cli/src/agent/tools/trace/testEvents.testkitConfig.ts',
    '/repo/apps/cli/src/runtime-testkit.ts',
    '/repo/apps/cli/src/runtime_testkit.ts',
    '/repo/apps/cli/src/vitestSetupRuntime.ts',
    '/repo/apps/cli/src/runtime.ts',
  ]) {
    assert.equal(isDevRuntimeReloadIgnoredPath(path), false, path);
  }
});
