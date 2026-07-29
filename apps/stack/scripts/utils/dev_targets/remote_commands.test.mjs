import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRemoteBootstrapCommand,
  buildRemoteDoctorCommand,
  buildRemoteDaemonCommand,
  buildSshTunnelArgs,
  buildSshWorkerArgs,
} from './remote_commands.mjs';

const posix = {
  name: 'linux',
  platform: 'posix',
  ssh: 'happier-stack-linux',
  repoDir: '/home/dev/Happier repo',
  cliHomeDir: '/home/dev/.happier/dev linux',
  remoteServerPort: null,
};

const windows = {
  name: 'windows',
  platform: 'windows',
  ssh: 'happier-stack-windows',
  repoDir: 'C:/Users/test qa/Happier',
  cliHomeDir: 'C:/Users/test qa/.happier/windows',
  remoteServerPort: 43105,
};

test('remote bootstrap reuses canonical dependency freshness instead of reinstalling on every Stack restart', () => {
  const posixCommand = buildRemoteBootstrapCommand(posix);
  assert.match(posixCommand, /^bash -lc /);
  assert.match(
    posixCommand,
    /corepack yarn node .*apps\/stack\/scripts\/utils\/dev_targets\/remote_dependency_bootstrap\.mjs/,
  );
  assert.match(posixCommand, /HAPPIER_STACK_PM_CACHE_BASE_DIR=.*HOME.*\/\.cache/);
  assert.doesNotMatch(posixCommand, /corepack yarn install --frozen-lockfile/);
  assert.match(posixCommand, /Happier repo/);

  const windowsCommand = buildRemoteBootstrapCommand(windows);
  assert.match(windowsCommand, /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand /);
  assert.doesNotMatch(windowsCommand, /test qa/);
  const decodedPowerShell = Buffer.from(windowsCommand.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(
    decodedPowerShell,
    /corepack yarn node .*apps\/stack\/scripts\/utils\/dev_targets\/remote_dependency_bootstrap\.mjs/,
  );
  assert.match(
    decodedPowerShell,
    /\$env:HAPPIER_STACK_PM_CACHE_BASE_DIR = Join-Path \$env:USERPROFILE '\.cache'/,
  );
  assert.doesNotMatch(decodedPowerShell, /corepack yarn install --frozen-lockfile/);
});

test('remote doctor checks prerequisites without changing the target', () => {
  const posixCommand = buildRemoteDoctorCommand(posix);
  assert.match(posixCommand, /command -v node/);
  assert.match(posixCommand, /command -v corepack/);
  assert.doesNotMatch(posixCommand, /yarn install/);

  const windowsCommand = buildRemoteDoctorCommand(windows);
  const decodedPowerShell = Buffer.from(windowsCommand.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(decodedPowerShell, /Get-Command node/);
  assert.match(decodedPowerShell, /Get-Command corepack/);
  assert.doesNotMatch(decodedPowerShell, /yarn install/);
});

test('remote daemon command reuses the Stack dev owner and adopts a last-green daemon on reconnect', () => {
  const command = buildRemoteDaemonCommand(posix, {
    serverUrl: 'http://127.0.0.1:43005',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
  });
  assert.match(
    command,
    /corepack yarn workspace @happier-dev\/stack stack dev .*repo-local-dev.* --no-server --no-ui --no-browser --no-dev-targets --watch/,
  );
  assert.doesNotMatch(command, /--restart/);
  assert.match(command, /stack-state\/repo-local-dev\/env/);
  assert.match(command, /HAPPIER_HOME_DIR/);
  assert.match(command, /HAPPIER_STACK_CLI_HOME_DIR/);
  assert.match(command, /HAPPIER_STACK_STORAGE_DIR/);
  assert.match(command, /HAPPIER_STACK_PM_CACHE_BASE_DIR=.*HOME.*\/\.cache/);
  assert.match(command, /HAPPIER_STACK_STACK/);
  assert.match(command, /HAPPIER_ACTIVE_SERVER_ID/);
  assert.match(command, /HAPPIER_CLI_PKGROLL_TIMEOUT_MS=1800000/);
  assert.match(command, /http:\/\/127\.0\.0\.1:43005/);
  assert.doesNotMatch(command, /corepack yarn dev /);

  const windowsCommand = buildRemoteDaemonCommand(windows, {
    serverUrl: 'http://127.0.0.1:43105',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
  });
  const decodedPowerShell = Buffer.from(windowsCommand.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(decodedPowerShell, /\$env:HAPPIER_STACK_CLI_HOME_DIR/);
  assert.match(
    decodedPowerShell,
    /\$env:HAPPIER_STACK_PM_CACHE_BASE_DIR = Join-Path \$env:USERPROFILE '\.cache'/,
  );
  assert.match(decodedPowerShell, /\$env:HAPPIER_STACK_STACK = 'repo-local-dev'/);
  assert.match(decodedPowerShell, /HAPPIER_CLI_PKGROLL_TIMEOUT_MS=1800000/);
  assert.match(
    decodedPowerShell,
    /corepack yarn workspace @happier-dev\/stack stack dev 'repo-local-dev' --no-server --no-ui --no-browser --no-dev-targets --watch/,
  );
  assert.doesNotMatch(decodedPowerShell, /--restart/);
  assert.match(decodedPowerShell, /stack-state\/repo-local-dev/);
});

test('SSH tunnel owns the reverse forward independently from the monitored worker command', () => {
  assert.deepEqual(
    buildSshTunnelArgs(posix, {
      localServerPort: 3005,
      remoteServerPort: 43005,
    }),
    [
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-N',
      '-R',
      '127.0.0.1:43005:127.0.0.1:3005',
      'happier-stack-linux',
    ],
  );

  assert.deepEqual(
    buildSshWorkerArgs(posix, {
      remoteCommand: 'bash -lc true',
    }),
    [
      '-tt',
      '-o',
      'BatchMode=yes',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      'happier-stack-linux',
      'bash -lc true',
    ],
  );

  const windowsArgs = buildSshWorkerArgs(windows, {
    remoteCommand: 'powershell.exe -EncodedCommand example',
  });
  assert.equal(windowsArgs[0], '-T');
  assert.equal(windowsArgs.includes('-tt'), false);
});
