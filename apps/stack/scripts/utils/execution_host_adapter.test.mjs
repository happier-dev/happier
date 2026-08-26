import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveExecutionHostController, runExecutionHostAdapter } from './execution_host_adapter.mjs';

test('0.2 execution-host adapter is absent by default and ignores Linux and guarded re-entry', () => {
  const fileOps = { existsSync: () => false, readFileSync: () => '' };
  assert.equal(resolveExecutionHostController({ env: {}, platform: 'darwin', fileOps }), null);
  assert.equal(resolveExecutionHostController({
    env: { HAPPIER_STACK_EXECUTION_HOST_ADAPTER_REENTRY: '1' },
    platform: 'darwin',
    fileOps,
  }), null);
  assert.equal(resolveExecutionHostController({ env: {}, platform: 'linux', fileOps }), null);
});

test('0.2 adapter delegates only to the controller entrypoint materialized by 0.3', async () => {
  const calls = [];
  const controller = '/Users/dev/happier/dev/apps/stack/scripts/execution_host_bridge.mjs';
  const resolved = resolveExecutionHostController({
    env: { HAPPIER_STACK_HOME_DIR: '/Users/dev/.happier-stack' },
    platform: 'darwin',
    fileOps: {
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ version: 2, controllerEntrypoint: controller }),
    },
  });
  assert.equal(resolved, controller);

  const outcome = await runExecutionHostAdapter({
    controllerEntrypoint: resolved,
    localEntrypoint: '/Users/dev/happier/remote-dev/apps/stack/scripts/repo_local.mjs',
    argv: ['tui', '--json'],
    cwd: '/Users/dev/happier/remote-dev',
    env: { PATH: '/usr/bin' },
    boundary: {
      spawn(command, args, options) {
        calls.push({ command, args, options });
        return {
          once(event, listener) {
            if (event === 'close') queueMicrotask(() => listener(19, null));
            return this;
          },
          kill() {},
        };
      },
      onSignal() { return () => {}; },
    },
  });

  assert.deepEqual(outcome, { exitCode: 19, signal: null });
  assert.deepEqual(calls[0].args, [
    controller,
    '--workspace-id=0.2',
    '--local-entrypoint=/Users/dev/happier/remote-dev/apps/stack/scripts/repo_local.mjs',
    '--', 'tui', '--json',
  ]);
  assert.equal(calls[0].options.shell, false);
});

test('0.2 adapter fails closed when the configured 0.3 controller profile is malformed', () => {
  assert.throws(() => resolveExecutionHostController({
    env: { HAPPIER_STACK_HOME_DIR: '/Users/dev/.happier-stack' },
    platform: 'darwin',
    fileOps: { existsSync: () => true, readFileSync: () => '{broken' },
  }), /failed to read execution-host controller/);
});
