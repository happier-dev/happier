import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readRunningStackIdentityDaemons,
  restartStackIdentityDaemons,
} from './run_script_with_stack_env.mjs';

test('reload captures and restarts exactly the running named identity daemons', async () => {
  const observed = new Map([
    ['account-a', 'running'],
    ['account-b', 'running'],
    ['stopped', 'stopped'],
  ]);
  const runtimeState = {
    daemon: { desiredStateByIdentity: {
      'account-a': 'running',
      'account-b': 'running',
      stopped: 'stopped',
    } },
  };
  const identities = await readRunningStackIdentityDaemons({
    runtimeState,
    cliHomeDir: '/tmp/identity-reload/cli',
    stackName: 'identity-reload',
    serverUrl: 'http://127.0.0.1:3010',
    env: {},
  }, {
    checkDaemonStateImpl: async (_home, { env }) => ({ status: observed.get(env.HAPPIER_STACK_CLI_IDENTITY) }),
  });

  const restarted = [];
  const result = await restartStackIdentityDaemons({
    rootDir: '/repo/apps/stack',
    stackName: 'identity-reload',
    identities,
    env: {},
  }, {
    startIdentityDaemonImpl: async (identity) => {
      restarted.push(identity);
      return { ok: true, cliIdentity: identity, loaded: 'new-runtime' };
    },
  });

  assert.deepEqual(identities, ['account-a', 'account-b']);
  assert.deepEqual(restarted, ['account-a', 'account-b']);
  assert.deepEqual(result, {
    started: ['account-a', 'account-b'],
    failures: [],
  });
});

test('identity restart reports a typed failure without retrying', async () => {
  const attempts = [];
  const result = await restartStackIdentityDaemons({
    stackName: 'identity-reload',
    identities: ['account-a'],
  }, {
    startIdentityDaemonImpl: async (identity) => {
      attempts.push(identity);
      return { ok: false, error: 'auth_required' };
    },
  });

  assert.deepEqual(attempts, ['account-a']);
  assert.deepEqual(result, {
    started: [],
    failures: [{ identity: 'account-a', reason: 'auth_required' }],
  });
});
