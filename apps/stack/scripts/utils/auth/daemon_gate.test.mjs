import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { daemonStartGate, formatDaemonAuthRequiredError, hasStackCredentials } from './daemon_gate.mjs';
import { resolveStackCredentialPaths } from './credentials_paths.mjs';

async function withTempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-gate-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('hasStackCredentials detects access.key', async (t) => {
  const dir = await withTempRoot(t);
  assert.equal(hasStackCredentials({ cliHomeDir: dir }), false);
  await writeFile(join(dir, 'access.key'), 'dummy', 'utf-8');
  assert.equal(hasStackCredentials({ cliHomeDir: dir }), true);
});

test('hasStackCredentials detects server-scoped access.key for env server urls', async (t) => {
  const dir = await withTempRoot(t);
  const serverUrl = 'http://127.0.0.1:3009';
  const paths = resolveStackCredentialPaths({ cliHomeDir: dir, serverUrl });
  const gateBefore = hasStackCredentials({ cliHomeDir: dir, serverUrl });
  assert.equal(gateBefore, false);

  await mkdir(join(dir, 'servers', paths.activeServerId), { recursive: true });
  await writeFile(paths.serverScopedPath, 'dummy', 'utf-8');

  const gateAfter = hasStackCredentials({ cliHomeDir: dir, serverUrl });
  assert.equal(gateAfter, true);
});

test('daemonStartGate blocks daemon start in auth flow when missing credentials', async (t) => {
  const dir = await withTempRoot(t);
  const gate = daemonStartGate({ env: { HAPPIER_STACK_AUTH_FLOW: '1' }, cliHomeDir: dir });
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'auth_flow_missing_credentials');
});

test('daemonStartGate blocks daemon start in daemon-wait auth flow when missing credentials', async (t) => {
  const dir = await withTempRoot(t);
  const gate = daemonStartGate({ env: { HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH: '1' }, cliHomeDir: dir });
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'auth_flow_missing_credentials');
});

test('daemonStartGate blocks daemon start when missing credentials (non-auth flow)', async (t) => {
  const dir = await withTempRoot(t);
  const gate = daemonStartGate({ env: {}, cliHomeDir: dir });
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'missing_credentials');
});

test('daemonStartGate allows daemon start when credentials exist', async (t) => {
  const dir = await withTempRoot(t);
  await writeFile(join(dir, 'access.key'), 'dummy', 'utf-8');
  const gate = daemonStartGate({ env: {}, cliHomeDir: dir });
  assert.equal(gate.ok, true);
  assert.equal(gate.reason, 'credentials_present');
});

test('daemonStartGate resolves server-scoped credentials from env server url', async (t) => {
  const dir = await withTempRoot(t);
  const serverUrl = 'http://127.0.0.1:4010';
  const paths = resolveStackCredentialPaths({ cliHomeDir: dir, serverUrl });
  await mkdir(join(dir, 'servers', paths.activeServerId), { recursive: true });
  await writeFile(paths.serverScopedPath, 'dummy', 'utf-8');

  const gate = daemonStartGate({
    env: { HAPPIER_SERVER_URL: serverUrl },
    cliHomeDir: dir,
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.reason, 'credentials_present');
});

test('daemonStartGate resolves stable-scope credentials from HAPPIER_ACTIVE_SERVER_ID', async (t) => {
  const dir = await withTempRoot(t);
  const serverUrl = 'http://127.0.0.1:4010';
  const env = { HAPPIER_SERVER_URL: serverUrl, HAPPIER_ACTIVE_SERVER_ID: 'stack_main__id_default' };
  const paths = resolveStackCredentialPaths({ cliHomeDir: dir, serverUrl, env });
  await mkdir(join(dir, 'servers', paths.activeServerId), { recursive: true });
  await writeFile(paths.serverScopedPath, 'dummy', 'utf-8');

  const gate = daemonStartGate({
    env,
    cliHomeDir: dir,
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.reason, 'credentials_present');
});

test('daemonStartGate prefers credentials over auth-flow toggles', async (t) => {
  const dir = await withTempRoot(t);
  await writeFile(join(dir, 'access.key'), 'dummy', 'utf-8');

  const gate = daemonStartGate({
    env: { HAPPIER_STACK_AUTH_FLOW: 'true', HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH: '1' },
    cliHomeDir: dir,
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.reason, 'credentials_present');
});

test('formatDaemonAuthRequiredError suggests mobile QR login for headless servers', () => {
  const msg = formatDaemonAuthRequiredError({ stackName: 'main', cliHomeDir: '/tmp/cli-home' });
  assert.match(msg, /hstack auth login/i);
  assert.match(msg, /--method=mobile/i);
  assert.match(msg, /--no-open/i);
});
