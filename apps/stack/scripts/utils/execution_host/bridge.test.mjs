import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runExecutionHostBridge, runNativeExecutionHostBridge } from './bridge.mjs';

const profile = {
  version: 2,
  mode: 'managed-lima',
  activation: 'candidate',
  instance: 'primary',
  limaHome: '/Users/example/.happier-stack/lima',
  profile: 'balanced',
  pressureProfile: 'none',
  guestWorkspaceDir: '/home/example/.happier-stack/workspace',
  mirrorWorkspaceDir: '/Users/example/.happier-stack/workspace-mirror',
  controllerEntrypoint: '/Users/example/happier/dev/apps/stack/scripts/execution_host_bridge.mjs',
  workspaces: [
    {
      id: '0.2',
      hostSourceDir: '/Users/example/happier/remote-dev',
      hostMirrorDir: '/Users/example/.happier-stack/workspace-mirror/0.2',
      guestDir: '/home/example/.happier-stack/workspace/0.2',
    },
    {
      id: '0.3',
      hostSourceDir: '/Users/example/happier/dev',
      hostMirrorDir: '/Users/example/.happier-stack/workspace-mirror/0.3',
      guestDir: '/home/example/.happier-stack/workspace/0.3',
    },
  ],
};

function boundaryWithExit(exitCode, calls) {
  return {
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return {
        once(event, listener) {
          if (event === 'close') queueMicrotask(() => listener(exitCode, null));
          return this;
        },
        kill() {},
      };
    },
    onSignal() { return () => {}; },
  };
}

test('predecessor primary assignment stays on the shared controller rather than the 0.2 command registry', async () => {
  const calls = [];
  const result = await runExecutionHostBridge({
    profile: { ...profile, activation: 'active' }, workspaceId: '0.2',
    localEntrypoint: '/Users/example/happier/remote-dev/apps/stack/scripts/repo_local.mjs',
    argv: ['dev-vm', 'primary', 'assign', 'nl2', '--stack=lane', '--json'],
    cwd: '/Users/example/happier/remote-dev', env: {}, platform: 'darwin',
    boundary: boundaryWithExit(0, calls),
  });
  assert.deepEqual(result, { exitCode: 0, signal: null, delegated: false });
  assert.deepEqual(calls[0].args, [
    fileURLToPath(new URL('../../host.mjs', import.meta.url)),
    'primary', 'assign', 'nl2', '--stack=lane', '--json',
  ]);
});

test('native bridge retains dispatcher flags and package cwd on the authoritative host', async () => {
  const calls = [];
  const argv = ['--target=worker', '--cwd=apps/ui', '--env=NODE_OPTIONS=--max-old-space-size=8192', '--script=test:unit:local', '--', '-t', 'literal argument'];
  const result = await runNativeExecutionHostBridge({
    profile: { ...profile, activation: 'active' },
    launcher: '/Users/example/.happier-stack/workspace-mirror/0.3/apps/stack/bin/hstack-exec',
    argv, cwd: '/Users/example/.happier-stack/workspace-mirror/0.3/apps/ui',
    env: { PATH: '/usr/bin' }, platform: 'darwin', prepare: async () => {},
    boundary: boundaryWithExit(7, calls),
  });
  assert.deepEqual(result, { exitCode: 7, signal: null });
  assert.equal(calls[0].args[2], '/home/example/.happier-stack/workspace/0.3/apps/ui');
  assert.deepEqual(calls[0].args.slice(-(argv.length + 2)), [
    '/bin/sh', '/home/example/.happier-stack/workspace/0.3/apps/stack/bin/hstack-exec', ...argv,
  ]);
});

for (const activation of ['candidate', 'active']) {
  test(`native bridge preserves local execution for ${activation === 'candidate' ? 'candidate profiles' : 'guarded re-entry'}`, async () => {
    const calls = [];
    const launcher = '/Users/example/.happier-stack/workspace-mirror/0.3/apps/stack/bin/hstack-exec';
    const result = await runNativeExecutionHostBridge({
      profile: { ...profile, activation }, launcher, argv: ['--', 'probe-command'],
      cwd: '/Users/example/.happier-stack/workspace-mirror/0.3',
      env: activation === 'active' ? { HAPPIER_STACK_EXECUTION_HOST_REENTRY: '1' } : {},
      platform: 'darwin', boundary: boundaryWithExit(3, calls),
    });
    assert.deepEqual(result, { exitCode: 3, signal: null });
    assert.equal(calls[0].command, '/bin/sh');
    assert.deepEqual(calls[0].args, [launcher, '--', 'probe-command']);
    assert.equal(calls[0].options.env.HAPPIER_STACK_EXECUTION_HOST_REENTRY, '1');
  });
}

test('native bridge maps a sibling command repository while retaining the 0.3 executor', async () => {
  const calls = [];
  const result = await runNativeExecutionHostBridge({
    profile: { ...profile, activation: 'active' },
    launcher: '/Users/example/.happier-stack/workspace-mirror/0.3/apps/stack/bin/hstack-exec',
    argv: ['--repo=/Users/example/.happier-stack/workspace-mirror/0.2', '--', 'corepack', 'yarn', 'typecheck'],
    cwd: '/Users/example/.happier-stack/workspace-mirror/0.2/packages/connection-supervisor',
    env: { PATH: '/usr/bin' }, platform: 'darwin', prepare: async () => {},
    boundary: boundaryWithExit(0, calls),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(calls[0].args[2], '/home/example/.happier-stack/workspace/0.2/packages/connection-supervisor');
  assert.deepEqual(calls[0].args.slice(-7), [
    '/bin/sh', '/home/example/.happier-stack/workspace/0.3/apps/stack/bin/hstack-exec',
    '--repo=/home/example/.happier-stack/workspace/0.2', '--', 'corepack', 'yarn', 'typecheck',
  ]);
});

test('candidate bridge preserves default local 0.2 execution through a guarded re-entry', async () => {
  const calls = [];
  const result = await runExecutionHostBridge({
    profile,
    workspaceId: '0.2',
    localEntrypoint: '/Users/example/happier/remote-dev/apps/stack/scripts/repo_local.mjs',
    argv: ['tui', '--json'],
    cwd: '/Users/example/happier/remote-dev',
    env: { PATH: '/usr/bin' },
    platform: 'darwin',
    boundary: boundaryWithExit(7, calls),
  });

  assert.deepEqual(result, { exitCode: 7, signal: null, delegated: false });
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, [
    '/Users/example/happier/remote-dev/apps/stack/scripts/repo_local.mjs',
    'tui', '--json',
  ]);
  assert.equal(calls[0].options.env.HAPPIER_STACK_EXECUTION_HOST_ADAPTER_REENTRY, '1');
});

test('active bridge delegates 0.2 to its matching guest repo-local entrypoint', async () => {
  const calls = [];
  const sockets = () => {
    try { return readdirSync(`/tmp/happier-ghops-brokers-${process.getuid()}`).filter((name) => name.startsWith(`broker-${process.pid}-`)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const originalSockets = sockets();
  const boundary = boundaryWithExit(0, calls);
  const spawnChild = boundary.spawn;
  boundary.spawn = (...args) => {
    assert.deepEqual(sockets(), originalSockets, 'delegation must not create a foreground-owned broker');
    return spawnChild(...args);
  };
  const result = await runExecutionHostBridge({
    profile: { ...profile, activation: 'active' },
    workspaceId: '0.2',
    localEntrypoint: '/Users/example/happier/remote-dev/apps/stack/scripts/repo_local.mjs',
    argv: ['tui', '--json'],
    cwd: '/Users/example/happier/remote-dev',
    env: { PATH: '/usr/bin' },
    platform: 'darwin',
    prepare: async () => {},
    boundary,
  });

  assert.equal(result.delegated, true);
  assert.equal(calls[0].args.some((arg) => arg.startsWith('HAPPIER_GHOPS_')), false);
  assert.equal(calls[0].args.some((arg) => arg.startsWith('HAPPIER_GITHUB_BOT_TOKEN=')), false);
  assert.deepEqual(calls[0].args.slice(-5), [
    'node',
    '/home/example/.happier-stack/workspace/0.2/apps/stack/scripts/repo_local.mjs',
    'tui', '--json', '--rescue',
  ]);
});

test('active bridge refuses a mismatched workspace path instead of executing in another checkout', async () => {
  await assert.rejects(runExecutionHostBridge({
    profile: { ...profile, activation: 'active' },
    workspaceId: '0.2',
    localEntrypoint: '/Users/example/happier/remote-dev/apps/stack/scripts/repo_local.mjs',
    argv: ['tui'],
    cwd: '/Users/example/happier/dev',
    env: {},
    platform: 'darwin',
    prepare: async () => {},
    boundary: boundaryWithExit(0, []),
  }), /does not belong to workspace 0.2/);
});
