import test from 'node:test';
import assert from 'node:assert/strict';

import { createRemoteDaemonSetupHarness } from './testkit/remote_daemon_setup_testkit.mjs';

test('hstack remote daemon setup requires --ssh', (t) => {
  const h = createRemoteDaemonSetupHarness(t, { prefix: 'hstack-remote-daemon-missing-ssh-' });
  const res = h.runRemoteCommand(['daemon', 'setup', '--json']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr ?? '', /Missing required flag: --ssh/i);
});

test('hstack remote daemon setup delegates to happier machine setup with relay targeting', (t) => {
  const h = createRemoteDaemonSetupHarness(t, { prefix: 'hstack-remote-daemon-user-' });
  const res = h.runRemoteCommand([
    'daemon',
    'setup',
    '--ssh',
    'dev@host',
    '--preview',
    '--server-url=https://example.invalid',
    '--public-server-url=https://public.example.invalid',
    '--json',
  ]);
  assert.equal(res.status, 0, res.stderr);

  const log = h.readInvocationsLog();
  assert.ok(log.includes('"bin":"happier"'), `expected local happier invocation\n${log}`);
  assert.ok(log.includes('"machine","setup"'), `expected machine setup delegation\n${log}`);
  assert.ok(log.includes('--server-url=https://example.invalid'), `expected server-url passed to local happier invocation\n${log}`);
  assert.ok(log.includes('--public-server-url=https://public.example.invalid'), `expected public-server-url passed to local happier invocation\n${log}`);
  assert.ok(!log.includes('"bin":"ssh"'), `expected no direct ssh orchestration in remote wrapper\n${log}`);
});

test('hstack remote daemon setup forwards ssh config file and service mode to happier machine setup', (t) => {
  const h = createRemoteDaemonSetupHarness(t, { prefix: 'hstack-remote-daemon-none-' });
  const res = h.runRemoteCommand([
    'daemon',
    'setup',
    '--ssh',
    'dev@host',
    '--service',
    'none',
    '--ssh-config-file',
    '/tmp/lima-ssh.config',
    '--json',
  ]);
  assert.equal(res.status, 0, res.stderr);

  const log = h.readInvocationsLog();
  assert.ok(log.includes('"bin":"happier"'), `expected local happier invocation\n${log}`);
  assert.ok(log.includes('--service-mode=none'), `expected service none delegation\n${log}`);
  assert.ok(log.includes('--ssh-config-file=/tmp/lima-ssh.config'), `expected ssh config delegation\n${log}`);
});
