import assert from 'node:assert/strict';
import test from 'node:test';

import {
  startDevTargetRuntime,
  startManagedDevTargetRuntime,
} from './managed_runtime.mjs';

test('managed runtime startup refreshes guest SSH publication from the running Lima instance before returning', async () => {
  const target = {
    name: 'worker',
    managedRuntime: {
      kind: 'lima',
      instance: 'happier-worker',
      limaHome: '/Users/dev/.happier/lima',
      host: { kind: 'local' },
    },
  };
  const calls = [];

  const result = await startManagedDevTargetRuntime({ target, env: {} }, {
    createExecutor: () => ({ marker: 'executor' }),
    startRuntime: async (input) => {
      calls.push(['start', input]);
      return { changed: true, status: 'Running' };
    },
    getRuntimeStatus: async (input) => {
      calls.push(['status', input]);
      return { exists: true, status: 'Running', instance: { sshLocalPort: 60955 } };
    },
    ensureGuestLoginManager: async (input) => {
      calls.push(['login-manager', input]);
      return { repaired: false };
    },
    reconcileSshPublication: async (input) => {
      calls.push(['publication', input]);
      return { changed: true, port: 60955, hostKeyAliasAdded: false };
    },
  });

  assert.equal(calls[0][0], 'start');
  assert.equal(calls[1][0], 'status');
  assert.equal(calls[2][0], 'login-manager');
  assert.equal(calls[3][0], 'publication');
  assert.equal(calls[3][1].sshLocalPort, 60955);
  assert.deepEqual(result.guestLoginManager, { repaired: false });
  assert.deepEqual(result.sshPublication, { changed: true, port: 60955, hostKeyAliasAdded: false });
});

test('legacy local Lima targets use the canonical retained runtime lifecycle', async () => {
  const target = {
    name: 'linux',
    limaInstance: 'happier-dev-bench',
    limaHome: '/tmp/lima',
  };
  const calls = [];

  const result = await startDevTargetRuntime({ target, env: { TEST: '1' } }, {
    createExecutor: (runtimeTarget, env) => {
      calls.push(['executor', runtimeTarget, env]);
      return { marker: 'executor' };
    },
    startRuntime: async (input) => {
      calls.push(['start', input]);
      return { changed: true, status: 'Running' };
    },
    getRuntimeStatus: async (input) => {
      calls.push(['status', input]);
      return { exists: true, status: 'Running', instance: { sshLocalPort: 60955 } };
    },
    ensureGuestLoginManager: async (input) => {
      calls.push(['login-manager', input]);
      return { repaired: false };
    },
  });

  assert.equal(calls[0][0], 'executor');
  assert.deepEqual(calls[0][1].managedRuntime, {
    kind: 'lima',
    instance: 'happier-dev-bench',
    limaHome: '/tmp/lima',
    host: { kind: 'local' },
  });
  assert.equal(calls[1][0], 'start');
  assert.equal(calls[2][0], 'status');
  assert.equal(calls[3][0], 'login-manager');
  assert.deepEqual(result.guestLoginManager, { repaired: false });
  assert.equal(result.sshPublication, null);
});
