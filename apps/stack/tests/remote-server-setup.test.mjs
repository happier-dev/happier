import test from 'node:test';
import assert from 'node:assert/strict';

import { createRemoteServerSetupHarness } from './testkit/remote_server_setup_testkit.mjs';

test('hstack remote server setup requires --ssh', (t) => {
  const h = createRemoteServerSetupHarness(t, { prefix: 'hstack-remote-server-missing-ssh-' });
  const res = h.runRemoteCommand(['server', 'setup', '--json']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr ?? '', /Missing required flag: --ssh/i);
});

test('hstack remote server setup installs hstack and runs self-host install', (t) => {
  const h = createRemoteServerSetupHarness(t, { prefix: 'hstack-remote-server-default-' });
  const res = h.runRemoteCommand(['server', 'setup', '--ssh', 'dev@host', '--json']);
  assert.equal(res.status, 0, res.stderr);

  const log = h.readInvocationsLog();
  const invocations = log
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const sshCalls = invocations.filter((i) => i?.bin === 'ssh' && Array.isArray(i.argv));
  assert.ok(sshCalls.length >= 1, `expected ssh invocations\n${log}`);
  for (const call of sshCalls) {
    const cmd = String(call.argv[3] ?? '');
    assert.ok(cmd.startsWith("'") && cmd.endsWith("'"), `expected quoted bash -lc command arg\n${log}`);
  }
  assert.ok(log.includes('"bin":"ssh"'), `expected ssh invocations\n${log}`);
  assert.ok(log.includes('happier.dev/install'), `expected remote install script\n${log}`);
  assert.ok(log.includes('self-host'), `expected self-host install invocation\n${log}`);
  assert.ok(log.includes('--channel=stable'), `expected stable channel\n${log}`);
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
  assert.ok(log.includes('--channel=preview'), `expected preview channel\n${log}`);
  assert.ok(log.includes('--env'), `expected env args\n${log}`);
  assert.ok(log.includes('HAPPIER_SERVER_PORT=3999'), `expected forwarded port override\n${log}`);
  assert.ok(log.includes('HAPPIER_DB_PROVIDER=sqlite'), `expected forwarded db provider override\n${log}`);
});
