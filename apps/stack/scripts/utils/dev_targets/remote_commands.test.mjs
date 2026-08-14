import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  buildRemoteCancelCommand,
  buildRemoteExecCommand,
  buildRemoteDoctorCommand,
  buildRemoteLoadProbeCommand,
  buildRemoteDaemonCommand,
  buildRemoteDaemonReadinessProbeCommand,
  buildRemoteStackStopCommand,
  buildRemoteStackCommand,
  buildRemoteEnsureDirectoriesCommand,
  buildSshForwardArgs,
  buildSshTunnelArgs,
  buildSshWorkerArgs,
} from './remote_commands.mjs';

const executionId = '018f0f52-5fe8-7a9f-8ef5-f81f20572791';

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

const execFileAsync = promisify(execFile);

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

test('remote doctor checks prerequisites without changing the target', () => {
  const posixCommand = buildRemoteDoctorCommand({
    ...posix,
    remotePath: ['/Users/dev/.nvm/versions/node/v22/bin', '/opt/homebrew/bin'],
  });
  assert.match(posixCommand, /export PATH=.*nvm.*homebrew.*PATH/);
  assert.match(posixCommand, /command -v node/);
  assert.match(posixCommand, /command -v corepack/);
  assert.doesNotMatch(posixCommand, /yarn install/);

  const windowsCommand = buildRemoteDoctorCommand({
    ...windows,
    remotePath: ['C:/Users/test qa/node', 'C:/Program Files/ripgrep'],
  });
  const decodedPowerShell = Buffer.from(windowsCommand.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(decodedPowerShell, /\$env:PATH = .*node.*ripgrep.*PathSeparator.*\$env:PATH/);
  assert.match(decodedPowerShell, /Get-Command node/);
  assert.match(decodedPowerShell, /Get-Command corepack/);
  assert.doesNotMatch(decodedPowerShell, /yarn install/);
});

test('remote load probe emits one structured lightweight Node sample on both platforms', () => {
  const posixCommand = buildRemoteLoadProbeCommand({
    ...posix,
    remotePath: ['/opt/node/bin'],
  });
  assert.match(posixCommand, /__HAPPIER_LOAD__/);
  assert.match(posixCommand, /availableParallelism/);
  assert.match(posixCommand, /loadavg/);

  const windowsCommand = buildRemoteLoadProbeCommand({
    ...windows,
    remotePath: ['C:/node'],
  });
  assert.match(windowsCommand, /EncodedCommand/);
});

test('remote daemon readiness probe requires a live pid from the server-scoped state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hstack-daemon-readiness-'));
  const activeServerId = 'stack_repo-test__id_default';
  const serverDir = join(root, 'servers', activeServerId);
  try {
    await execFileAsync('/bin/mkdir', ['-p', serverDir]);
    const statePath = join(serverDir, 'daemon.state.json');
    await execFileAsync('/bin/sh', ['-c', `printf '%s\\n' '{"pid":${process.pid}}' > "$1"`, 'sh', statePath]);
    const command = buildRemoteDaemonReadinessProbeCommand({
      ...posix,
      cliHomeDir: root,
    }, { activeServerId });
    await execFileAsync('/bin/bash', ['-lc', command]);

    await execFileAsync('/bin/sh', ['-c', `printf '%s\\n' '{"pid":99999999}' > "$1"`, 'sh', statePath]);
    await assert.rejects(execFileAsync('/bin/bash', ['-lc', command]));

    const windowsCommand = buildRemoteDaemonReadinessProbeCommand(windows, { activeServerId });
    const decodedPowerShell = Buffer.from(windowsCommand.split(' ').at(-1), 'base64').toString('utf16le');
    assert.match(decodedPowerShell, /daemon\.state\.json/);
    assert.match(decodedPowerShell, /ConvertFrom-Json/);
    assert.match(decodedPowerShell, /Get-Process -Id/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('remote exec validates repo-relative cwd and preserves POSIX argument and env boundaries', () => {
  const target = posix;
  const command = buildRemoteExecCommand(target, {
    executionId,
    cwd: 'apps/cli',
    commandArgs: ['rg', '-n', "a'b", 'src'],
    environment: { CI: '1', HAPPIER_TEST_LABEL: "agent's run" },
  });

  assert.match(command, /cd -- .*\/home\/dev\/Happier repo\/apps\/cli/);
  assert.match(command, /export CI=.*1/);
  assert.match(command, /export HAPPIER_TEST_LABEL=.*agent.*s run/);
  assert.match(command, /set \+e; .*rg.*-n.*a.*b.*src.*command_status=\$\?/);
  assert.throws(
    () => buildRemoteExecCommand(target, { executionId, cwd: '../outside', commandArgs: ['pwd'] }),
    /working directory must stay inside the synchronized repository/i,
  );
});

test('remote exec POSIX shell layer preserves live native argument boundaries', async () => {
  const command = buildRemoteExecCommand(
    { ...posix, repoDir: '/tmp', cliHomeDir: '/tmp/happier-remote-command-test' },
    {
      executionId,
      commandArgs: ['/usr/bin/printf', '<%s>\n', "a'b", 'two words', 'quote"double'],
    },
  );
  const result = await execFileAsync('/bin/bash', ['-c', command]);
  assert.equal(result.stdout, '<a\'b>\n<two words>\n<quote"double>\n');
});

test('remote exec preserves Windows argument and cwd boundaries', () => {
  const command = buildRemoteExecCommand(windows, {
    executionId,
    cwd: 'apps/cli',
    commandArgs: ['rg.exe', '-n', "a'b", 'say "hello"', 'src'],
    environment: { CI: '1' },
  });

  assert.match(command, /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand /);
  assert.doesNotMatch(command, /a'b/);
  const decodedPowerShell = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(decodedPowerShell, /\$ProgressPreference = 'SilentlyContinue'/);
  assert.match(decodedPowerShell, /'say \\"hello\\"'/);
});

test('remote exec publishes an execution-scoped process identity and removes it on normal exit', () => {
  const posixCommand = buildRemoteExecCommand(posix, {
    executionId,
    commandArgs: ['long-test'],
  });
  assert.match(posixCommand, new RegExp(`${executionId}\\.pid`));
  assert.match(posixCommand, /printf .*\$\$.*pid/);
  assert.match(posixCommand, /trap .*EXIT/);

  const windowsCommand = buildRemoteExecCommand(windows, {
    executionId,
    commandArgs: ['long-test.exe'],
  });
  const decodedPowerShell = Buffer.from(windowsCommand.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(decodedPowerShell, new RegExp(`${executionId}\\.pid`));
  assert.match(decodedPowerShell, /Get-Process -Id \$PID/);
  assert.match(decodedPowerShell, /StartTime\.ToUniversalTime\(\)\.Ticks/);
  assert.match(decodedPowerShell, /finally .*Remove-Item/s);
});

test('remote cancellation targets only the recorded execution identity and its descendants', () => {
  const posixCancel = buildRemoteCancelCommand(posix, { executionId });
  assert.match(posixCancel, new RegExp(`${executionId}\\.pid`));
  assert.match(posixCancel, /ps -p .*command=/);
  assert.match(posixCancel, /collect_descendants/);
  assert.match(posixCancel, /kill -TERM/);
  assert.match(posixCancel, /kill -KILL/);

  const windowsCancel = buildRemoteCancelCommand(windows, { executionId });
  const decodedPowerShell = Buffer.from(windowsCancel.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(decodedPowerShell, new RegExp(`${executionId}\\.pid`));
  assert.match(decodedPowerShell, /StartTime\.ToUniversalTime\(\)\.Ticks/);
  assert.match(decodedPowerShell, /taskkill\.exe \/PID \$remoteProcessId \/T \/F/);
});

test('POSIX remote cancellation terminates the live execution tree and removes its identity file', async (t) => {
  try {
    await execFileAsync('/bin/ps', ['-p', String(process.pid), '-o', 'command=']);
  } catch (error) {
    if (error?.code === 'EPERM' || /operation not permitted/i.test(String(error?.stderr ?? error?.message ?? error))) {
      t.skip('local process inspection is unavailable in this sandbox');
      return;
    }
    throw error;
  }
  const root = mkdtempSync(join(tmpdir(), 'happier-remote-cancel-'));
  const liveTarget = {
    ...posix,
    repoDir: root,
    cliHomeDir: join(root, 'home'),
  };
  const childPidFile = join(root, 'child.pid');
  const identityFile = join(liveTarget.cliHomeDir, 'remote-exec', `${executionId}.pid`);
  const command = buildRemoteExecCommand(liveTarget, {
    executionId,
    commandArgs: [
      '/bin/bash',
      '-lc',
      `printf '%s\\n' "$$" > '${childPidFile}'; while :; do sleep 1; done`,
    ],
  });
  const child = spawn('/bin/bash', ['-c', command], { stdio: 'ignore' });
  const completion = new Promise((resolve) => child.once('close', resolve));

  try {
    const deadline = Date.now() + 5_000;
    while ((!existsSync(identityFile) || !existsSync(childPidFile)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(existsSync(identityFile), true, 'remote wrapper must publish its identity');
    assert.equal(existsSync(childPidFile), true, 'remote child must be running before cancellation');
    const childPid = Number(readFileSync(childPidFile, 'utf8').trim());

    await execFileAsync('/bin/bash', ['-c', buildRemoteCancelCommand(liveTarget, { executionId })]);
    let timeout;
    try {
      await Promise.race([
        completion,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('remote wrapper did not exit')), 10_000);
          timeout.unref();
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
    assert.equal(existsSync(identityFile), false);
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    await completion;
    rmSync(root, { recursive: true, force: true });
  }
});

test('remote execution ids are mandatory and path-safe', () => {
  assert.throws(
    () => buildRemoteExecCommand(posix, { commandArgs: ['pwd'] }),
    /execution id/i,
  );
  assert.throws(
    () => buildRemoteCancelCommand(posix, { executionId: '../other' }),
    /execution id/i,
  );
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
  assert.match(command, /HAPPIER_STACK_PM_CACHE_BASE_DIR=.*\.happier\/dev linux\/cache/);
  assert.doesNotMatch(command, /HAPPIER_STACK_PM_CACHE_BASE_DIR=.*HOME.*\/\.cache/);
  assert.match(command, /HAPPIER_STACK_STACK/);
  assert.match(command, /HAPPIER_ACTIVE_SERVER_ID/);
  assert.match(command, /HAPPIER_CLI_PKGROLL_TIMEOUT_MS=1800000/);
  assert.match(command, /http:\/\/127\.0\.0\.1:43005/);
  assert.doesNotMatch(command, /stack stop/);
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
    /\$env:HAPPIER_STACK_PM_CACHE_BASE_DIR = 'C:\/Users\/test qa\/\.happier\/windows\/cache'/,
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

test('remote lifecycle retirement is a separate lightweight command before the long-lived worker', () => {
  const options = {
    services: { server: false, expo: true, daemon: true },
    serverUrl: 'http://127.0.0.1:43005',
    publicServerUrl: 'http://192.168.1.20:53005',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
    remoteExpoPort: 48081,
    expoPublicUrl: 'http://192.168.1.20:18081',
    startMobile: true,
  };

  const stopCommand = buildRemoteStackStopCommand(posix, options);
  const workerCommand = buildRemoteStackCommand(posix, options);
  assert.match(stopCommand, /HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES=.*0/);
  assert.match(stopCommand, /stack stop .*repo-local-dev.* --yes --no-docker/);
  assert.doesNotMatch(stopCommand, /stack dev/);
  assert.doesNotMatch(workerCommand, /HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES/);
  assert.doesNotMatch(workerCommand, /stack stop/);
  assert.match(workerCommand, /stack dev .*repo-local-dev/);

  const windowsStopCommand = buildRemoteStackStopCommand(windows, options);
  const decodedWindowsStop = Buffer.from(
    windowsStopCommand.split(' ').at(-1),
    'base64',
  ).toString('utf16le');
  assert.match(decodedWindowsStop, /HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES = '0'/);
  assert.match(decodedWindowsStop, /stack stop 'repo-local-dev' --yes --no-docker/);
  assert.doesNotMatch(decodedWindowsStop, /stack dev/);
});

test('remote Stack command composes server, Expo, and daemon services with explicit ports and public URL', () => {
  const command = buildRemoteStackCommand(posix, {
    services: { server: true, expo: true, daemon: false },
    serverUrl: 'http://127.0.0.1:43005',
    publicServerUrl: 'http://192.168.1.20:53005',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
    remoteServerPort: 43005,
    remoteExpoPort: 48081,
    expoPublicUrl: 'http://192.168.1.20:18081',
    startMobile: true,
  });
  assert.match(command, /HAPPIER_STACK_SERVER_PORT=43005/);
  assert.match(command, /HAPPIER_STACK_EXPO_DEV_PORT=48081/);
  assert.match(command, /HAPPIER_STACK_EXPO_HOST=localhost/);
  assert.match(command, /EXPO_PACKAGER_PROXY_URL=http:\/\/192\.168\.1\.20:18081/);
  assert.match(command, /--no-daemon/);
  assert.match(command, /--mobile/);
  assert.doesNotMatch(command, /--no-server/);
  assert.doesNotMatch(command, /--no-ui/);

  const expoOnly = buildRemoteStackCommand(posix, {
    services: { server: false, expo: true, daemon: false },
    serverUrl: 'http://127.0.0.1:43006',
    publicServerUrl: 'http://192.168.1.20:53005',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
    remoteExpoPort: 48081,
  });
  assert.match(expoOnly, /--no-server/);
  assert.match(expoOnly, /--server-url=.*127\.0\.0\.1:43006/);
  assert.match(expoOnly, /--server-public-url=.*192\.168\.1\.20:53005/);
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

test('SSH forwarding supports local and reverse routes in one transport owner', () => {
  assert.deepEqual(
    buildSshForwardArgs(posix, {
      forwards: [
        { direction: 'reverse', listenHost: '127.0.0.1', listenPort: 43005, targetHost: '127.0.0.1', targetPort: 3005 },
        { direction: 'local', listenHost: '0.0.0.0', listenPort: 18081, targetHost: 'localhost', targetPort: 48081 },
      ],
    }).slice(-6),
    [
      '-R',
      '127.0.0.1:43005:127.0.0.1:3005',
      '-L',
      '0.0.0.0:18081:localhost:48081',
      '-N',
      'happier-stack-linux',
    ],
  );
});
