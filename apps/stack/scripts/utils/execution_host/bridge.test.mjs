import assert from 'node:assert/strict';
import test from 'node:test';

import { runExecutionHostBridge } from './bridge.mjs';

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
  const result = await runExecutionHostBridge({
    profile: { ...profile, activation: 'active' },
    workspaceId: '0.2',
    localEntrypoint: '/Users/example/happier/remote-dev/apps/stack/scripts/repo_local.mjs',
    argv: ['tui', '--json'],
    cwd: '/Users/example/happier/remote-dev',
    env: { PATH: '/usr/bin' },
    platform: 'darwin',
    prepare: async () => {},
    boundary: boundaryWithExit(0, calls),
  });

  assert.equal(result.delegated, true);
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
