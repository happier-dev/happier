import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { provisionPosixDevTarget } from './provision.mjs';

test('POSIX provisioning creates a dedicated key, installs it when needed, and discovers remote paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dev-target-provision-'));
  const calls = [];
  let keyAuthorized = false;
  let configuredHostKeyPinned = false;
  const configuredSshModes = [];
  try {
    const target = await provisionPosixDevTarget(
      {
        name: 'mac',
        host: '100.98.30.76',
        user: 'leeroy',
        stackBaseDir: root,
        env: { PATH: '/test/bin' },
      },
      {
        runInteractive: async ({ command, args }) => {
          calls.push([command, ...args]);
          if (command === 'ssh-keygen') {
            const keyPath = args[args.indexOf('-f') + 1];
            await writeFile(keyPath, 'private-test-key');
            await writeFile(`${keyPath}.pub`, 'ssh-ed25519 AAAATEST happier-dev-target');
            return;
          }
          if (command === 'ssh-copy-id') {
            keyAuthorized = true;
            return;
          }
          throw new Error(`unexpected interactive command: ${command}`);
        },
        runCaptureResult: async ({ command, args }) => {
          calls.push([command, ...args]);
          const configFlagIndex = args.indexOf('-F');
          if (configFlagIndex >= 0) {
            const sshConfig = await readFile(args[configFlagIndex + 1], 'utf8');
            const strictMode = sshConfig.match(/StrictHostKeyChecking (\S+)/)?.[1];
            configuredSshModes.push(strictMode);
            if (strictMode === 'accept-new') configuredHostKeyPinned = true;
            if (!configuredHostKeyPinned) {
              return {
                ok: false,
                exitCode: 255,
                out: '',
                err: 'No ED25519 host key is known for 100.98.30.76 and you have requested strict checking.',
              };
            }
          }
          if (args.at(-1) === 'true') {
            return keyAuthorized
              ? { ok: true, exitCode: 0, out: '', err: '' }
              : { ok: false, exitCode: 255, out: '', err: 'permission denied' };
          }
          return {
            ok: true,
            exitCode: 0,
            out: [
              '__HAPPIER_UNAME__=Darwin',
              '__HAPPIER_HOME__=/Users/leeroy',
              '__HAPPIER_PATH__=/Users/leeroy/.nvm/versions/node/v22/bin:/opt/homebrew/bin:/usr/bin:/bin',
              '__HAPPIER_NODE__=/Users/leeroy/.nvm/versions/node/v22/bin/node',
              '__HAPPIER_COREPACK__=/Users/leeroy/.nvm/versions/node/v22/bin/corepack',
            ].join('\n'),
            err: '',
          };
        },
      },
    );

    assert.equal(target.platform, 'posix');
    assert.equal(target.ssh, 'happier-dev-target-mac');
    assert.equal(target.repoDir, '/Users/leeroy/happier-dev');
    assert.equal(target.cliHomeDir, '/Users/leeroy/.happier/dev-targets/mac');
    assert.deepEqual(target.remotePath, [
      '/Users/leeroy/.nvm/versions/node/v22/bin',
      '/opt/homebrew/bin',
      '/usr/bin',
      '/bin',
    ]);
    assert.equal(calls.filter((call) => call[0] === 'ssh-keygen').length, 1);
    assert.equal(calls.filter((call) => call[0] === 'ssh-copy-id').length, 1);
    assert.deepEqual(configuredSshModes, ['accept-new', 'accept-new', 'accept-new', 'yes']);
    const copyIdCall = calls.find((call) => call[0] === 'ssh-copy-id');
    assert.deepEqual(copyIdCall?.slice(1, 5), ['-F', target.sshConfigFile, '-o', 'BatchMode=no']);
    assert.equal(copyIdCall?.at(-1), target.ssh);
    assert.equal(existsSync(target.sshConfigFile), true);
    const sshConfig = await readFile(target.sshConfigFile, 'utf8');
    assert.match(sshConfig, /Host happier-dev-target-mac/);
    assert.match(sshConfig, /HostName 100\.98\.30\.76/);
    assert.match(sshConfig, /User leeroy/);
    assert.match(sshConfig, /IdentitiesOnly yes/);
    assert.match(sshConfig, /BatchMode yes/);
    assert.match(sshConfig, /StrictHostKeyChecking yes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POSIX provisioning reuses an authorized dedicated key and honors directory overrides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dev-target-provision-'));
  const keyDir = join(root, 'dev-target-ssh', 'mac');
  const calls = [];
  try {
    const target = await provisionPosixDevTarget(
      {
        name: 'mac',
        host: 'mac.example.test',
        user: 'dev',
        stackBaseDir: root,
        repoDir: '/Volumes/work/happier',
        cliHomeDir: '/Volumes/state/happier',
        env: {},
      },
      {
        pathExists: (path) => path === join(keyDir, 'id_ed25519') || path === join(keyDir, 'id_ed25519.pub'),
        runInteractive: async ({ command }) => {
          calls.push(command);
          throw new Error('existing authorized keys require no interactive command');
        },
        runCaptureResult: async ({ args }) => {
          if (args.at(-1) === 'true') return { ok: true, exitCode: 0, out: '', err: '' };
          return {
            ok: true,
            exitCode: 0,
            out: '__HAPPIER_UNAME__=Linux\n__HAPPIER_HOME__=/home/dev\n__HAPPIER_PATH__=/opt/node/bin:/usr/bin\n__HAPPIER_NODE__=/opt/node/bin/node\n__HAPPIER_COREPACK__=/opt/node/bin/corepack\n',
            err: '',
          };
        },
      },
    );

    assert.equal(target.repoDir, '/Volumes/work/happier');
    assert.equal(target.cliHomeDir, '/Volumes/state/happier');
    assert.deepEqual(calls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POSIX provisioning fails before registration when Node and Corepack are not discoverable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dev-target-provision-'));
  try {
    await assert.rejects(
      () => provisionPosixDevTarget(
        { name: 'mac', host: 'host.test', user: 'dev', stackBaseDir: root, env: {} },
        {
          pathExists: () => true,
          runInteractive: async () => {},
          runCaptureResult: async ({ args }) => (
            args.at(-1) === 'true'
              ? { ok: true, exitCode: 0, out: '', err: '' }
              : {
                  ok: true,
                  exitCode: 0,
                  out: '__HAPPIER_UNAME__=Darwin\n__HAPPIER_HOME__=/Users/dev\n__HAPPIER_PATH__=/usr/bin:/bin\n__HAPPIER_NODE__=\n__HAPPIER_COREPACK__=\n',
                  err: '',
                }
          ),
        },
      ),
      /Node\.js and Corepack/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POSIX provisioning discovers Corepack beside the resolved Node runtime when a version-manager shim omits it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dev-target-provision-'));
  try {
    let discoveryCommand = '';
    const target = await provisionPosixDevTarget(
      { name: 'mac', host: 'host.test', user: 'dev', stackBaseDir: root, env: {} },
      {
        pathExists: () => true,
        runInteractive: async () => {},
        runCaptureResult: async ({ args }) => {
          if (args.at(-1) === 'true') return { ok: true, exitCode: 0, out: '', err: '' };
          discoveryCommand = String(args.at(-1));
          return {
            ok: true,
            exitCode: 0,
            out: [
              '__HAPPIER_UNAME__=Darwin',
              '__HAPPIER_HOME__=/Users/dev',
              '__HAPPIER_PATH__=/Users/dev/.volta/bin:/usr/bin:/bin',
              '__HAPPIER_NODE__=/Users/dev/.volta/bin/node',
              '__HAPPIER_NODE_VERSION__=v22.22.1',
              '__HAPPIER_COREPACK__=/Users/dev/.volta/tools/image/node/22.22.1/bin/corepack',
            ].join('\n'),
            err: '',
          };
        },
      },
    );

    assert.match(discoveryCommand, /process\.execPath/);
    assert.deepEqual(target.remotePath.slice(0, 2), [
      '/Users/dev/.volta/bin',
      '/Users/dev/.volta/tools/image/node/22.22.1/bin',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POSIX provisioning rejects a discovered Node runtime older than the repository major', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dev-target-provision-'));
  try {
    await assert.rejects(
      () => provisionPosixDevTarget(
        { name: 'mac', host: 'host.test', user: 'dev', stackBaseDir: root, env: {} },
        {
          pathExists: () => true,
          runInteractive: async () => {},
          runCaptureResult: async ({ args }) => (
            args.at(-1) === 'true'
              ? { ok: true, exitCode: 0, out: '', err: '' }
              : {
                  ok: true,
                  exitCode: 0,
                  out: [
                    '__HAPPIER_UNAME__=Darwin',
                    '__HAPPIER_HOME__=/Users/dev',
                    '__HAPPIER_PATH__=/opt/node/bin:/usr/bin:/bin',
                    '__HAPPIER_NODE__=/opt/node/bin/node',
                    '__HAPPIER_NODE_VERSION__=v18.15.0',
                    '__HAPPIER_COREPACK__=/opt/node/bin/corepack',
                  ].join('\n'),
                  err: '',
                }
          ),
        },
      ),
      /Node\.js 22 or newer.*v18\.15\.0/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POSIX provisioning leaves strict checking enabled when host-key enrollment fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dev-target-provision-'));
  const keyDir = join(root, 'dev-target-ssh', 'mac');
  const configPath = join(keyDir, 'ssh.config');
  try {
    await assert.rejects(
      () => provisionPosixDevTarget(
        { name: 'mac', host: 'host.test', user: 'dev', stackBaseDir: root, env: {} },
        {
          pathExists: (path) => path === join(keyDir, 'id_ed25519') || path === join(keyDir, 'id_ed25519.pub'),
          runCaptureResult: async () => ({
            ok: false,
            exitCode: 255,
            out: '',
            err: 'REMOTE HOST IDENTIFICATION HAS CHANGED',
          }),
          runInteractive: async () => {
            throw new Error('ssh-copy-id refused the changed host key');
          },
        },
      ),
      /refused the changed host key/i,
    );

    const sshConfig = await readFile(configPath, 'utf8');
    assert.match(sshConfig, /StrictHostKeyChecking yes/);
    assert.doesNotMatch(sshConfig, /StrictHostKeyChecking accept-new/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
