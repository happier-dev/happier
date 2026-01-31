import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { daemonStartGate, hasStackCredentials } from './daemon_gate.mjs';

test('hasStackCredentials detects access.key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-gate-'));
  assert.equal(hasStackCredentials({ cliHomeDir: dir }), false);
  await writeFile(join(dir, 'access.key'), 'dummy', 'utf-8');
  assert.equal(hasStackCredentials({ cliHomeDir: dir }), true);
});

test('daemonStartGate blocks daemon start in auth flow when missing credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-gate-'));
  const gate = daemonStartGate({ env: { HAPPIER_STACK_AUTH_FLOW: '1' }, cliHomeDir: dir });
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'auth_flow_missing_credentials');
});

test('daemonStartGate blocks daemon start when missing credentials (non-auth flow)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-gate-'));
  const gate = daemonStartGate({ env: {}, cliHomeDir: dir });
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'missing_credentials');
});

test('daemonStartGate allows daemon start when credentials exist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-gate-'));
  await writeFile(join(dir, 'access.key'), 'dummy', 'utf-8');
  const gate = daemonStartGate({ env: {}, cliHomeDir: dir });
  assert.equal(gate.ok, true);
  assert.equal(gate.reason, 'credentials_present');
});
