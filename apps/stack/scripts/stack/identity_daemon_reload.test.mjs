import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
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

for (const thrown of [false, true]) test(`reload publishes exactly one outcome per named identity (throws=${thrown})`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'identity-outcomes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'source-runtime'), { recursive: true });
  if (thrown) await writeFile(join(root, 'source-runtime/reload.json'), JSON.stringify({ status: 'ready', logPath: '/existing-log' }));
  const lines = [];
  const log = console.log, warn = console.warn;
  console.log = console.warn = line => lines.push(line);
  t.after(() => { console.log = log; console.warn = warn; });
  const skipped = [];
  const identities = await readRunningStackIdentityDaemons({
    runtimeState: { daemon: { desiredStateByIdentity: { restored: 'running', refused: 'running', stopped: 'stopped' } } },
    cliHomeDir: join(root, 'cli'), stackName: 'outcomes', env: {}, skipped,
  }, { checkDaemonStateImpl: async () => ({ status: 'running' }) });
  const result = await restartStackIdentityDaemons({ stackName: 'outcomes', identities, skipped, stackBaseDir: root }, {
    startIdentityDaemonImpl: async identity => {
      if (identity === 'restored') return { started: true };
      const refusal = { ok: false, code: 'SOURCE_RUNTIME_RELOAD_REQUIRED', reason: 'closure_changed' };
      if (thrown) throw Object.assign(new Error('private diagnostic'), refusal);
      return refusal;
    },
  });
  assert.deepEqual(result.failures, [{ identity: 'refused', code: 'SOURCE_RUNTIME_RELOAD_REQUIRED', reason: 'closure_changed' }]);
  for (const identity of ['restored', 'refused', 'stopped']) {
    assert.equal(lines.filter(line => line.includes(`identity daemon ${identity} `)).length, 1);
  }
  assert.match(lines.find(line => line.includes('identity daemon restored ')), /restored/);
  assert.match(lines.find(line => line.includes('identity daemon stopped ')), /skipped.*owner_stopped/);
  assert.match(lines.find(line => line.includes('identity daemon refused ')), /refused.*SOURCE_RUNTIME_RELOAD_REQUIRED.*closure_changed/);
  assert.doesNotMatch(lines.join('\n'), /private diagnostic/);
  const status = JSON.parse(await readFile(join(root, 'source-runtime/reload.json'), 'utf8'));
  assert.equal(status.status, thrown ? 'ready' : undefined);
  assert.equal(status.logPath, thrown ? '/existing-log' : undefined);
  assert.deepEqual(status.identityRestore.failures, result.failures);
});

test('a daemon start that did not start is never reported restored', async () => {
  const result = await restartStackIdentityDaemons({ identities: ['stopped', 'failed'] }, {
    startIdentityDaemonImpl: async identity => identity === 'stopped'
      ? { ok: true, started: false, reason: 'daemon-stopped-by-owner' } : { started: false },
  });
  assert.deepEqual(result.started, []);
  assert.deepEqual(result.failures, [{ identity: 'failed', reason: 'daemon_start_failed' }]);
});
