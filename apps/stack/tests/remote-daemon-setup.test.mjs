import test from 'node:test';
import assert from 'node:assert/strict';

import { createRemoteDaemonSetupHarness } from './testkit/remote_daemon_setup_testkit.mjs';

test('hstack remote daemon setup requires --ssh', (t) => {
  const h = createRemoteDaemonSetupHarness(t, { prefix: 'hstack-remote-daemon-missing-ssh-' });
  const res = h.runRemoteCommand(['daemon', 'setup', '--json']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr ?? '', /Missing required flag: --ssh/i);
});

test('hstack remote daemon setup (service=user) installs, pairs, and installs service', (t) => {
  const h = createRemoteDaemonSetupHarness(t, { prefix: 'hstack-remote-daemon-user-' });
  const res = h.runRemoteCommand([
    'daemon',
    'setup',
    '--ssh',
    'dev@host',
    '--preview',
    '--server-url=https://example.invalid',
    '--json',
  ]);
  assert.equal(res.status, 0, res.stderr);

  const log = h.readInvocationsLog();
  assert.ok(log.includes('"bin":"ssh"'), `expected ssh invocations\n${log}`);
  assert.ok(log.includes('HAPPIER_CHANNEL=preview'), `expected preview channel in remote installer\n${log}`);
  assert.ok(log.includes('HAPPIER_WITH_DAEMON=0'), `expected remote installer to skip auto-service install\n${log}`);
  assert.ok(log.includes('auth request'), `expected remote auth request\n${log}`);
  assert.ok(log.includes('auth wait'), `expected remote auth wait\n${log}`);
  assert.ok(log.includes('"bin":"happier"'), `expected local happier invocation\n${log}`);
  assert.ok(log.includes('auth","approve'), `expected local auth approve invocation\n${log}`);
  assert.ok(log.includes('--server-url=https://example.invalid'), `expected server-url passed to local approve\n${log}`);
  assert.ok(log.includes('daemon service install'), `expected service install on remote\n${log}`);
  assert.ok(log.includes('daemon service start'), `expected service start on remote\n${log}`);
});

test('hstack remote daemon setup --service none skips service install/start', (t) => {
  const h = createRemoteDaemonSetupHarness(t, { prefix: 'hstack-remote-daemon-none-' });
  const res = h.runRemoteCommand(['daemon', 'setup', '--ssh', 'dev@host', '--service', 'none', '--json']);
  assert.equal(res.status, 0, res.stderr);

  const log = h.readInvocationsLog();
  assert.ok(log.includes('auth request'), `expected remote auth request\n${log}`);
  assert.ok(!log.includes('daemon service install'), `expected no service install\n${log}`);
  assert.ok(!log.includes('daemon service start'), `expected no service start\n${log}`);
});

