import test from 'node:test';
import assert from 'node:assert/strict';

import { runRemoteDaemonSetupWithDeps } from './remote_cmd.mjs';

test('remote daemon setup delegates to happier machine bootstrap with relay targeting and user service defaults', async () => {
  const invocations = [];

  await runRemoteDaemonSetupWithDeps(
    ['daemon', 'setup', '--ssh', 'dev@example.test', '--ssh-config-file', '/tmp/lima-ssh.config', '--server-url', 'https://relay.example.test', '--webapp-url', 'https://app.example.test', '--json'],
    {
      runLocalMachineBootstrap: async (params) => {
        invocations.push(params);
      },
    },
  );

  assert.equal(invocations.length, 1);
  assert.deepEqual(invocations[0].args, [
    'machine',
    'bootstrap',
    '--ssh',
    'dev@example.test',
    '--service-mode=user',
    '--ssh-config-file=/tmp/lima-ssh.config',
    '--server-url=https://relay.example.test',
    '--webapp-url=https://app.example.test',
    '--json',
  ]);
});

test('remote daemon setup forwards service none and release channel flags to happier machine bootstrap', async () => {
  const invocations = [];

  await runRemoteDaemonSetupWithDeps(
    ['daemon', 'setup', '--ssh', 'dev@example.test', '--ssh-config-file=/tmp/lima-ssh.config', '--service', 'none', '--preview'],
    {
      runLocalMachineBootstrap: async (params) => {
        invocations.push(params);
      },
    },
  );

  assert.equal(invocations.length, 1);
  assert.deepEqual(invocations[0].args, [
    'machine',
    'bootstrap',
    '--ssh',
    'dev@example.test',
    '--channel=preview',
    '--service-mode=none',
    '--ssh-config-file=/tmp/lima-ssh.config',
  ]);
});
