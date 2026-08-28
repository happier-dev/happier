import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRemoteBootstrapCommand,
  buildRemoteDoctorCommand,
  buildRemoteEnsureDirectoriesCommand,
  buildRemoteStackCommand,
  buildRemoteStackStopCommand,
  buildSshForwardArgs,
  buildSshWorkerArgs,
  resolveRemoteServerRuntimeConfig,
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

test('Windows directory bootstrap retires only Mutagen agents whose SSH owner is gone', () => {
  const command = buildRemoteEnsureDirectoriesCommand(windows);
  const decodedPowerShell = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');

  assert.match(decodedPowerShell, /\$ProgressPreference = 'SilentlyContinue'/);
  assert.match(decodedPowerShell, /Name = 'mutagen-agent\.exe'/);
  assert.match(decodedPowerShell, /SilentlyContinue\);\s+foreach \(\$agent/);
  assert.match(decodedPowerShell, /Get-Process -Id \$sshParentPid/);
  assert.match(decodedPowerShell, /taskkill\.exe \/PID .* \/T \/F/);
  assert.match(
    decodedPowerShell,
    /if \(-not \(Get-Process -Id \$sshParentPid.*\)\).*taskkill\.exe/s,
    'an active SSH parent must prevent cleanup of its Mutagen agent tree',
  );
  assert.match(decodedPowerShell, /New-Item -ItemType Directory -Force/);
});

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
  const command = buildRemoteStackCommand(posix, {
    services: { server: false, daemon: true },
    serverUrl: 'http://127.0.0.1:43005',
    publicServerUrl: 'http://127.0.0.1:3005',
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
  assert.match(command, /export HAPPIER_STACK_CLI_ROOT_DISABLE=1;.*corepack yarn workspace/s);
  assert.match(command, /HAPPIER_STACK_PM_CACHE_BASE_DIR=.*HOME.*\/\.cache/);
  assert.match(command, /HAPPIER_STACK_STACK/);
  assert.match(command, /HAPPIER_ACTIVE_SERVER_ID/);
  assert.match(command, /HAPPIER_CLI_PKGROLL_TIMEOUT_MS=1800000/);
  assert.match(command, /http:\/\/127\.0\.0\.1:43005/);
  assert.doesNotMatch(command, /stack stop/);
  assert.doesNotMatch(command, /corepack yarn dev /);

  const windowsCommand = buildRemoteStackCommand(windows, {
    services: { server: false, daemon: true },
    serverUrl: 'http://127.0.0.1:43105',
    publicServerUrl: 'http://127.0.0.1:3005',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
  });
  const decodedPowerShell = Buffer.from(windowsCommand.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(decodedPowerShell, /\$env:HAPPIER_STACK_CLI_HOME_DIR/);
  assert.match(decodedPowerShell, /\$env:HAPPIER_STACK_CLI_ROOT_DISABLE = '1';.*corepack yarn workspace/s);
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
  assert.doesNotMatch(decodedPowerShell, /stack stop/);
  assert.doesNotMatch(decodedPowerShell, /--restart/);
  assert.match(decodedPowerShell, /stack-state\/repo-local-dev/);
});

test('attended dev-target Stack preserves attended server readiness on the target', () => {
  const command = buildRemoteStackCommand(posix, {
    services: { server: false, daemon: true },
    serverUrl: 'http://127.0.0.1:43005',
    publicServerUrl: 'http://127.0.0.1:3005',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
    attended: true,
  });

  assert.match(command, /export HAPPIER_STACK_TUI=1/);
});

test('remote server command pins stable public URL and exact target-local SQLite semantics', () => {
  const runtimeConfig = resolveRemoteServerRuntimeConfig({
    serverComponentName: 'happier-server-light',
    env: {
      HAPPIER_DB_PROVIDER: 'sqlite',
      HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
      HAPPIER_SQLITE_CONNECTION_LIMIT: '1',
      HAPPIER_SERVER_RETENTION__ENABLED: '1',
      HAPPIER_SERVER_RETENTION__INTERVAL_MS: '3600000',
      HAPPIER_SERVER_RETENTION__SESSION_SIDECHAIN_MESSAGES__MODE: 'delete_older_than',
      HAPPIER_SERVER_RETENTION__SESSION_SIDECHAIN_MESSAGES__DAYS: '7',
      HAPPIER_SERVER_LIGHT_DATA_DIR: '/guest/data-must-not-leak',
      DATABASE_URL: 'file:/guest/data-must-not-leak/db.sqlite',
    },
  });
  const options = {
    services: { server: true, daemon: true },
    serverUrl: 'http://127.0.0.1:43005',
    publicServerUrl: 'http://127.0.0.1:52753',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
    remoteServerPort: 43005,
    remoteServerRuntimeConfig: runtimeConfig,
  };
  const command = buildRemoteStackCommand(posix, options);
  const stopCommand = buildRemoteStackStopCommand(posix, options);

  assert.match(command, /HAPPIER_DB_PROVIDER=sqlite/);
  assert.match(command, /HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY=optional/);
  assert.match(command, /HAPPIER_SQLITE_CONNECTION_LIMIT=1/);
  assert.match(command, /HAPPIER_SERVER_RETENTION__ENABLED=1/);
  assert.match(command, /HAPPIER_STACK_SERVER_PORT=43005/);
  assert.match(command, /HAPPIER_SERVER_RETENTION__SESSION_SIDECHAIN_MESSAGES__DAYS=7/);
  assert.match(command, /--server-public-url=.*127\.0\.0\.1:52753/);
  assert.match(command, /--no-proxy/);
  assert.doesNotMatch(command, /--no-server|--no-daemon/);
  assert.doesNotMatch(command, /guest\/data-must-not-leak|DATABASE_URL/);
  assert.match(stopCommand, /stack stop .*repo-local-dev.* --yes --no-docker --preserve-daemon/);
  assert.match(stopCommand, /export HAPPIER_STACK_CLI_ROOT_DISABLE=1/);
  assert.doesNotMatch(stopCommand, /stack dev/);
});

test('remote Stack command projects target-owned Expo through the guest Metro endpoint', () => {
  const command = buildRemoteStackCommand(posix, {
    services: { server: true, expo: true, daemon: false },
    serverUrl: 'http://127.0.0.1:43005',
    publicServerUrl: 'http://192.168.1.20:52753',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
    remoteServerPort: 43005,
    remoteExpoPort: 48081,
    expoPublicUrl: 'http://192.168.1.20:18081',
    startMobile: true,
    remoteServerRuntimeConfig: {
      serverComponentName: 'happier-server-light',
      dbProvider: 'sqlite',
      environment: {
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_SQLITE_CONNECTION_LIMIT: '1',
      },
    },
  });

  assert.match(command, /HAPPIER_STACK_EXPO_DEV_PORT=48081/);
  assert.match(command, /HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY=stable/);
  assert.match(command, /HAPPIER_STACK_EXPO_HOST=localhost/);
  assert.match(command, /EXPO_PACKAGER_PROXY_URL=http:\/\/192\.168\.1\.20:18081/);
  assert.match(command, /--mobile/);
  assert.doesNotMatch(command, /--no-server|--no-ui/);
  assert.match(command, /--no-daemon/);
});

test('remote target resolves automatically detected mobile public addresses at its own startup', () => {
  const command = buildRemoteStackCommand(posix, {
    services: { server: true, expo: true, daemon: false },
    serverUrl: 'http://127.0.0.1:52753',
    // The guest's old LAN address must not be injected into the Mac target.
    publicServerUrl: 'http://192.168.5.15:52753',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
    remoteServerPort: 52753,
    remoteExpoPort: 18829,
    expoPublicUrl: 'http://192.168.5.15:18829',
    startMobile: true,
    resolveServerPublicUrlOnTarget: true,
    resolveExpoPublicUrlOnTarget: true,
    remoteServerRuntimeConfig: {
      serverComponentName: 'happier-server-light',
      dbProvider: 'sqlite',
      environment: {
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_SQLITE_CONNECTION_LIMIT: '1',
      },
    },
  });

  assert.match(command, /--mobile/);
  assert.match(command, /HAPPIER_STACK_EXPO_HOST=localhost/);
  assert.doesNotMatch(command, /EXPO_PACKAGER_PROXY_URL=/);
  assert.doesNotMatch(command, /--server-public-url=/);
  assert.doesNotMatch(command, /192\.168\.5\.15/);
});

test('co-located remote server waits for deferred daemon credentials without creating another worker', () => {
  const options = {
    services: { server: true, expo: true, daemon: true },
    serverUrl: 'http://127.0.0.1:43005',
    publicServerUrl: 'http://192.168.1.20:52753',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
    remoteServerPort: 43005,
    remoteExpoPort: 48081,
    remoteServerRuntimeConfig: {
      serverComponentName: 'happier-server-light',
      dbProvider: 'sqlite',
      environment: {
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_SQLITE_CONNECTION_LIMIT: '1',
      },
    },
    deferDaemonStartUntilCredentials: true,
  };

  const command = buildRemoteStackCommand(posix, options);
  assert.match(command, /HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH=1/);
  assert.match(command, /stack dev .*repo-local-dev/);

  const ordinaryCommand = buildRemoteStackCommand(posix, {
    ...options,
    deferDaemonStartUntilCredentials: false,
  });
  assert.doesNotMatch(ordinaryCommand, /HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH/);

  const windowsCommand = buildRemoteStackCommand(windows, options);
  const decodedWindowsCommand = Buffer.from(windowsCommand.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(decodedWindowsCommand, /HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH=1/);
});

test('remote server runtime configuration rejects semantics that could diverge from the retained SQLite database', () => {
  assert.throws(
    () => resolveRemoteServerRuntimeConfig({
      serverComponentName: 'happier-server-light',
      env: {
        HAPPIER_DB_PROVIDER: 'sqlite',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'required_e2ee',
        HAPPIER_SQLITE_CONNECTION_LIMIT: '1',
      },
    }),
    /encryption storage policy must be optional/i,
  );
  assert.throws(
    () => resolveRemoteServerRuntimeConfig({
      serverComponentName: 'happier-server-light',
      env: {
        HAPPIER_DB_PROVIDER: 'sqlite',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_SQLITE_CONNECTION_LIMIT: '2',
      },
    }),
    /SQLite connection limit must be 1/i,
  );
});

test('SSH tunnel owns the reverse forward independently from the monitored worker command', () => {
  assert.deepEqual(
    buildSshForwardArgs(posix, {
      forwards: [{
        direction: 'reverse',
        listenHost: '127.0.0.1',
        listenPort: 43005,
        targetHost: '127.0.0.1',
        targetPort: 3005,
      }],
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
      '-R',
      '127.0.0.1:43005:127.0.0.1:3005',
      '-N',
      'happier-stack-linux',
    ],
  );

  assert.deepEqual(
    buildSshForwardArgs(posix, {
      forwards: [{
        direction: 'local',
        listenHost: '127.0.0.1',
        listenPort: 52753,
        targetHost: '127.0.0.1',
        targetPort: 43005,
      }],
    }).slice(-4),
    ['-L', '127.0.0.1:52753:127.0.0.1:43005', '-N', 'happier-stack-linux'],
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
