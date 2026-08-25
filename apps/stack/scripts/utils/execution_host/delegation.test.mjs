import assert from 'node:assert/strict';
import test from 'node:test';

import { mapHostCwdToGuest, runDelegatedHstackCommand } from './delegation.mjs';

const profile = {
  version: 1,
  mode: 'managed-lima',
  activation: 'active',
  instance: 'primary',
  limaHome: '/Users/example/.happier-stack/lima',
  profile: 'balanced',
  guestWorkspaceDir: '/home/example/.happier-stack/workspace',
  mirrorWorkspaceDir: '/Users/example/.happier-stack/workspace-mirror',
};

test('active host delegation maps only the non-authoritative mirror into the guest workspace', () => {
  assert.equal(
    mapHostCwdToGuest(profile, '/Users/example/.happier-stack/workspace-mirror/dev/apps/stack'),
    '/home/example/.happier-stack/workspace/dev/apps/stack',
  );
  assert.equal(
    mapHostCwdToGuest(profile, '/Users/example/Documents/unrelated'),
    profile.guestWorkspaceDir,
  );
  assert.equal(
    mapHostCwdToGuest(profile, '/Users/example/.happier-stack/workspace-mirror-evil/dev'),
    profile.guestWorkspaceDir,
  );
});

test('active host delegation preserves argv, recursion guard, cwd, and terminal outcome without a shell', async () => {
  const spawns = [];
  const listeners = new Map();
  const child = {
    once(event, listener) {
      listeners.set(event, listener);
      if (event === 'close') queueMicrotask(() => listener(23, null));
      return this;
    },
    kill() {},
  };
  const result = await runDelegatedHstackCommand({
    profile,
    argv: ['typecheck', 'path with spaces', "apostrophe's"],
    cwd: '/Users/example/.happier-stack/workspace-mirror/dev',
    env: { PATH: '/usr/bin' },
    prepare: async () => {},
    boundary: {
      spawn(command, args, options) {
        spawns.push({ command, args, options });
        return child;
      },
      onSignal() { return () => {}; },
    },
  });

  assert.deepEqual(result, { exitCode: 23, signal: null });
  assert.equal(spawns[0].command, 'limactl');
  assert.deepEqual(spawns[0].args, [
    'shell', '--workdir', '/home/example/.happier-stack/workspace/dev', 'primary', '--',
    'env',
    'HAPPIER_STACK_EXECUTION_HOST_REENTRY=1',
    'HAPPIER_STACK_INVOKED_CWD=/home/example/.happier-stack/workspace/dev',
    'hstack', 'typecheck', 'path with spaces', "apostrophe's",
  ]);
  assert.equal(spawns[0].options.shell, false);
  assert.equal(spawns[0].options.env.LIMA_HOME, profile.limaHome);
});
