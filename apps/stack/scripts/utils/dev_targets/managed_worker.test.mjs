import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  provisionManagedLimaDevTarget,
  reconcileManagedLimaDevTargetSshPublication,
} from './managed_worker.mjs';

test('managed worker enrollment provisions the outer Mac and canonical Lima guest before publishing strict guest SSH', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-managed-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keyDir = join(root, 'dev-target-ssh', 'worker-host');
  const privateKeyPath = join(keyDir, 'id_ed25519');
  const publicKeyPath = `${privateKeyPath}.pub`;
  const guestKnownHostsPath = join(root, 'dev-target-ssh', 'worker', 'guest-known-hosts');
  await mkdir(keyDir, { recursive: true });
  await mkdir(join(root, 'dev-target-ssh', 'worker'), { recursive: true });
  await writeFile(privateKeyPath, 'private-key');
  await writeFile(publicKeyPath, 'ssh-ed25519 AAAATEST controller');
  await writeFile(guestKnownHostsPath, 'happier-dev-target-worker ssh-ed25519 AAAASTALE stale\n');
  const calls = [];
  let guestConfigModes = [];

  const target = await provisionManagedLimaDevTarget({
    name: 'worker',
    host: 'mac.example.test',
    user: 'dev',
    stackBaseDir: root,
    instance: 'happier-worker',
    profile: 'worker-balanced',
    env: {},
  }, {
    provisionOuterHost: async (options) => {
      calls.push(['outer', options.requireToolchain]);
      return {
        ssh: 'happier-dev-target-worker-host',
        sshConfigFile: join(root, 'outer.conf'),
        remoteHome: '/Users/dev',
        remotePath: ['/opt/homebrew/bin', '/usr/bin', '/bin'],
        controllerKey: { privateKeyPath, publicKeyPath },
      };
    },
    createHostExecutor: (hostConfig, _boundary, _env, options) => {
      calls.push(['host-executor', hostConfig, options]);
      return ({
      capture: async (command, args) => {
        calls.push(['host-capture', command, ...args]);
        if (command === 'uname' && args[0] === '-m') {
          return { exitCode: 0, out: 'arm64\n', err: '' };
        }
        return { exitCode: 0, out: '', err: '' };
      },
      run: async (command, args) => {
        calls.push(['host-run', command, ...args]);
        return { exitCode: 0 };
      },
      });
    },
    setupRuntime: async ({
      instance,
      profileName,
      architecture,
      allowInstall,
      guestProvisionProfile,
      guestProvisionScriptSource,
      guestPressureScriptSource,
    }) => {
      calls.push([
        'runtime',
        instance,
        profileName,
        architecture,
        allowInstall,
        guestProvisionProfile,
        guestProvisionScriptSource,
        guestPressureScriptSource,
      ]);
      return { reconfigured: true, guest: { user: 'dev', homeDir: '/home/dev' } };
    },
    getRuntimeStatus: async () => ({
      exists: true,
      status: 'Running',
      instance: { sshAddress: '127.0.0.1', sshLocalPort: 54321 },
    }),
    runSshProbe: async ({ configPath }) => {
      const config = await readFile(configPath, 'utf8');
      const strictHostKeyChecking = config.match(/StrictHostKeyChecking (\S+)/)?.[1];
      guestConfigModes.push(strictHostKeyChecking);
      const knownHosts = await readFile(guestKnownHostsPath, 'utf8').catch(() => '');
      if (strictHostKeyChecking === 'yes' && !knownHosts.includes('AAAACURRENT')) {
        return {
          ok: false,
          exitCode: 255,
          out: '',
          err: 'REMOTE HOST IDENTIFICATION HAS CHANGED',
        };
      }
      if (strictHostKeyChecking === 'accept-new') {
        if (knownHosts.includes('AAAASTALE')) {
          return {
            ok: false,
            exitCode: 255,
            out: '',
            err: 'REMOTE HOST IDENTIFICATION HAS CHANGED',
          };
        }
        await writeFile(guestKnownHostsPath, 'happier-dev-target-worker ssh-ed25519 AAAACURRENT current\n');
      }
      return { ok: true, exitCode: 0, out: '', err: '' };
    },
    guestProvisionScriptSource: '#!/bin/sh\n',
    guestPressureScriptSource: '#!/bin/sh\n# pressure\n',
  });

  assert.deepEqual(calls[0], ['outer', false]);
  assert.deepEqual(calls.find(([kind]) => kind === 'runtime'), [
    'runtime', 'happier-worker', 'worker-balanced', 'aarch64', true, 'happier',
    '#!/bin/sh\n', '#!/bin/sh\n# pressure\n',
  ]);
  const keyInstall = calls.find(([kind, command]) => kind === 'host-capture' && command === 'limactl');
  assert.ok(keyInstall);
  assert.ok(keyInstall.includes('ssh-ed25519 AAAATEST controller'));
  assert.deepEqual(guestConfigModes, ['yes', 'accept-new', 'yes']);
  assert.match(await readFile(guestKnownHostsPath, 'utf8'), /AAAACURRENT/);
  assert.equal(target.ssh, 'happier-dev-target-worker');
  assert.equal(target.repoDir, '/home/dev/happier-dev');
  assert.equal(target.cliHomeDir, '/home/dev/.happier/dev-targets/worker');
  assert.deepEqual(target.managedRuntime, {
    kind: 'lima',
    host: {
      kind: 'ssh',
      ssh: 'happier-dev-target-worker-host',
      sshConfigFile: join(root, 'outer.conf'),
      remotePath: ['/opt/homebrew/bin', '/usr/bin', '/bin'],
    },
    instance: 'happier-worker',
    limaHome: '/Users/dev/.happier/lima',
    profile: 'worker-balanced',
    architecture: 'aarch64',
  });
  assert.deepEqual(calls.find(([kind]) => kind === 'host-executor')?.[2], {
    hostEnvironment: {
      LIMA_HOME: '/Users/dev/.happier/lima',
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
    },
  });
  const guestConfig = await readFile(target.sshConfigFile, 'utf8');
  assert.match(guestConfig, /HostName 127\.0\.0\.1/);
  assert.match(guestConfig, /HostKeyAlias happier-dev-target-worker/);
  assert.match(guestConfig, /Port 54321/);
  assert.match(guestConfig, /IdentityFile .*id_ed25519/);
  assert.match(guestConfig, /ProxyCommand ssh -T -F .*outer\.conf"? happier-dev-target-worker-host -W %h:%p/);
  assert.match(guestConfig, /ForwardAgent no/);
  assert.match(guestConfig, /ControlMaster auto/);
  assert.match(guestConfig, /ControlPersist 600/);
  assert.match(guestConfig, /ControlPath "~\/\.ssh\/happier-managed-%C"/);
  assert.match(guestConfig, /ServerAliveInterval 30/);
  assert.match(guestConfig, /ServerAliveCountMax 6/);
  assert.match(guestConfig, /StrictHostKeyChecking yes/);
});

test('managed worker can reuse an existing outer Dev Target connection without enrolling a competing host identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-managed-worker-existing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keyDir = join(root, 'dev-target-ssh', 'mac');
  const privateKeyPath = join(keyDir, 'id_ed25519');
  const publicKeyPath = `${privateKeyPath}.pub`;
  await mkdir(keyDir, { recursive: true });
  await writeFile(privateKeyPath, 'private-key');
  await writeFile(publicKeyPath, 'ssh-ed25519 AAAAEXISTING controller');
  const outerTarget = {
    name: 'mac',
    platform: 'posix',
    ssh: 'happier-dev-target-mac',
    sshConfigFile: join(keyDir, 'ssh.config'),
    repoDir: '/Users/dev/happier-dev',
    cliHomeDir: '/Users/dev/.happier/dev-targets/mac',
  };
  let provisionedOuter = false;
  let inspectedOuter = false;

  const target = await provisionManagedLimaDevTarget({
    name: 'worker',
    outerTarget,
    stackBaseDir: root,
    instance: 'happier-worker',
    env: {},
  }, {
    provisionOuterHost: async () => {
      provisionedOuter = true;
      throw new Error('must not enroll another outer host');
    },
    inspectOuterHost: async ({ target: inspected }) => {
      inspectedOuter = inspected === outerTarget;
      return {
        ...outerTarget,
        remoteHome: '/Users/dev',
        remotePath: ['/opt/homebrew/bin', '/usr/bin', '/bin'],
        controllerKey: { privateKeyPath, publicKeyPath },
      };
    },
    createHostExecutor: () => ({
      capture: async (command, args) => (
        command === 'uname' && args[0] === '-m'
          ? { exitCode: 0, out: 'x86_64\n', err: '' }
          : { exitCode: 0, out: '', err: '' }
      ),
      run: async () => ({ exitCode: 0 }),
    }),
    setupRuntime: async () => ({ guest: { user: 'dev', homeDir: '/home/dev' } }),
    getRuntimeStatus: async () => ({
      exists: true,
      status: 'Running',
      instance: { sshLocalPort: 54321 },
    }),
    runSshProbe: async () => ({ ok: true, exitCode: 0, out: '', err: '' }),
    guestProvisionScriptSource: '#!/bin/sh\n',
  });

  assert.equal(inspectedOuter, true);
  assert.equal(provisionedOuter, false);
  assert.equal(target.managedRuntime.host.ssh, 'happier-dev-target-mac');
  assert.equal(target.managedRuntime.host.sshConfigFile, outerTarget.sshConfigFile);
  assert.equal(target.managedRuntime.architecture, 'x86_64');
});

test('managed worker SSH publication follows a changed Lima port and migrates to a port-independent host identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-managed-worker-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'guest.ssh.config');
  await writeFile(configPath, [
    'Host happier-dev-target-worker',
    '  HostName 127.0.0.1',
    '  Port 54321',
    '  User lima',
    `  UserKnownHostsFile "${join(root, 'known-hosts')}"`,
    '  StrictHostKeyChecking yes',
    '',
  ].join('\n'));
  const modes = [];

  const result = await reconcileManagedLimaDevTargetSshPublication({
    target: {
      name: 'worker',
      ssh: 'happier-dev-target-worker',
      sshConfigFile: configPath,
      managedRuntime: { kind: 'lima' },
    },
    sshLocalPort: 60955,
    guestVerified: true,
    env: {},
  }, {
    runSshProbe: async ({ configPath: probedPath }) => {
      const contents = await readFile(probedPath, 'utf8');
      const strictHostKeyChecking = contents.match(/StrictHostKeyChecking (\S+)/)?.[1];
      modes.push(strictHostKeyChecking);
      if (strictHostKeyChecking === 'yes' && modes.length === 1) {
        return {
          ok: false,
          exitCode: 255,
          out: '',
          err: 'No ED25519 host key is known for happier-dev-target-worker and you have requested strict checking.',
        };
      }
      return { ok: true, exitCode: 0, out: '', err: '' };
    },
  });

  assert.deepEqual(result, { changed: true, port: 60955, hostKeyAliasAdded: true });
  assert.deepEqual(modes, ['yes', 'accept-new', 'yes']);
  const contents = await readFile(configPath, 'utf8');
  assert.match(contents, /Port 60955/);
  assert.match(contents, /HostKeyAlias happier-dev-target-worker/);
  assert.match(contents, /StrictHostKeyChecking yes/);
});
