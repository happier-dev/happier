import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { renderMutagenProject } from './mutagen_project.mjs';
import {
  ensureDevTargetSyncProject,
  INDEPENDENT_DEV_TARGET_SYNC_OWNER,
} from './sync_project.mjs';
import {
  inspectDevTargetSyncService,
  repairRecoverableDevTargetSyncConflicts,
  startDevTargetSyncService,
  stopDevTargetSyncService,
  waitForDevTargetSyncMonitor,
} from './sync_service.mjs';

const targets = [
  { name: 'mac' },
  { name: 'mac2' },
];

test('detached sync start recreates requested sessions missing from its canonical project', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-sync-service-missing-sessions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectFile = join(root, 'mutagen', 'mutagen.yml');
  const target = {
    name: 'mac',
    platform: 'posix',
    ssh: 'mac',
    repoDir: '/remote/happier',
  };
  await mkdir(join(root, 'mutagen'), { recursive: true });
  await writeFile(projectFile, renderMutagenProject({
    sourceDir: '/source/happier',
    targets: [target],
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  }));
  const mutagenCalls = [];
  const syncListCalls = [];

  const result = await startDevTargetSyncService({
    stackBaseDir: root,
    sourceDir: '/source/happier',
    targets: [target],
    detached: true,
    env: {},
  }, {
    startTargetRuntime: async () => {},
    ensureReplicaRoots: async () => {},
    ensureProject: async (options) => ensureDevTargetSyncProject(options, {
      runProcess: async ({ args }) => {
        mutagenCalls.push(args.slice(0, 2));
        if (args[0] === 'sync' && args[1] === 'list') {
          syncListCalls.push(args);
          return args[2] === 'happier-mac'
            ? { code: 1, err: 'specification happier-mac did not match any sessions' }
            : { code: 0, out: '[]' };
        }
        return { code: 0 };
      },
    }),
    resumeSync: async () => {},
    inspectSync: async () => ({ state: 'ready', sessionName: 'happier-mac' }),
    writePreparationState: async () => {},
  });

  assert.equal(result.project.projectCreated, true);
  assert.deepEqual(syncListCalls.map((args) => args.slice(0, 3)), [
    ['sync', 'list', '--template'],
  ]);
  assert.deepEqual(mutagenCalls, [
    ['version'],
    ['project', 'resume'],
    ['sync', 'list'],
    ['project', 'terminate'],
    ['project', 'start'],
    ['project', 'list'],
  ]);
});

test('detached sync start resumes the canonical project and reports every session without a resident wrapper or dependency bootstrap', async () => {
  const calls = [];
  const result = await startDevTargetSyncService({
    stackBaseDir: '/stack',
    sourceDir: '/repo',
    targets,
    detached: true,
    env: {},
  }, {
    ensureReplicaRoots: async () => {},
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

test('sync startup makes configured Lima transports ready before Mutagen project startup', async () => {
  const calls = [];
  const configuredTargets = [
    { name: 'mac', platform: 'posix' },
    {
      name: 'linux',
      platform: 'posix',
      limaInstance: 'happier-dev-bench',
      limaHome: '/tmp/lima',
    },
  ];

  await startDevTargetSyncService({
    stackBaseDir: '/stack',
    sourceDir: '/repo',
    targets: configuredTargets,
    detached: true,
    env: {},
  }, {
    startTargetRuntime: async ({ target }) => {
      calls.push({ kind: 'runtime', target: target.name });
    },
    ensureReplicaRoots: async ({ targets: preparedTargets }) => {
      calls.push({ kind: 'roots', targets: preparedTargets.map((target) => target.name) });
    },
    ensureProject: async () => {
      calls.push({ kind: 'ensure' });
      return { ownership: 'owned', env: {} };
    },
    resumeSync: async ({ target }) => { calls.push({ kind: 'resume', target: target.name }); },
    inspectSync: async ({ target }) => ({ state: 'ready', sessionName: `happier-${target.name}` }),
    writePreparationState: async () => {},
  });

  assert.deepEqual(calls.slice(0, 4), [
    { kind: 'runtime', target: 'mac' },
    { kind: 'runtime', target: 'linux' },
    { kind: 'roots', targets: ['mac', 'linux'] },
    { kind: 'ensure' },
  ]);
});

test('sync startup accepts an unpaused reconnecting session when Mutagen resume reports an offline endpoint', async () => {
  const states = [];
  const result = await startDevTargetSyncService({
    stackBaseDir: '/stack',
    sourceDir: '/repo',
    targets: [{ name: 'mac', platform: 'posix' }],
    detached: true,
    env: {},
  }, {
    startTargetRuntime: async () => {},
    ensureReplicaRoots: async () => {},
    ensureProject: async () => ({ ownership: 'owned', env: {} }),
    resumeSync: async () => { throw new Error('endpoint offline'); },
    inspectSync: async () => ({ state: 'synchronizing', sessionName: 'happier-mac' }),
    writePreparationState: async ({ state }) => { states.push(state); },
  });

  assert.equal(states.at(-1).state, 'ready');
  assert.equal(result.statuses[0].status.state, 'synchronizing');
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
    ensureReplicaRoots: async () => {},
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
    ensureReplicaRoots: async () => {},
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
    ensureReplicaRoots: async () => {},
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
  assert.match(
    spawned[0].args[3],
    /if \.SessionState/,
    'the monitor must skip transient Mutagen entries whose embedded session state is nil',
  );
  assert.deepEqual(spawned[0].args.slice(-2), ['happier-mac', 'happier-mac2']);
  assert.deepEqual(spawned[0].env, { MUTAGEN_DATA_DIRECTORY: '/stack/mutagen/data' });
  assert.equal(spawned[0].lineFilter({ stream: 'stdout', line: 'happier-mac|Watching|1||false|0' }), true);
  assert.equal(spawned[0].lineFilter({ stream: 'stdout', line: 'happier-mac|Watching|1||false|0' }), false);
  assert.equal(
    spawned[0].lineFilter({ stream: 'stdout', line: 'happier-mac|Watching|2||false|0' }),
    false,
    'a successful-cycle counter change alone must not redraw or persist another healthy status',
  );
  assert.equal(spawned[0].lineFilter({ stream: 'stdout', line: 'happier-mac|Scanning|2||false|0' }), true);
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
      ensureReplicaRoots: async () => {},
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

test('sync service repairs a deleted source root blocked only by ignored beta artifacts', async () => {
  const repaired = [];
  const conflictStatus = {
    state: 'unhealthy',
    sessionName: 'happier-mac',
    session: {
      mode: 'one-way-replica',
      conflicts: [{
        root: 'packages/plugins/retired-plugin',
        alphaChanges: [{
          path: 'packages/plugins/retired-plugin',
          old: { kind: 'directory' },
          new: null,
        }],
        betaChanges: [
          {
            path: 'packages/plugins/retired-plugin/node_modules',
            old: null,
            new: { kind: 'untracked' },
          },
          {
            path: 'packages/plugins/retired-plugin/dist/runtime.js',
            old: null,
            new: { kind: 'untracked' },
          },
          {
            path: 'packages/plugins/retired-plugin/.happier',
            old: null,
            new: { kind: 'untracked' },
          },
          {
            path: 'packages/plugins/retired-plugin/.tsbuildinfo',
            old: null,
            new: { kind: 'untracked' },
          },
        ],
      }],
    },
  };
  const result = await startDevTargetSyncService({
    stackBaseDir: '/stack',
    sourceDir: '/repo',
    targets: [{ name: 'mac', platform: 'posix', repoDir: '/remote/repo' }],
    detached: true,
    env: {},
  }, {
    ensureReplicaRoots: async () => {},
    ensureProject: async () => ({ ownership: 'owned', env: {} }),
    resumeSync: async () => {},
    inspectSync: async () => conflictStatus,
    repairSync: async (options) => {
      repaired.push(options);
      return { repaired: true, roots: ['packages/plugins/retired-plugin'] };
    },
    writePreparationState: async () => {},
  });

  assert.equal(repaired.length, 1);
  assert.equal(repaired[0].status, conflictStatus);
  assert.equal(result.statuses[0].status.state, 'synchronizing');
  assert.deepEqual(result.statuses[0].status.repairedRoots, ['packages/plugins/retired-plugin']);
});

test('recoverable conflict repair deletes only the exact managed replica root after source absence is rechecked', async () => {
  const calls = [];
  const target = {
    name: 'mac',
    platform: 'posix',
    repoDir: '/remote/repo',
  };
  const status = {
    session: {
      mode: 'one-way-replica',
      conflicts: [{
        root: 'packages/plugins/retired-plugin',
        alphaChanges: [{
          path: 'packages/plugins/retired-plugin',
          old: { kind: 'directory' },
          new: null,
        }],
        betaChanges: [{
          path: 'packages/plugins/retired-plugin/node_modules',
          old: null,
          new: { kind: 'untracked' },
        }],
      }],
    },
  };
  const result = await repairRecoverableDevTargetSyncConflicts({
    target,
    status,
    sourceDir: '/source/repo',
    stackBaseDir: '/stack',
    env: { TEST_ENV: '1' },
  }, {
    pathExists: (path) => {
      calls.push({ kind: 'exists', path });
      return false;
    },
    runCommand: async (options) => {
      calls.push({ kind: 'run', options });
      return { code: 0 };
    },
    runControl: async (options) => {
      calls.push({ kind: 'control', options });
      return { code: 0 };
    },
  });

  assert.deepEqual(result, {
    repaired: true,
    roots: ['packages/plugins/retired-plugin'],
  });
  assert.deepEqual(calls[0], {
    kind: 'exists',
    path: '/source/repo/packages/plugins/retired-plugin',
  });
  assert.equal(calls[1].options.syncAlreadyVerified, true);
  assert.equal(calls[1].options.dependencyAdmission, 'skip');
  assert.deepEqual(calls[1].options.commandArgs.slice(-8), [
    'hstack-sync-repair',
    '/remote/repo',
    'packages/plugins/retired-plugin',
    'node_modules',
    'dist',
    '.happier',
    '.tsbuildinfo',
    '.turbo',
  ]);
  assert.match(calls[1].options.commandArgs[2], /rm -rf -- "\$candidate"/);
  assert.match(calls[1].options.commandArgs[2], /"\$candidate\/\$marker"/);
  assert.match(calls[1].options.commandArgs[2], /"\$candidate_name" = "\$marker"/);
  assert.deepEqual(calls.slice(2).map((call) => call.options.args.slice(0, 2)), [
    ['sync', 'reset'],
    ['sync', 'flush'],
  ]);
});

test('recoverable conflict repair refuses when the alpha source root exists again', async () => {
  let ran = false;
  const result = await repairRecoverableDevTargetSyncConflicts({
    target: { name: 'mac', platform: 'posix', repoDir: '/remote/repo' },
    status: {
      session: {
        mode: 'one-way-replica',
        conflicts: [{
          root: 'packages/plugins/retired-plugin',
          alphaChanges: [{
            path: 'packages/plugins/retired-plugin',
            old: { kind: 'directory' },
            new: null,
          }],
          betaChanges: [{
            path: 'packages/plugins/retired-plugin/node_modules',
            old: null,
            new: { kind: 'untracked' },
          }],
        }],
      },
    },
    sourceDir: '/source/repo',
    stackBaseDir: '/stack',
    env: {},
  }, {
    pathExists: () => true,
    runCommand: async () => { ran = true; return { code: 0 }; },
    runControl: async () => { ran = true; return { code: 0 }; },
  });

  assert.deepEqual(result, { repaired: false, roots: [] });
  assert.equal(ran, false);
});

test('recoverable conflict repair skips a root that reappeared without blocking other safe roots', async () => {
  const repairedRoots = [];
  const result = await repairRecoverableDevTargetSyncConflicts({
    target: { name: 'mac', platform: 'posix', repoDir: '/remote/repo' },
    status: {
      session: {
        mode: 'one-way-replica',
        conflicts: [
          {
            root: 'packages/plugins/reappeared-plugin',
            alphaChanges: [{
              path: 'packages/plugins/reappeared-plugin',
              old: { kind: 'directory' },
              new: null,
            }],
            betaChanges: [{
              path: 'packages/plugins/reappeared-plugin/node_modules',
              old: null,
              new: { kind: 'untracked' },
            }],
          },
          {
            root: 'packages/plugins/retired-plugin',
            alphaChanges: [{
              path: 'packages/plugins/retired-plugin',
              old: { kind: 'directory' },
              new: null,
            }],
            betaChanges: [{
              path: 'packages/plugins/retired-plugin/dist',
              old: null,
              new: { kind: 'untracked' },
            }],
          },
        ],
      },
    },
    sourceDir: '/source/repo',
    stackBaseDir: '/stack',
    env: {},
  }, {
    pathExists: (path) => path.endsWith('/reappeared-plugin'),
    runCommand: async ({ commandArgs }) => {
      repairedRoots.push(commandArgs[5]);
      return { code: 0 };
    },
    runControl: async () => ({ code: 0 }),
  });

  assert.deepEqual(result, {
    repaired: true,
    roots: ['packages/plugins/retired-plugin'],
  });
  assert.deepEqual(repairedRoots, ['packages/plugins/retired-plugin']);
});
