import assert from 'node:assert/strict';
import test from 'node:test';

import { startDevReloadCoordinator } from './devReloadCoordinator.mjs';

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

function executor(target, calls, overrides = {}) {
  return {
    target,
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

function startCoordinator({ descriptors, executors, calls, logger = { error() {} } }) {
  let onChange = null;
  const watcher = startDevReloadCoordinator(
    { enabled: true, descriptors, executors, logger },
    {
      watchDebouncedImpl: ({ paths, onChange: captured, readSignature, pollIntervalMs }) => {
        calls.push(`watch:${paths.sort().join('|')}:${typeof readSignature}:${pollIntervalMs}`);
        onChange = captured;
        return { close() {} };
      },
    },
  );
  assert.ok(watcher);
  assert.equal(typeof onChange, 'function');
  return onChange;
}

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
