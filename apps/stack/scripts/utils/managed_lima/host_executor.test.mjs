import assert from 'node:assert/strict';
import test from 'node:test';

import { createManagedLimaHostExecutor } from './host_executor.mjs';

test('managed Lima local executor preserves argv without a shell', async () => {
  const calls = [];
  const executor = createManagedLimaHostExecutor(
    { kind: 'local' },
    { runCapture: async (call) => { calls.push(call); return { exitCode: 0, out: '', err: '' }; } },
  );

  await executor.capture('limactl', ['list', 'instance with spaces']);

  assert.deepEqual(calls, [{ command: 'limactl', args: ['list', 'instance with spaces'], env: process.env }]);
});

test('managed Lima remote executor uses the enrolled outer-host SSH config and quotes argv once', async () => {
  const calls = [];
  const executor = createManagedLimaHostExecutor(
    { kind: 'ssh', ssh: 'happier-worker-host', sshConfigFile: '/private/host ssh.config' },
    { runCapture: async (call) => { calls.push(call); return { exitCode: 0, out: '', err: '' }; } },
  );

  await executor.capture('limactl', ['start', "worker's-vm"]);

  assert.deepEqual(calls, [{
    command: 'ssh',
    args: [
      '-T', '-F', '/private/host ssh.config', 'happier-worker-host',
      `'limactl' 'start' 'worker'"'"'s-vm'`,
    ],
    env: process.env,
  }]);
});

test('managed Lima executor applies Lima home on the owning host without leaking unrelated controller environment', async () => {
  const calls = [];
  const executor = createManagedLimaHostExecutor(
    { kind: 'ssh', ssh: 'happier-worker-host', sshConfigFile: '/private/host.ssh.config' },
    { runCapture: async (call) => { calls.push(call); return { exitCode: 0, out: '', err: '' }; } },
    process.env,
    { hostEnvironment: { LIMA_HOME: '/Users/worker/.happier-stack/lima' } },
  );

  await executor.capture('limactl', ['list']);

  assert.equal(
    calls[0].args.at(-1),
    `'env' 'LIMA_HOME=/Users/worker/.happier-stack/lima' 'limactl' 'list'`,
  );
});

test('managed Lima executor streams provisioning input through local and remote hosts without shell reinterpretation', async () => {
  const localCalls = [];
  const local = createManagedLimaHostExecutor(
    { kind: 'local' },
    { runCapture: async (call) => { localCalls.push(call); return { exitCode: 0, out: '', err: '' }; } },
  );
  await local.capture('limactl', ['shell', 'worker', '--', 'bash', '-s'], { input: '#!/bin/bash\necho ok\n' });

  const remoteCalls = [];
  const remote = createManagedLimaHostExecutor(
    { kind: 'ssh', ssh: 'outer-host', sshConfigFile: '/private/outer.conf' },
    { runCapture: async (call) => { remoteCalls.push(call); return { exitCode: 0, out: '', err: '' }; } },
  );
  await remote.capture('limactl', ['shell', 'worker', '--', 'bash', '-s'], { input: '#!/bin/bash\necho ok\n' });

  assert.equal(localCalls[0].input, '#!/bin/bash\necho ok\n');
  assert.equal(remoteCalls[0].input, '#!/bin/bash\necho ok\n');
  assert.equal(remoteCalls[0].command, 'ssh');
  assert.match(remoteCalls[0].args.at(-1), /'limactl' 'shell' 'worker' '--' 'bash' '-s'/);
});
