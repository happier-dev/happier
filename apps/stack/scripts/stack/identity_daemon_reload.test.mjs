import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readRunningStackIdentityDaemons,
  restartStackIdentityDaemons,
} from './identity_daemon_reload.mjs';

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

// Fixture homes can predate the desired-state map or survive a stale runtime file.
test('reload discovers running identity homes even with stale runtime intent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'identity-reload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const identity of ['fixture-a', 'fixture-b', 'stale', 'stopped']) {
    await mkdir(join(root, 'cli-identities', identity), { recursive: true });
  }
  const identities = await readRunningStackIdentityDaemons({
    runtimeState: { daemon: { desiredStateByIdentity: { 'fixture-a': 'running', stopped: 'stopped' } } },
    cliHomeDir: join(root, 'cli'), stackName: 'identity-reload', env: {},
  }, {
    checkDaemonStateImpl: async (home) => ({
      status: ['fixture-a', 'fixture-b'].some(id => home.endsWith(id)) ? 'running' : 'stopped',
    }),
  });
  assert.deepEqual(identities.sort(), ['fixture-a', 'fixture-b']);
});

for (const unavailable of ['unreachable', 'throws']) test(`identity reload skips a scoped participant (${unavailable}) and restores later identities`, async (t) => {
  const warnings = [];
  const warn = console.warn;
  console.warn = line => warnings.push(line);
  t.after(() => { console.warn = warn; });
  const identities = ['qa-f-e2ee-fixtures', 'b', 'c1', 'c2', 'c3', 'c4'];
  const runtimeState = { daemon: { desiredStateByIdentity: Object.fromEntries(identities.map(id => [id, 'running'])) } };
  // The observation adapter is the OS/daemon-control boundary; identity selection stays real.
  const eligible = await readRunningStackIdentityDaemons({ runtimeState,
    cliHomeDir: '/tmp/identity-reload/cli', stackName: 'identity-reload', env: {},
  }, { checkDaemonStateImpl: async (_home, { env }) => {
    if (env.HAPPIER_STACK_CLI_IDENTITY === identities[0]) {
      if (unavailable === 'throws') throw Object.assign(new Error('private diagnostic'), { code: 'scope_unavailable' });
      return { status: 'unreachable', reason: 'scope_unavailable' };
    }
    return { status: 'running' };
  } });
  const attempts = [];
  const restored = await restartStackIdentityDaemons({ identities: eligible }, {
    startIdentityDaemonImpl: async identity => { attempts.push(identity); return { ok: true }; },
  });
  assert.deepEqual(attempts, identities.slice(1));
  assert.deepEqual(restored, { started: identities.slice(1), failures: [] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /qa-f-e2ee-fixtures.*skipped.*scope_unavailable/);
  assert.doesNotMatch(warnings[0], /private diagnostic/);
});
