import test from 'node:test';
import assert from 'node:assert/strict';

import { runRemoteDaemonSetupWithDeps, runRemoteServerSetupWithDeps } from './remote_cmd.mjs';

test('remote daemon setup delegates to happier machine setup with relay targeting and user service defaults', async () => {
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
    'setup',
    '--ssh',
    'dev@example.test',
    '--service-mode=user',
    '--ssh-config-file=/tmp/lima-ssh.config',
    '--server-url=https://relay.example.test',
    '--webapp-url=https://app.example.test',
    '--json',
  ]);
});

test('remote daemon setup forwards service none and release channel flags to happier machine setup', async () => {
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
    'setup',
    '--ssh',
    'dev@example.test',
    '--channel=preview',
    '--service-mode=none',
    '--ssh-config-file=/tmp/lima-ssh.config',
  ]);
});

test('remote daemon setup forwards --yes to happier machine setup for non-interactive prompts', async () => {
  const invocations = [];

  await runRemoteDaemonSetupWithDeps(
    ['daemon', 'setup', '--ssh', 'dev@example.test', '--yes', '--json'],
    {
      runLocalMachineBootstrap: async (params) => {
        invocations.push(params);
      },
    },
  );

  assert.equal(invocations.length, 1);
  assert.deepEqual(invocations[0].args, [
    'machine',
    'setup',
    '--ssh',
    'dev@example.test',
    '--service-mode=user',
    '--yes',
    '--json',
  ]);
});

test('remote daemon setup rejects --known-hosts-path when daemon setup does not forward it', async () => {
  await assert.rejects(
    runRemoteDaemonSetupWithDeps(
      ['daemon', 'setup', '--ssh', 'dev@example.test', '--known-hosts-path', '/tmp/lima-known_hosts'],
      {
        runLocalMachineBootstrap: async () => {},
      },
    ),
    /known-hosts-path/i,
  );
});

test('remote server setup forwards ssh trust flags to happier relay host install', async () => {
  const invocations = [];

  await runRemoteServerSetupWithDeps(
    [
      'server',
      'setup',
      '--ssh',
      'dev@example.test',
      '--ssh-config-file',
      '/tmp/lima-ssh.config',
      '--known-hosts-path',
      '/tmp/lima-known_hosts',
      '--mode',
      'system',
      '--server-binary',
      '/tmp/happier-server',
      '--env',
      'HAPPIER_DB_PROVIDER=postgres',
      '--json',
    ],
    {
      runRelayHostInstall: async (params) => {
        invocations.push(params);
      },
    },
  );

  assert.equal(invocations.length, 1);
  assert.deepEqual(invocations[0].args, [
    'relay',
    'host',
    'install',
    '--ssh',
    'dev@example.test',
    '--channel=stable',
    '--mode=system',
    '--ssh-config-file=/tmp/lima-ssh.config',
    '--known-hosts-path=/tmp/lima-known_hosts',
    '--server-binary',
    '/tmp/happier-server',
    '--env',
    'HAPPIER_DB_PROVIDER=postgres',
    '--json',
  ]);
});
