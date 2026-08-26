import assert from 'node:assert/strict';
import test from 'node:test';

import { startManagedDevTargetRuntime } from './managed_runtime.mjs';

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
    reconcileSshPublication: async (input) => {
      calls.push(['publication', input]);
      return { changed: true, port: 60955, hostKeyAliasAdded: false };
    },
  });

  assert.equal(calls[0][0], 'start');
  assert.equal(calls[1][0], 'status');
  assert.equal(calls[2][0], 'publication');
  assert.equal(calls[2][1].sshLocalPort, 60955);
  assert.deepEqual(result.sshPublication, { changed: true, port: 60955, hostKeyAliasAdded: false });
});
