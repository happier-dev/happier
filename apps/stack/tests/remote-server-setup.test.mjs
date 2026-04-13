import test from 'node:test';
import assert from 'node:assert/strict';

import { createRemoteServerSetupHarness } from './testkit/remote_server_setup_testkit.mjs';

test('hstack remote server setup requires --ssh', (t) => {
  const h = createRemoteServerSetupHarness(t, { prefix: 'hstack-remote-server-missing-ssh-' });
  const res = h.runRemoteCommand(['server', 'setup', '--json']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr ?? '', /Missing required flag: --ssh/i);
});

test('hstack remote relay setup is an alias for remote server setup', (t) => {
  const h = createRemoteServerSetupHarness(t, { prefix: 'hstack-remote-relay-alias-' });
  const res = h.runRemoteCommand(['relay', 'setup', '--ssh', 'dev@host', '--json']);
  assert.equal(res.status, 0, res.stderr);

  const log = h.readInvocationsLog();
  assert.ok(log.includes('"bin":"happier"'), `expected delegation to happier\n${log}`);
  assert.ok(log.includes('"relay","host","install"'), `expected relay host install delegation\n${log}`);
});

test('hstack remote server setup delegates to happier relay host install (no direct ssh orchestration)', (t) => {
  const h = createRemoteServerSetupHarness(t, { prefix: 'hstack-remote-server-default-' });
  const res = h.runRemoteCommand(['server', 'setup', '--ssh', 'dev@host', '--json']);
  assert.equal(res.status, 0, res.stderr);

  const log = h.readInvocationsLog();
  assert.ok(log.includes('"bin":"happier"'), `expected delegation to happier\n${log}`);
  assert.ok(log.includes('"relay","host","install"'), `expected relay host install delegation\n${log}`);
  assert.ok(log.includes('--ssh'), `expected ssh forwarded to happier\n${log}`);
  assert.ok(log.includes('dev@host'), `expected ssh target forwarded\n${log}`);
  assert.ok(log.includes('--channel=stable'), `expected stable channel forwarded\n${log}`);
  assert.ok(!log.includes('"bin":"ssh"'), `expected no ssh orchestration in hstack wrapper\n${log}`);
});

test('hstack remote server setup forwards env overrides to self-host install', (t) => {
  const h = createRemoteServerSetupHarness(t, { prefix: 'hstack-remote-server-env-' });
  const res = h.runRemoteCommand([
    'server',
    'setup',
    '--ssh',
    'dev@host',
    '--preview',
    '--env',
    'HAPPIER_SERVER_PORT=3999',
    '--env',
    'HAPPIER_DB_PROVIDER=sqlite',
    '--json',
  ]);
  assert.equal(res.status, 0, res.stderr);

  const log = h.readInvocationsLog();
  assert.ok(log.includes('"bin":"happier"'), `expected delegation to happier\n${log}`);
  assert.ok(log.includes('--channel=preview'), `expected preview channel\n${log}`);
  assert.ok(log.includes('--env'), `expected env args\n${log}`);
  assert.ok(log.includes('HAPPIER_SERVER_PORT=3999'), `expected forwarded port override\n${log}`);
  assert.ok(log.includes('HAPPIER_DB_PROVIDER=sqlite'), `expected forwarded db provider override\n${log}`);
});

test('hstack remote server setup forwards --server-binary for local candidate installs over ssh', (t) => {
  const h = createRemoteServerSetupHarness(t, { prefix: 'hstack-remote-server-binary-' });
  const res = h.runRemoteCommand([
    'server',
    'setup',
    '--ssh',
    'dev@host',
    '--channel=preview',
    '--server-binary',
    '/tmp/happier-server',
    '--json',
  ]);
  assert.equal(res.status, 0, res.stderr);

  const log = h.readInvocationsLog();
  assert.ok(log.includes('"bin":"happier"'), `expected delegation to happier\n${log}`);
  assert.ok(log.includes('--server-binary'), `expected server binary arg\n${log}`);
  assert.ok(log.includes('/tmp/happier-server'), `expected local server binary path\n${log}`);
  assert.ok(!log.includes('--self-host-server-binary'), `expected legacy ssh flag to be absent\n${log}`);
});

test('hstack remote server setup accepts the dev release ring', (t) => {
  const h = createRemoteServerSetupHarness(t, { prefix: 'hstack-remote-server-dev-' });
  const res = h.runRemoteCommand([
    'server',
    'setup',
    '--ssh',
    'dev@host',
    '--channel=dev',
    '--json',
  ]);
  assert.equal(res.status, 0, res.stderr);

  const log = h.readInvocationsLog();
  assert.ok(log.includes('"bin":"happier"'), `expected delegation to happier\n${log}`);
  assert.ok(log.includes('"relay","host","install"'), `expected relay host install delegation\n${log}`);
  assert.ok(log.includes('--channel=dev'), `expected dev install forwarded\n${log}`);
});
