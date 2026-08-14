import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  inspectDevTargetSyncService,
  startDevTargetSyncService,
  stopDevTargetSyncService,
  waitForDevTargetSyncMonitor,
} from './sync_service.mjs';

const targets = [
  { name: 'mac' },
  { name: 'mac2' },
];

test('detached sync start resumes the canonical project and reports every session without a resident wrapper or dependency bootstrap', async () => {
  const calls = [];
  const result = await startDevTargetSyncService({
    stackBaseDir: '/stack',
    sourceDir: '/repo',
    targets,
    detached: true,
    env: {},
  }, {
    ensureProject: async (options) => {
      calls.push({ kind: 'ensure', options });
      return { ownership: 'owned', env: { MUTAGEN_DATA_DIRECTORY: '/stack/mutagen/data' } };
    },
    inspectSync: async ({ target }) => ({ state: 'ready', sessionName: `happier-${target.name}` }),
    resumeSync: async ({ target }) => { calls.push({ kind: 'resume', target: target.name }); },
    prepareTarget: async ({ target }) => { calls.push({ kind: 'unexpected-prepare', target: target.name }); },
    spawnMonitor: () => {
      throw new Error('detached start must not leave an hstack monitor process behind');
    },
    writePreparationState: async ({ state }) => { calls.push({ kind: 'state', state }); },
  });

  assert.equal(calls[0].options.ownerId, 'dev-target-sync-service');
  assert.equal(calls[0].options.allowIndependentBorrow, false);
  assert.equal(calls[1].kind, 'state');
  assert.equal(calls[1].state.state, 'preparing');
  assert.deepEqual(calls.slice(2, 4), [
    { kind: 'resume', target: 'mac' },
    { kind: 'resume', target: 'mac2' },
  ]);
  assert.equal(calls.some((call) => call.kind === 'unexpected-prepare'), false);
  assert.equal(calls[4].kind, 'state');
  assert.equal(calls[4].state.state, 'ready');
  assert.deepEqual(result.statuses.map((entry) => entry.status.state), ['ready', 'ready']);
  assert.equal(result.monitor, null);
});

test('detached sync start never owns dependency preparation on any sync target', async () => {
  const prepared = [];
  const configuredTargets = [
    { name: 'windows', platform: 'windows' },
    { name: 'mac', platform: 'posix' },
  ];
  const result = await startDevTargetSyncService({
    stackBaseDir: '/stack',
    sourceDir: '/repo',
    targets: configuredTargets,
    detached: true,
    env: {},
  }, {
    ensureProject: async () => ({ ownership: 'owned', env: {} }),
    resumeSync: async () => {},
    prepareTarget: async ({ target }) => { prepared.push(target.name); },
    inspectSync: async ({ target }) => ({ state: 'ready', sessionName: `happier-${target.name}` }),
    writePreparationState: async () => {},
  });

  assert.deepEqual(prepared, []);
  assert.deepEqual(result.statuses.map((entry) => entry.target), ['windows', 'mac']);
});

test('POSIX sync startup does not flush or bootstrap the remote checkout', async () => {
  const calls = [];
  const target = {
    name: 'mac',
    platform: 'posix',
    cliHomeDir: '/Users/test/.happier/mac',
  };
  await startDevTargetSyncService({
    stackBaseDir: '/stack',
    sourceDir: '/repo',
    targets: [target],
    detached: true,
    env: {},
  }, {
    ensureProject: async () => ({ ownership: 'owned', env: { TEST_ENV: 'project' } }),
    resumeSync: async () => {},
    syncTarget: async (options) => { calls.push({ kind: 'unexpected-sync', options }); },
    runRemoteCommand: async (options) => { calls.push({ kind: 'unexpected-remote', options }); },
    inspectSync: async () => ({ state: 'ready', sessionName: 'happier-mac' }),
    writePreparationState: async () => {},
  });

  assert.deepEqual(calls, []);
});

test('foreground sync start streams the canonical Mutagen monitor until it exits', async () => {
  const spawned = [];
  const completion = Promise.resolve({ code: 0, signal: null });
  const result = await startDevTargetSyncService({
    stackBaseDir: '/stack',
    sourceDir: '/repo',
    targets,
    detached: false,
    env: {},
  }, {
    ensureProject: async () => ({ ownership: 'owned', env: { MUTAGEN_DATA_DIRECTORY: '/stack/mutagen/data' } }),
    resumeSync: async () => {},
    prepareTarget: async () => {},
    inspectSync: async ({ target }) => ({ state: 'synchronizing', sessionName: `happier-${target.name}` }),
    spawnMonitor: ({ command, args, env, lineFilter }) => {
      spawned.push({ command, args, env, lineFilter });
      return { completion };
    },
    writePreparationState: async () => {},
  });

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, 'mutagen');
  assert.deepEqual(spawned[0].args.slice(0, 3), ['sync', 'monitor', '--template']);
  assert.match(spawned[0].args[3], /SuccessfulCycles/);
  assert.deepEqual(spawned[0].args.slice(-2), ['happier-mac', 'happier-mac2']);
  assert.deepEqual(spawned[0].env, { MUTAGEN_DATA_DIRECTORY: '/stack/mutagen/data' });
  assert.equal(spawned[0].lineFilter({ stream: 'stdout', line: 'happier-mac|Watching|1||false|0' }), true);
  assert.equal(spawned[0].lineFilter({ stream: 'stdout', line: 'happier-mac|Watching|1||false|0' }), false);
  assert.equal(await result.monitor.completion, await completion);
});

test('foreground monitor Ctrl-C stops only the monitor process and detaches with shell status 130', async () => {
  const signals = new EventEmitter();
  let resolveCompletion;
  const monitor = {
    completion: new Promise((resolvePromise) => { resolveCompletion = resolvePromise; }),
  };
  const stopped = [];
  const waiting = waitForDevTargetSyncMonitor(monitor, {
    signalSource: signals,
    stopMonitor: async (child, signal) => {
      stopped.push({ child, signal });
      resolveCompletion({ code: null, signal: 'SIGTERM' });
    },
  });

  signals.emit('SIGINT');
  assert.deepEqual(await waiting, { code: 130, signal: 'SIGINT' });
  assert.deepEqual(stopped, [{ child: monitor, signal: 'SIGTERM' }]);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('sync stop delegates lifecycle release to the independent project owner', async () => {
  const calls = [];
  const result = await stopDevTargetSyncService({ stackBaseDir: '/stack', env: {} }, {
    releaseProject: async (options) => {
      calls.push(options);
      return true;
    },
  });
  assert.equal(result.released, true);
  assert.deepEqual(calls, [{ stackBaseDir: '/stack', env: {} }]);
});

test('sync status reports ownership and every target session without changing lifecycle', async () => {
  const result = await inspectDevTargetSyncService({
    stackBaseDir: '/stack',
    targets,
    env: {},
  }, {
    readProject: async () => '# hstack-owner: "dev-target-sync-service"\n',
    readPreparationState: async () => ({
      version: 1,
      state: 'ready',
      targets: { mac: { state: 'ready' }, mac2: { state: 'ready' } },
    }),
    inspectSync: async ({ target }) => ({ state: 'ready', sessionName: `happier-${target.name}` }),
  });
  assert.equal(result.independent, true);
  assert.equal(result.preparation.state, 'ready');
  assert.deepEqual(result.statuses.map((entry) => entry.status.state), ['ready', 'ready']);
});

test('detached sync start records every synchronization observation before rejecting an unavailable target', async () => {
  const states = [];
  await assert.rejects(
    startDevTargetSyncService({
      stackBaseDir: '/stack',
      sourceDir: '/repo',
      targets,
      detached: true,
      env: {},
    }, {
      ensureProject: async () => ({ ownership: 'owned', env: {} }),
      resumeSync: async () => {},
      prepareTarget: async () => { throw new Error('dependency bootstrap must not run'); },
      inspectSync: async ({ target }) => target.name === 'mac'
        ? { state: 'unavailable', error: 'mac session unavailable' }
        : { state: 'ready' },
      writePreparationState: async ({ state }) => { states.push(state); },
    }),
    /mac session unavailable/,
  );

  assert.equal(states.at(-1).state, 'failed');
  assert.deepEqual(states.at(-1).targets, {
    mac: { state: 'failed', error: '[dev-targets] mac synchronization is unavailable: mac session unavailable' },
    mac2: { state: 'ready' },
  });
});
