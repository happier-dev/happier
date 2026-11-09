import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { writeFakeBin } from './testkit/core/fake_bin_harness.mjs';
import { buildStackFixtureEnv, withPatchedProcessEnv } from './testkit/core/env_scope.mjs';
import { runNodeCapture } from './testkit/core/run_node_capture.mjs';
import { prepareStackRelay, inspectHostRelay } from './utils/server/infra/iroh/runtime.mjs';
import { maybeEnableTailscaleServe, maybeResetTailscaleServe, resolvePublicServerUrl } from './tailscale.mjs';

const repoDir = fileURLToPath(new URL('../../../', import.meta.url));
const refusalCode = 'tailscale_operator_authorization_refused';
const privateMarker = '/private/tailscale-fixture-secret';

async function refusalFixture(t) {
  const fixture = await createTempFixture(t, { prefix: 'tailscale-refusal-' });
  const { binPath } = writeFakeBin({ root: fixture.root, name: 'tailscale', content: `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TAILSCALE_TEST_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'serve' && (args[1] !== 'status' || process.env.TAILSCALE_TEST_REFUSE_STATUS === '1')) {
  console.error("sending serve config: 401 Unauthorized: must be root, or be an operator and able to run 'sudo tailscale' to serve a path or Unix socket");
  console.error(${JSON.stringify(privateMarker)});
  process.exit(1);
}
if (args[0] === 'serve' && args[1] === 'status') {
  console.log('https://refusal-fixture.ts.net\\n|-- / proxy http://127.0.0.1:3005');
  process.exit(0);
}
process.exit(1);
` });
  const env = buildStackFixtureEnv({ stripStackEnv: true, homeDir: fixture.path('home'),
    storageDir: fixture.path('storage'), extraEnv: {
      HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL: '1', HAPPIER_TAILSCALE_BIN: binPath,
      // Relay configuration belongs to CLI home, not the Stack-home override above.
      HAPPIER_HOME_DIR: fixture.path('cli-home'),
      HAPPIER_STACK_SERVER_PORT: '3005', TAILSCALE_TEST_CALLS: fixture.path('calls'),
    } });
  return { fixture, env };
}

function assertRefusal(failure) {
  assert.equal(failure?.code, refusalCode);
  assert.equal(failure.retryable, false);
  assert.match(failure.remediation, /sudo/);
  assert.equal(JSON.stringify(failure).includes(privateMarker), false);
}

test('native operator refusal remains typed and actionable in stack command JSON and text', async t => {
  const { env } = await refusalFixture(t);
  for (const action of ['status', 'url', 'enable', 'disable', 'reset']) {
    const result = await runNodeCapture(['apps/stack/scripts/tailscale.mjs', action, '--json'], {
      cwd: repoDir, env: { ...env, TAILSCALE_TEST_REFUSE_STATUS: ['status', 'url'].includes(action) ? '1' : '' },
    });
    assert.equal(result.code, 1);
    assertRefusal(JSON.parse(result.stdout).failure);
    assert.equal((result.stdout + result.stderr).includes(privateMarker), false);
  }
  const text = await runNodeCapture(['apps/stack/scripts/tailscale.mjs', 'enable'], { cwd: repoDir, env });
  assert.equal(text.code, 1);
  assert.match(text.stdout + text.stderr, /sudo/);
  assert.equal((text.stdout + text.stderr).includes(privateMarker), false);
});

test('native operator refusal degrades only the relay and survives retained host status without retries', async t => {
  const { fixture, env } = await refusalFixture(t);
  withPatchedProcessEnv(t, { HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL: '1' });
  const relayEnv = { ...env, HAPPIER_STACK_IROH_RELAY: '1', HAPPIER_IROH_RELAY_POLICY: '',
    HAPPIER_SERVER_URL: 'https://ordinary-home.example.test', TAILSCALE_TEST_REFUSE_STATUS: '1' };
  const prepared = await prepareStackRelay({ repoDir, env: relayEnv });
  assert.equal(prepared.relay.status, 'degraded');
  assert.equal(prepared.relay.reason, refusalCode);
  assertRefusal(prepared.relay.failure);
  assert.equal(prepared.relay.remediation, prepared.relay.failure.remediation);
  assert.equal(prepared.env.HAPPIER_SERVER_URL, relayEnv.HAPPIER_SERVER_URL);
  assert.equal(prepared.env.HAPPIER_IROH_RELAY_POLICY, 'disabled');
  const observed = await inspectHostRelay({ env: relayEnv });
  assert.equal(observed.reason, refusalCode);
  assert.equal(observed.remediation, prepared.relay.remediation);
  assert.deepEqual(observed.failure, prepared.relay.failure);
  const status = await runNodeCapture(['apps/stack/scripts/iroh_relay.mjs', 'status', '--json'], {
    cwd: repoDir, env: relayEnv,
  });
  assert.equal(status.code, 0);
  assert.equal(JSON.parse(status.stdout).reason, refusalCode);
  assertRefusal(JSON.parse(status.stdout).failure);
  assert.equal((status.stdout + status.stderr).includes(privateMarker), false);
  assert.equal((await readFile(fixture.path('calls'), 'utf8')).trim().split('\n').length, 1,
    'a non-retryable refusal settles without status re-polls');
});

test('best-effort public URL selection retains the refusal and skips readiness re-polls', async t => {
  const { fixture, env } = await refusalFixture(t);
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  withPatchedProcessEnv(t, { HAPPIER_TAILSCALE_BIN: env.HAPPIER_TAILSCALE_BIN,
    HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL: '1', HAPPIER_STACK_TAILSCALE_SERVE_PATH: '/fixture',
    TAILSCALE_TEST_CALLS: env.TAILSCALE_TEST_CALLS });
  const fallback = await resolvePublicServerUrl({ internalServerUrl: 'http://127.0.0.1:3006',
    defaultPublicUrl: 'http://127.0.0.1:3006', allowEnable: true, stackName: 'main',
    env: { ...env, HAPPIER_STACK_TAILSCALE_SERVE: '1', HAPPIER_STACK_TAILSCALE_WAIT_MS: '50' } });
  assert.equal(fallback.publicServerUrl, 'http://127.0.0.1:3006');
  assertRefusal(fallback.failure);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes(refusalCode));
  assert.match(warnings[0], /sudo/);
  assert.equal(warnings[0].includes(privateMarker), false);
  const calls = (await readFile(fixture.path('calls'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.filter(args => args[1] === 'status').length, 1,
    'a non-retryable enable refusal must not enter the status polling loop');
});

test('optional Serve enable preserves the canonical refusal for its caller', async t => {
  const { env } = await refusalFixture(t);
  withPatchedProcessEnv(t, { HAPPIER_TAILSCALE_BIN: env.HAPPIER_TAILSCALE_BIN,
    HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL: '1', HAPPIER_STACK_TAILSCALE_SERVE: '1',
    HAPPIER_STACK_TAILSCALE_SERVE_PATH: '/fixture', TAILSCALE_TEST_CALLS: env.TAILSCALE_TEST_CALLS });
  await assert.rejects(maybeEnableTailscaleServe({ internalServerUrl: 'http://127.0.0.1:3006' }), error => {
    assertRefusal(error.failure);
    assert.equal(error.message.includes(privateMarker), false);
    return true;
  });
});

test('a refused optional URL observation preserves the fallback without enabling or polling', async t => {
  const { fixture, env } = await refusalFixture(t);
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  withPatchedProcessEnv(t, { ...env, TAILSCALE_TEST_REFUSE_STATUS: '1' });
  for (const stackName of ['main', 'isolated']) {
    const result = await resolvePublicServerUrl({ internalServerUrl: 'http://127.0.0.1:3005',
      defaultPublicUrl: 'http://127.0.0.1:3005', allowEnable: true, stackName, env });
    assert.equal(result.publicServerUrl, 'http://127.0.0.1:3005');
    assertRefusal(result.failure);
  }
  assert.equal(warnings.length, 2);
  assert.equal(warnings.join('\n').includes(privateMarker), false);
  const calls = (await readFile(fixture.path('calls'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls, [['serve', 'status'], ['serve', 'status']]);
});

test('optional Serve cleanup reports the typed refusal and settles without failing shutdown', async t => {
  const { fixture, env } = await refusalFixture(t);
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  withPatchedProcessEnv(t, { ...env, HAPPIER_STACK_STACK: 'main',
    HAPPIER_STACK_RUNTIME_STATE_PATH: fixture.path('no-runtime.json'),
    HAPPIER_STACK_TAILSCALE_SERVE: '1', HAPPIER_STACK_TAILSCALE_RESET_ON_EXIT: '1',
    HAPPIER_STACK_TAILSCALE_UPSTREAM: 'http://127.0.0.1:3005', HAPPIER_STACK_TAILSCALE_SERVE_PATH: '/' });
  await maybeResetTailscaleServe();
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes(refusalCode));
  assert.match(warnings[0], /sudo/);
  assert.equal(warnings[0].includes(privateMarker), false);
});
