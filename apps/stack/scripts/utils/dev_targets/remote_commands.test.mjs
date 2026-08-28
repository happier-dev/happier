import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { buildStackStableScopeId } from '../auth/stable_scope_id.mjs';
import {
  buildRemoteCancelCommand,
  buildRemoteExecCommand,
  buildRemoteDoctorCommand,
  buildRemoteDaemonCommand,
  buildRemoteDaemonReadinessProbeCommand,
  buildRemoteStackRetirementProbeCommand,
  buildRemoteStackStopCommand,
  buildRemoteStackCommand,
  buildRemoteEnsureDirectoriesCommand,
  buildSshForwardArgs,
  buildSshTunnelArgs,
  buildSshWorkerArgs,
  classifyRemoteCommand,
  resolveRemoteStackStatePaths,
  requiresRemoteWorkspacePreparation,
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

test('remote Stack state paths use one canonical target CLI-home derivation', () => {
  const posixState = resolveRemoteStackStatePaths(
    { ...posix, cliHomeDir: '/home/dev/.happier/dev linux/' },
    { stackName: 'repo-local-dev' },
  );
  assert.equal(posixState.stackStorageDir, '/home/dev/.happier/dev linux/stack-state');
  assert.match(posixState.stackName, /^dev-target-linux-[a-f0-9]{16}$/);
  assert.notEqual(posixState.stackName, 'repo-local-dev');
  assert.equal(posixState.stackBaseDir, `/home/dev/.happier/dev linux/stack-state/${posixState.stackName}`);
  assert.equal(posixState.stackEnvPath, `${posixState.stackBaseDir}/env`);
  assert.equal(
    posixState.activeServerId,
    buildStackStableScopeId({ stackName: posixState.stackName, cliIdentity: 'default' }),
  );
  assert.notEqual(
    posixState.stackName,
    resolveRemoteStackStatePaths(posix, { stackName: 'repo-other-dev' }).stackName,
    'controller stacks sharing a target must retain separate target runtime identity',
  );

  const windowsState = resolveRemoteStackStatePaths(
    { ...windows, cliHomeDir: 'C:/Users/test qa/.happier/windows\\' },
    { stackName: 'repo-local-dev' },
  );
  assert.equal(windowsState.stackStorageDir, 'C:/Users/test qa/.happier/windows/stack-state');
  assert.match(windowsState.stackName, /^dev-target-windows-[a-f0-9]{16}$/);
  assert.notEqual(windowsState.stackName, 'repo-local-dev');
  assert.equal(windowsState.stackBaseDir, `C:/Users/test qa/.happier/windows/stack-state/${windowsState.stackName}`);
  assert.equal(windowsState.stackEnvPath, `${windowsState.stackBaseDir}/env`);
});

test('remote Stack retirement probe only verifies that the canonical runtime state is gone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hstack-remote-retirement-probe-'));
  const posixTarget = { ...posix, cliHomeDir: root };
  const posixState = resolveRemoteStackStatePaths(posixTarget, { stackName: 'repo-local-dev' });
  const statePath = join(posixState.stackBaseDir, 'stack.runtime.json');
  try {
    const command = buildRemoteStackRetirementProbeCommand(posixTarget, { stackName: 'repo-local-dev' });

    assert.match(command, new RegExp(`stack-state/${posixState.stackName}/stack\\.runtime\\.json`));
    assert.doesNotMatch(command, /stack stop/);
    await execFileAsync('/bin/bash', ['-lc', command]);

    await execFileAsync('/bin/mkdir', ['-p', posixState.stackBaseDir]);
    await execFileAsync('/bin/sh', ['-c', "printf '%s\\n' '{}' > \"$1\"", 'sh', statePath]);
    await assert.rejects(execFileAsync('/bin/bash', ['-lc', command]));

    const windowsState = resolveRemoteStackStatePaths(windows, { stackName: 'repo-local-dev' });
    const windowsCommand = buildRemoteStackRetirementProbeCommand(windows, {
      stackName: 'repo-local-dev',
    });
    const decodedWindows = Buffer.from(windowsCommand.split(' ').at(-1), 'base64').toString('utf16le');
    assert.match(decodedWindows, new RegExp(`stack-state/${windowsState.stackName}/stack\\.runtime\\.json`));
    assert.match(decodedWindows, /Test-Path/);
    assert.doesNotMatch(decodedWindows, /stack stop/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('remote command classification keeps Git/index/worktree operations on the authority', () => {
  for (const args of [
    ['git', 'status'],
    ['/usr/bin/git', 'diff'],
    ['git', 'grep', 'needle'],
    ['git', 'worktree', 'list'],
  ]) {
    assert.deepEqual(classifyRemoteCommand(args), {
      placement: 'primary-only',
      commandClass: 'vcs-authority',
    });
  }
  assert.deepEqual(classifyRemoteCommand(['rg', '-n', 'needle']), {
    placement: 'worker-eligible',
    commandClass: 'source-search',
  });
});

test('remote command classification admits generated workspace preparation only for validation commands', () => {
  for (const args of [
    ['tsc', '--noEmit'],
    ['vitest', 'run'],
    ['yarn', '-s', 'typecheck:local'],
    ['corepack', 'yarn', '-s', 'test:unit:local'],
  ]) {
    assert.equal(requiresRemoteWorkspacePreparation(args, { cwd: 'apps/cli' }), true);
  }

  assert.equal(
    requiresRemoteWorkspacePreparation(['corepack', 'yarn', '-s', 'typecheck:local'], { cwd: '.' }),
    false,
    'repository-root scripts retain ownership of their declared build pipeline',
  );
  assert.equal(requiresRemoteWorkspacePreparation(['rg', '-n', 'needle'], { cwd: 'apps/cli' }), false);
  assert.equal(requiresRemoteWorkspacePreparation(['node', 'script.mjs'], { cwd: 'apps/cli' }), false);
});

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
  assert.match(posixCommand, /command -v rg/);
  assert.doesNotMatch(posixCommand, /yarn install/);

  const windowsCommand = buildRemoteDoctorCommand({
    ...windows,
    remotePath: ['C:/Users/test qa/node', 'C:/Program Files/ripgrep'],
  });
  const decodedPowerShell = Buffer.from(windowsCommand.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(decodedPowerShell, /\$env:PATH = .*node.*ripgrep.*PathSeparator.*\$env:PATH/);
  assert.match(decodedPowerShell, /Get-Command node/);
  assert.match(decodedPowerShell, /Get-Command corepack/);
  assert.match(decodedPowerShell, /Get-Command rg/);
  assert.doesNotMatch(decodedPowerShell, /yarn install/);
});

test('remote daemon readiness probe requires a live pid from the server-scoped state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hstack-daemon-readiness-'));
  const target = { ...posix, cliHomeDir: root };
  const stackName = 'repo-local-dev';
  const { activeServerId } = resolveRemoteStackStatePaths(target, { stackName });
  const serverDir = join(root, 'servers', activeServerId);
  try {
    await execFileAsync('/bin/mkdir', ['-p', serverDir]);
    const statePath = join(serverDir, 'daemon.state.json');
    await execFileAsync('/bin/sh', ['-c', `printf '%s\\n' '{"pid":${process.pid}}' > "$1"`, 'sh', statePath]);
    const command = buildRemoteDaemonReadinessProbeCommand(target, { stackName });
    await execFileAsync('/bin/bash', ['-lc', command]);

    await execFileAsync('/bin/sh', ['-c', `printf '%s\\n' '{"pid":99999999}' > "$1"`, 'sh', statePath]);
    await assert.rejects(execFileAsync('/bin/bash', ['-lc', command]));

    const windowsCommand = buildRemoteDaemonReadinessProbeCommand(windows, { stackName });
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
  const posixRemoteStack = resolveRemoteStackStatePaths(posix, { stackName: 'repo-local-dev' }).stackName;
  const command = buildRemoteDaemonCommand(posix, {
    serverUrl: 'http://127.0.0.1:43005',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
  });
  assert.match(
    command,
    new RegExp(`corepack yarn workspace @happier-dev/stack stack dev .*${posixRemoteStack}.* --no-server --no-ui --no-browser --no-dev-targets --watch`),
  );
  assert.doesNotMatch(command, /--restart/);
  assert.match(command, new RegExp(`stack new .*${posixRemoteStack}.*--if-missing`));
  assert.match(command, new RegExp(`stack env .*${posixRemoteStack}.* set`));
  assert.match(command, /HAPPIER_HOME_DIR/);
  assert.match(command, /HAPPIER_STACK_HOME_DIR/);
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

  const windowsRemoteStack = resolveRemoteStackStatePaths(windows, { stackName: 'repo-local-dev' }).stackName;
  const windowsCommand = buildRemoteDaemonCommand(windows, {
    serverUrl: 'http://127.0.0.1:43105',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
  });
  const decodedPowerShell = Buffer.from(windowsCommand.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(decodedPowerShell, /\$env:HAPPIER_STACK_HOME_DIR/);
  assert.match(decodedPowerShell, /\$env:HAPPIER_STACK_CLI_HOME_DIR/);
  assert.match(
    decodedPowerShell,
    /\$env:HAPPIER_STACK_PM_CACHE_BASE_DIR = 'C:\/Users\/test qa\/\.happier\/windows\/cache'/,
  );
  assert.match(decodedPowerShell, new RegExp(`\\$env:HAPPIER_STACK_STACK = '${windowsRemoteStack}'`));
  assert.match(decodedPowerShell, /HAPPIER_CLI_PKGROLL_TIMEOUT_MS=1800000/);
  assert.match(
    decodedPowerShell,
    new RegExp(`corepack yarn workspace @happier-dev/stack stack dev '${windowsRemoteStack}' --no-server --no-ui --no-browser --no-dev-targets --watch`),
  );
  assert.doesNotMatch(decodedPowerShell, /stack stop/);
  assert.doesNotMatch(decodedPowerShell, /--restart/);
  assert.match(decodedPowerShell, new RegExp(`stack new '${windowsRemoteStack}'.*--if-missing`));
  assert.match(decodedPowerShell, new RegExp(`stack env '${windowsRemoteStack}'.* set`));
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
  const posixRemoteStack = resolveRemoteStackStatePaths(posix, { stackName: options.stackName }).stackName;
  assert.match(stopCommand, /HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES=.*0/);
  assert.match(stopCommand, new RegExp(`stack stop .*${posixRemoteStack}.* --yes --no-docker`));
  assert.doesNotMatch(stopCommand, /stack new/);
  assert.doesNotMatch(stopCommand, /stack env/);
  assert.doesNotMatch(stopCommand, /stack dev/);
  assert.doesNotMatch(workerCommand, /HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES/);
  assert.doesNotMatch(workerCommand, /stack stop/);
  assert.match(workerCommand, /HAPPIER_STACK_HOME_DIR/);
  assert.match(workerCommand, new RegExp(`stack new .*${posixRemoteStack}.*--if-missing`));
  assert.match(workerCommand, new RegExp(`stack env .*${posixRemoteStack}.* set`));
  assert.ok(
    workerCommand.indexOf('stack new') < workerCommand.indexOf('stack env')
      && workerCommand.indexOf('stack env') < workerCommand.indexOf('stack dev'),
    'the Stack lifecycle owner must create-or-preserve, then project target configuration, before dev',
  );
  assert.doesNotMatch(workerCommand, /printf '%s\\n'.*stack-state/);
  assert.match(workerCommand, new RegExp(`stack dev .*${posixRemoteStack}`));

  const windowsStopCommand = buildRemoteStackStopCommand(windows, options);
  const windowsRemoteStack = resolveRemoteStackStatePaths(windows, { stackName: options.stackName }).stackName;
  const decodedWindowsStop = Buffer.from(
    windowsStopCommand.split(' ').at(-1),
    'base64',
  ).toString('utf16le');
  assert.match(decodedWindowsStop, /HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES = '0'/);
  assert.match(decodedWindowsStop, new RegExp(`stack stop '${windowsRemoteStack}' --yes --no-docker`));
  assert.doesNotMatch(decodedWindowsStop, /stack new/);
  assert.doesNotMatch(decodedWindowsStop, /stack env/);
  assert.doesNotMatch(decodedWindowsStop, /stack dev/);

  const windowsWorkerCommand = buildRemoteStackCommand(windows, options);
  const decodedWindowsWorker = Buffer.from(
    windowsWorkerCommand.split(' ').at(-1),
    'base64',
  ).toString('utf16le');
  assert.match(decodedWindowsWorker, /\$env:HAPPIER_STACK_HOME_DIR/);
  assert.match(decodedWindowsWorker, new RegExp(`stack new '${windowsRemoteStack}'.*--if-missing`));
  assert.match(decodedWindowsWorker, new RegExp(`stack env '${windowsRemoteStack}'.* set`));
  assert.ok(
    decodedWindowsWorker.indexOf('stack new') < decodedWindowsWorker.indexOf('stack env')
      && decodedWindowsWorker.indexOf('stack env') < decodedWindowsWorker.indexOf('stack dev'),
    'the Windows worker must initialize through Stack before dev',
  );
  assert.doesNotMatch(decodedWindowsWorker, /Set-Content -LiteralPath \$stackEnvPath/);
});

test('co-located remote server waits for deferred daemon credentials without creating another worker', () => {
  const options = {
    services: { server: true, expo: true, daemon: true },
    serverUrl: 'http://127.0.0.1:43005',
    publicServerUrl: 'http://192.168.1.20:53005',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
    remoteServerPort: 43005,
    remoteExpoPort: 48081,
    remoteServerRuntimeConfig: {
      serverComponentName: 'happier-server-light',
      dbProvider: 'sqlite',
      environment: {},
    },
    deferDaemonStartUntilCredentials: true,
  };

  const command = buildRemoteStackCommand(posix, options);
  const posixRemoteStack = resolveRemoteStackStatePaths(posix, { stackName: options.stackName }).stackName;
  assert.match(command, /HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH=1/);
  assert.match(command, new RegExp(`stack dev .*${posixRemoteStack}`));

  const ordinaryCommand = buildRemoteStackCommand(posix, {
    ...options,
    deferDaemonStartUntilCredentials: false,
  });
  assert.doesNotMatch(ordinaryCommand, /HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH/);

  const windowsCommand = buildRemoteStackCommand(windows, options);
  const decodedWindowsCommand = Buffer.from(windowsCommand.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(decodedWindowsCommand, /HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH=1/);
});

test('remote Stack server uses the stable outer public URL and projects only supported light/SQLite semantics', () => {
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
    resolveServerPublicUrlOnTarget: false,
    resolveExpoPublicUrlOnTarget: false,
    remoteServerRuntimeConfig: {
      serverComponentName: 'happier-server-light',
      dbProvider: 'sqlite',
      environment: {
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'required',
        HAPPIER_SERVER_RETENTION__ENABLED: 'true',
        HAPPIER_SERVER_RETENTION__INTERVAL_MS: '60000',
        HAPPIER_SERVER_RETENTION__SESSIONS__MODE: 'delete_inactive',
        HAPPIER_SQLITE_BUSY_TIMEOUT_MS: '45000',
        HAPPIER_SQLITE_CONNECTION_LIMIT: '6',
        DATABASE_URL: 'postgresql://operator:do-not-forward@db.example.test/happier',
        HAPPIER_SERVER_LIGHT_DATA_DIR: '/private/remote-state',
        HAPPIER_STACK_SERVER_PORT: '9999',
        HAPPIER_MASTER_SECRET: 'never-forward-this',
      },
    },
  });
  assert.match(command, /HAPPIER_STACK_SERVER_PORT=43005/);
  assert.match(command, /HAPPIER_STACK_SERVER_COMPONENT=happier-server-light/);
  assert.match(command, /HAPPIER_DB_PROVIDER=sqlite/);
  assert.match(command, /HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY=required/);
  assert.match(command, /HAPPIER_SERVER_RETENTION__ENABLED=true/);
  assert.match(command, /HAPPIER_SERVER_RETENTION__SESSIONS__MODE=delete_inactive/);
  assert.match(command, /HAPPIER_SQLITE_BUSY_TIMEOUT_MS=45000/);
  assert.match(command, /HAPPIER_SQLITE_CONNECTION_LIMIT=6/);
  assert.doesNotMatch(command, /do-not-forward|private\/remote-state|never-forward-this|HAPPIER_MASTER_SECRET/);
  assert.match(command, /--server-public-url=.*192\.168\.1\.20:53005/);
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

test('remote target resolves automatically detected mobile public addresses at its own startup', () => {
  const command = buildRemoteStackCommand(posix, {
    services: { server: true, expo: true, daemon: false },
    serverUrl: 'http://127.0.0.1:52753',
    // This is the stale guest address that must not be injected into the Mac target.
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
      environment: {},
    },
  });

  assert.match(command, /--mobile/);
  assert.match(command, /HAPPIER_STACK_EXPO_HOST=localhost/);
  assert.doesNotMatch(command, /EXPO_PACKAGER_PROXY_URL=/);
  assert.doesNotMatch(command, /--server-public-url=/);
  assert.doesNotMatch(command, /192\.168\.5\.15/);
});

test('remote Stack server fails closed for unsupported server flavors and SQLite providers', () => {
  const base = {
    services: { server: true, expo: false, daemon: false },
    serverUrl: 'http://127.0.0.1:43005',
    publicServerUrl: 'http://192.168.1.20:53005',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
    remoteServerPort: 43005,
  };

  assert.throws(
    () => buildRemoteStackCommand(posix, {
      ...base,
      remoteServerRuntimeConfig: {
        serverComponentName: 'happier-server',
        environment: {},
      },
    }),
    /only supports.*happier-server-light/i,
  );
  assert.throws(
    () => buildRemoteStackCommand(posix, {
      ...base,
      remoteServerRuntimeConfig: {
        serverComponentName: 'happier-server-light',
        dbProvider: 'pglite',
        environment: {},
      },
    }),
    /only supports.*sqlite/i,
  );
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
      '*:18081:localhost:48081',
      '-N',
      'happier-stack-linux',
    ],
  );
});
