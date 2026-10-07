import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { installNativeAdmissionFixture } from '../../testkit/core/native_admission_fixture.mjs';

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
  resolveRemoteValidationKind,
  resolveRemoteStackStatePaths,
  requiresRemoteDependencyBootstrap,
  requiresRemoteWorkspacePreparation,
  resolveRemoteServerRuntimeConfig,
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

function installRemoteCustody(repoDir) {
  const directory = join(repoDir, 'apps/stack/scripts/utils/dev_targets');
  mkdirSync(directory, { recursive: true });
  copyFileSync(fileURLToPath(new URL('./remote_execution_custody.sh', import.meta.url)), join(directory, 'remote_execution_custody.sh'));
  mkdirSync(join(repoDir, 'apps/stack/scripts/utils/proc'), { recursive: true });
  copyFileSync(fileURLToPath(new URL('../proc/native_process_identity.sh', import.meta.url)), join(repoDir, 'apps/stack/scripts/utils/proc/native_process_identity.sh'));
  const hostState = join(repoDir, 'apps/stack/scripts/utils/proc/native_host_admission_state.sh');
  if (!existsSync(hostState)) copyFileSync(fileURLToPath(new URL('../proc/native_host_admission_state.sh', import.meta.url)), hostState);
}

test('controlled remote stacks isolate CLI state and scratch and start the selected runtime without watch', () => {
  const options = {
    stackName: 'agent-qa', runtimeMode: 'controlled', runtimeSnapshotId: 'snapshot-x64',
    services: { server: true, expo: false, daemon: true }, remoteServerPort: 43001,
    serverUrl: 'http://127.0.0.1:43001', publicServerUrl: 'http://127.0.0.1:3005',
    canonicalServerUrl: 'http://happier-agent-qa.localhost:3005',
    remoteServerRuntimeConfig: { serverComponentName: 'happier-server-light', dbProvider: 'sqlite', environment: {} },
  };
  const paths = resolveRemoteStackStatePaths(posix, options);
  assert.equal(paths.cliHomeDir, `${paths.stackBaseDir}/cli`);
  assert.equal(paths.workspaceDir, `${paths.stackBaseDir}/workspace`);
  assert.equal(paths.activeServerId, buildStackStableScopeId({ stackName: 'agent-qa', cliIdentity: 'default' }));
  const command = buildRemoteStackCommand(posix, options);
  assert.match(command, /stack start .*--runtime/);
  assert.match(command, /--no-dev-targets/);
  assert.doesNotMatch(command, /stack dev|--watch/);
  assert.ok(command.includes(paths.cliHomeDir));
  assert.ok(command.includes(paths.workspaceDir));
  assert.match(command, /HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES=0/);
  assert.match(command, /HAPPIER_PUBLIC_SERVER_URL=http:\/\/127\.0\.0\.1:3005/);
  assert.match(command, /mkdir -p -- .*workspace/);
});

test('controlled writable state rejects the one-way source replica and accepts sibling paths on both platforms', () => {
  for (const target of [
    { ...posix, repoDir: '/remote/repo', cliHomeDir: '/remote/repo/.happier' },
    { ...windows, repoDir: 'C:/Remote/Repo', cliHomeDir: 'c:\\remote\\repo\\state' },
  ]) assert.throws(() => resolveRemoteStackStatePaths(target, { stackName: 'qa', runtimeMode: 'controlled' }), /outside.*source replica/);
  assert.ok(resolveRemoteStackStatePaths({ ...posix, repoDir: '/remote/repo', cliHomeDir: '/remote/repo-state' }, { stackName: 'qa', runtimeMode: 'controlled' }).workspaceDir);
});

test('controlled daemon-only commands reach the forwarded server without starting a server or UI', () => {
  for (const target of [posix, windows]) {
    const invocation = buildRemoteStackCommand(target, {
      stackName: 'agent-qa', runtimeMode: 'controlled', runtimeSnapshotId: 'daemon-linux',
      services: { server: false, expo: false, daemon: true },
      serverUrl: 'http://127.0.0.1:43001', publicServerUrl: 'http://127.0.0.1:3005',
    });
    const command = target.platform === 'windows'
      ? Buffer.from(invocation.split(' ').at(-1), 'base64').toString('utf16le')
      : invocation;
    assert.match(command, /--no-server/);
    assert.match(command, /--no-ui/);
    assert.ok(command.includes('http://127.0.0.1:43001'));
    assert.doesNotMatch(command, /--no-daemon/);
  }
});

test('whole-operation admission covers preparation children, preserves cwd/env and stops on preparation failure', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-whole-operation-' });
  const { launcher } = await installNativeAdmissionFixture({ root });
  const checkout = join(root, 'native-owner');
  installRemoteCustody(checkout);
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(checkout, 'apps/cli'), { recursive: true });
  chmodSync(launcher, 0o755);
  const executable = (name, body) => { writeFileSync(join(bin, name), '#!/bin/sh\n' + body + '\n'); chmodSync(join(bin, name), 0o755); };
  // Mock only OS tool/resource boundaries. The native admission logic is real.
  executable('uname', 'printf "Linux\\n"');
  executable('getconf', 'printf "8\\n"');
  executable('systemctl', 'exit 1');
  executable('awk', 'case "$*" in */proc/meminfo*) printf "25480397 28311552\\n" ;; */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;; *) exec /usr/bin/awk "$@" ;; esac');
  executable('node', 'case "$*" in *service_memory.mjs*) printf "service 0\\n"; exit 0 ;; esac\n[ -n "$HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN" ] || exit 99\ncase "$*" in *remote_dependency_bootstrap*) stage=bootstrap ;; *) stage=prepare ;; esac\nprintf "%s\\n" "$stage" >> "$TRACE"\n[ "$FAIL_STAGE" != "$stage" ] || exit 42');
  executable('probe-command', '[ -n "$HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN" ] || exit 99\nprintf "payload:%s:%s\\n" "$PWD" "$VALUE" >> "$TRACE"');
  const localTarget = { ...posix, repoDir: checkout, cliHomeDir: join(root, 'cli-home'), remotePath: [bin, '/usr/bin', '/bin'] };
  const trace = join(root, 'trace');
  const request = failStage => buildRemoteExecCommand(localTarget, {
    executionId, cwd: 'apps/cli', commandArgs: ['probe-command'], admissionClass: 'targeted-validation',
    preparation: { bootstrap: true, componentRelativeDir: 'apps/cli', validationKind: 'runtime' },
    environment: { HOME: root, HAPPIER_STACK_CLI_HOME_DIR: join(root, 'admission-home'), TRACE: trace, VALUE: "literal '$value'", FAIL_STAGE: failStage },
  });
  await execFileAsync('/bin/bash', ['-c', request('')]);
  assert.equal(readFileSync(trace, 'utf8'), `bootstrap\nprepare\npayload:${checkout}/apps/cli:literal '$value'\n`);
  writeFileSync(trace, '');
  await assert.rejects(execFileAsync('/bin/bash', ['-c', request('bootstrap')]), error => error.code === 42);
  assert.equal(readFileSync(trace, 'utf8'), 'bootstrap\n');
});

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
      requiresDependencyBootstrap: false,
    });
  }
  assert.deepEqual(classifyRemoteCommand(['rg', '-n', 'needle']), {
    placement: 'worker-eligible',
    commandClass: 'source-search',
    requiresDependencyBootstrap: false,
  });
});

test('remote command classification owns dependency bootstrap scope', () => {
  for (const args of [
    [],
    ['node', '-e', 'console.log("ok")'],
    ['nodejs', 'source-script.mjs'],
    ['rg', 'needle'],
    ['find', '.', '-name', '*.mjs'],
    ['git', 'status'],
    ['yarn', '--version'],
  ]) {
    assert.equal(classifyRemoteCommand(args).requiresDependencyBootstrap, false, args.join(' '));
    assert.equal(requiresRemoteDependencyBootstrap(args), false, args.join(' '));
  }
  for (const args of [
    ['corepack', 'yarn', '--cwd', 'apps/ui', '-s', 'typecheck'],
    ['yarn', 'custom:script'],
    ['npm', 'run', 'custom:script'],
    ['pnpm', '-C', 'apps/ui', 'run', 'build'],
    ['npx', 'vitest', 'run'],
    ['vitest', 'run'],
    ['tsc', '--noEmit'],
    ['node', 'scripts/workspaces/runTypeScriptCli.mjs', '-p', 'tsconfig.json'],
    ['nodejs', 'scripts/workspaces/runTypeScriptCli.mjs', '-p', 'tsconfig.json'],
    ['node', 'node_modules/vitest/vitest.mjs', 'run'],
    ['nodejs', 'node_modules/vitest/vitest.mjs', 'run'],
    ['/usr/bin/node', '--test', 'owner.test.mjs'],
    ['node', '--test', 'apps/stack/scripts/utils/auth/auth.test.mjs'],
    ['nodejs', '--test', '--test-name-pattern=owner', 'apps/stack/scripts/utils/auth/auth.test.mjs'],
  ]) {
    assert.equal(classifyRemoteCommand(args).requiresDependencyBootstrap, true, args.join(' '));
    assert.equal(requiresRemoteDependencyBootstrap(args), true, args.join(' '));
  }
  assert.equal(classifyRemoteCommand(['node', '--test', 'scripts/owner.test.mjs'], { cwd: 'apps/stack' }).requiresDependencyBootstrap, true);
  assert.equal(classifyRemoteCommand(['node', '--test', 'scripts/owner.test.mjs'], { cwd: 'apps/stack2' }).requiresDependencyBootstrap, true);
});

test('native source tests and generator checks use their real preparation contract', () => {
  const sdk = ['node', '--test', 'packages/plugin-sdk/scripts/generateActionTypeMap.test.mjs'];
  assert.equal(classifyRemoteCommand(sdk).requiresDependencyBootstrap, true);
  assert.equal(resolveRemoteValidationKind(sdk), 'source-test');
  assert.equal(resolveRemoteValidationKind(['node', '--test', 'apps/ui/scripts/generateBundledPluginUiArtifacts.test.mjs']), 'runtime');
  assert.equal(requiresRemoteWorkspacePreparation(['node', '--test', 'apps/ui/scripts/generateBundledPluginUiArtifacts.test.mjs']), true);
  assert.equal(resolveRemoteValidationKind(['node', '--test', 'unknown.test.mjs']), 'runtime');
  assert.equal(resolveRemoteValidationKind(['node', '--test', 'apps/stack/scripts/config.test.mjs']), 'runtime');
  const generator = ['node', '--experimental-strip-types', 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts', '--mode', 'check'];
  assert.equal(classifyRemoteCommand(generator).commandClass, 'targeted-validation');
  assert.equal(requiresRemoteWorkspacePreparation(generator), true);
  assert.equal(classifyRemoteCommand(['node', '--experimental-strip-types', 'other/generateBundledPluginEntries.ts', '--mode', 'check']).commandClass, 'unclassified');
  assert.equal(classifyRemoteCommand(['tsc', '-p', 'apps/cli/tsconfig.json']).commandClass, 'targeted-validation');
});

test('remote command classification admits generated workspace preparation only for validation commands', () => {
  for (const args of [
    ['vitest', 'run'],
    ['corepack', 'yarn', '-s', 'test:unit:local'],
    ['tsc', '--noEmit'],
    ['node', '../../scripts/workspaces/runTypeScriptCli.mjs', '-p', 'tsconfig.json'],
    ['yarn', '-s', 'typecheck:local'],
    ['yarn', '-s', 'tsc'],
    ['nodejs', '../../scripts/workspaces/runTypeScriptCli.mjs', '-p', 'tsconfig.json'],
    ['corepack', 'yarn', '--cwd', 'apps/ui', 'typecheck'],
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

test('source-test classification follows the configured resolver contract rather than test filenames', () => {
  for (const args of [
    ['corepack', 'yarn', '-s', 'vitest', 'run', 'arbitrary.test.ts'],
    ['corepack', 'yarn', '-s', 'vitest', 'run', 'src/plugins/authoring/bundleDaemonRuntime.test.ts'],
    ['vitest', 'run', '--config=vitest.config.ts', 'artifact-named.test.ts'],
  ]) {
    assert.equal(resolveRemoteValidationKind(args, { cwd: 'apps/cli' }), 'source-test');
  }
  for (const args of [
    ['vitest', 'run', '--config', 'vitest.integration.config.ts'],
    ['corepack', 'yarn', '-s', 'vitest', 'run', '--config=vitest.integration.config.ts', 'src/plugins/authoring/bundleDaemonRuntime.integration.test.ts'],
    ['vitest', 'run', '--config=unknown.config.ts'],
    ['vitest', 'run', '--root=../ui'],
    ['vitest', 'run', '--workspace', 'custom.workspace.ts'],
    ['vitest', 'run', '--project=artifact'],
    ['vitest', 'run', '-r../ui'],
    ['corepack', 'yarn', '-s', 'vitest:artifact'],
  ]) assert.equal(resolveRemoteValidationKind(args, { cwd: 'apps/cli' }), 'runtime');
  assert.equal(resolveRemoteValidationKind(['vitest', 'run'], { cwd: 'apps/ui' }), 'source-test');
  assert.equal(resolveRemoteValidationKind(
    ['node', '../../../node_modules/vitest/vitest.mjs', 'run', '--config=vitest.config.ts'],
    { cwd: 'packages/plugins/triage' },
  ), 'source-test');
  assert.equal(resolveRemoteValidationKind(
    ['vitest', 'run', '--config=vitest.integration.config.ts'],
    { cwd: 'packages/plugins/triage' },
  ), 'runtime');
});

test('remote command classification admits declaration preparation for package-manager component cwd', () => {
  assert.equal(requiresRemoteWorkspacePreparation(
    ['corepack', 'yarn', '--cwd', 'apps/ui', '-s', 'typecheck'], { cwd: '.' },
  ), true);
  assert.equal(requiresRemoteWorkspacePreparation(
    ['yarn', '--cwd=packages/plugin-sdk', '-s', 'typecheck'], { cwd: '.' },
  ), true);
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
  assert.match(command, /exec .*rg.*-n.*a.*b.*src/);
  assert.throws(
    () => buildRemoteExecCommand(target, { executionId, cwd: '../outside', commandArgs: ['pwd'] }),
    /working directory must stay inside the synchronized repository/i,
  );
});

test('remote classification recognizes direct native TypeScript and nested launcher validation', () => {
  assert.deepEqual(
    classifyRemoteCommand(['node', '../../scripts/workspaces/runTypeScriptCli.mjs', '--noEmit'], { cwd: 'apps/ui' }),
    { placement: 'worker-eligible', commandClass: 'targeted-validation', requiresDependencyBootstrap: true },
  );
  assert.deepEqual(
    classifyRemoteCommand(['apps/stack/bin/hstack-exec', '--local', '--', 'sh', '-lc', 'typecheck']),
    { placement: 'worker-eligible', commandClass: 'full-validation', requiresDependencyBootstrap: false },
  );
});

test('remote exec POSIX shell layer preserves live native argument boundaries', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-remote-arguments-' });
  installRemoteCustody(root);
  const command = buildRemoteExecCommand(
    { ...posix, repoDir: root, cliHomeDir: join(root, 'home') },
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

test('Windows remote exec publishes an execution-scoped process identity and removes it on normal exit', () => {
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

test('Windows remote cancellation targets only the recorded execution identity and its descendants', () => {
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
  installRemoteCustody(root);
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

test('POSIX remote execution forwards wrapper termination to its live command tree', async (t) => {
  try {
    await execFileAsync('/bin/ps', ['-p', String(process.pid), '-o', 'command=']);
  } catch (error) {
    if (error?.code === 'EPERM' || /operation not permitted/i.test(String(error?.stderr ?? error?.message ?? error))) {
      t.skip('local process inspection is unavailable in this sandbox');
      return;
    }
    throw error;
  }
  const root = mkdtempSync(join(tmpdir(), 'happier-remote-signal-'));
  installRemoteCustody(root);
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
  let commandPid = null;

  try {
    const deadline = Date.now() + 5_000;
    while ((!existsSync(identityFile) || !existsSync(childPidFile)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(existsSync(identityFile), true, 'remote wrapper must publish its identity');
    assert.equal(existsSync(childPidFile), true, 'remote child must be running before termination');
    const wrapperPid = Number(readFileSync(identityFile, 'utf8').split('\n')[0]);
    commandPid = Number(readFileSync(childPidFile, 'utf8').trim());

    process.kill(wrapperPid, 'SIGTERM');
    let timeout;
    try {
      await Promise.race([
        completion,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('remote wrapper did not exit after SIGTERM')), 10_000);
          timeout.unref();
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    assert.throws(() => process.kill(commandPid, 0), { code: 'ESRCH' });
    assert.equal(existsSync(identityFile), false);
  } finally {
    if (commandPid != null) {
      try { process.kill(commandPid, 'SIGKILL'); } catch { }
    }
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
  const windowsCommand = buildRemoteStackCommand(windows, {
    services: { server: false, daemon: true },
    serverUrl: 'http://127.0.0.1:43005',
    publicServerUrl: 'http://127.0.0.1:3005',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
    attended: true,
  });
  const decodedWindowsCommand = Buffer.from(windowsCommand.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(decodedWindowsCommand, /\$env:HAPPIER_STACK_TUI = '1'/);
});

test('remote Stack server receives the non-secret auth mail, email/password and mail-link origin settings, never the SMTP password', () => {
  const command = buildRemoteStackCommand(posix, {
    services: { server: true, expo: false, daemon: false },
    serverUrl: 'http://127.0.0.1:43005',
    publicServerUrl: 'http://192.168.1.20:53005',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
    remoteServerPort: 43005,
    resolveServerPublicUrlOnTarget: false,
    remoteServerRuntimeConfig: {
      serverComponentName: 'happier-server-light',
      dbProvider: 'sqlite',
      environment: {
        HAPPIER_AUTH_EMAIL_SMTP_HOST: '127.0.0.1',
        HAPPIER_AUTH_EMAIL_SMTP_PORT: '1025',
        HAPPIER_AUTH_EMAIL_SMTP_SECURE: 'false',
        HAPPIER_AUTH_EMAIL_SMTP_USERNAME: 'mailer',
        HAPPIER_AUTH_EMAIL_SMTP_PASSWORD: 'smtp-secret-do-not-forward',
        HAPPIER_AUTH_EMAIL_FROM_ADDRESS: 'noreply@happier.localhost',
        HAPPIER_AUTH_EMAIL_FROM_NAME: 'Happier',
        HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: 'true',
        HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__PROVISION_ENABLED: 'true',
        HAPPIER_WEBAPP_URL: 'http://127.0.0.1:19364',
      },
    },
  });
  // Mailed links are rendered on the application origin; without it a remote server mails nothing.
  assert.match(command, /HAPPIER_WEBAPP_URL=http:\/\/127\.0\.0\.1:19364/);
  assert.match(command, /HAPPIER_AUTH_EMAIL_SMTP_HOST=127\.0\.0\.1/);
  assert.match(command, /HAPPIER_AUTH_EMAIL_SMTP_PORT=1025/);
  assert.match(command, /HAPPIER_AUTH_EMAIL_SMTP_SECURE=false/);
  assert.match(command, /HAPPIER_AUTH_EMAIL_SMTP_USERNAME=mailer/);
  assert.match(command, /HAPPIER_AUTH_EMAIL_FROM_ADDRESS=noreply@happier\.localhost/);
  assert.match(command, /HAPPIER_AUTH_EMAIL_FROM_NAME=Happier/);
  assert.match(command, /HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED=true/);
  assert.match(command, /HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__PROVISION_ENABLED=true/);
  // A secret would land in a remote command line and a persisted env file: never forwarded.
  assert.doesNotMatch(command, /smtp-secret-do-not-forward|HAPPIER_AUTH_EMAIL_SMTP_PASSWORD/);
});

test('remote Stack server projects public-share isolation and fixed-window policy on POSIX and Windows', () => {
  const environment = {
    HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: 'qa.example.test',
    HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_CHECKER: 'fixed_window',
    HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_MAX_REQUESTS: '120',
    HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_WINDOW_MS: '60000',
  };
  const config = resolveRemoteServerRuntimeConfig({
    serverComponentName: 'happier-server-light',
    env: { ...environment, HAPPIER_MASTER_SECRET: 'private-secret', UNRELATED_SETTING: 'unrelated' },
  });
  assert.deepEqual(config.environment, environment);
  for (const target of [posix, windows]) {
    const command = buildRemoteStackCommand(target, {
      services: { server: true, expo: false, daemon: false },
      stackName: 'remote-qa', serverUrl: 'http://127.0.0.1:43005',
      publicServerUrl: 'https://qa.example.test', remoteServerPort: 43005,
      remoteServerRuntimeConfig: config,
    });
    const rendered = target.platform === 'windows'
      ? Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le') : command;
    for (const [key, value] of Object.entries(environment)) {
      assert.ok(rendered.includes(`${key}=${value}`), `${target.platform} omitted ${key}`);
    }
    assert.doesNotMatch(rendered, /private-secret|UNRELATED_SETTING/);
  }
});

test('remote Stack server uses the stable outer public URL and projects only supported light/SQLite semantics', () => {
  const serverPlacedOptions = {
    services: { server: true, expo: true, daemon: false },
    serverUrl: 'http://127.0.0.1:43005',
    publicServerUrl: 'http://192.168.1.20:53005',
    canonicalServerUrl: 'http://happier-repo-local-dev.localhost:53288',
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
  };
  const command = buildRemoteStackCommand(posix, serverPlacedOptions);
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
  // The originating Stack owns the signed auth audience: the remote server must sign the origin's
  // canonical origin, not one derived from the remote target's own Stack name and port.
  assert.match(command, /HAPPIER_CANONICAL_SERVER_URL=http:\/\/happier-repo-local-dev\.localhost:53288/);
  const windowsServerCommand = buildRemoteStackCommand(windows, serverPlacedOptions);
  assert.match(
    Buffer.from(windowsServerCommand.split(' ').at(-1), 'base64').toString('utf16le'),
    /HAPPIER_CANONICAL_SERVER_URL=http:\/\/happier-repo-local-dev\.localhost:53288/,
  );
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
    canonicalServerUrl: 'http://happier-repo-local-dev.localhost:53288',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
    remoteExpoPort: 48081,
  });
  assert.doesNotMatch(expoOnly, /HAPPIER_CANONICAL_SERVER_URL/);
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
    remoteExpoPort: 30685,
    expoPublicPort: 18829,
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
  assert.match(command, /HAPPIER_STACK_EXPO_PUBLIC_PORT=18829/);
  assert.match(command, /HAPPIER_STACK_EXPO_DEV_PORT=30685/);
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
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
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
  const args = buildSshForwardArgs(posix, {
    forwards: [
      { direction: 'reverse', listenHost: '127.0.0.1', listenPort: 43005, targetHost: '127.0.0.1', targetPort: 3005 },
      { direction: 'local', listenHost: '0.0.0.0', listenPort: 18081, targetHost: 'localhost', targetPort: 48081 },
    ],
  });
  assert.deepEqual(args.slice(0, 5), [
    '-T',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
  ]);
  assert.deepEqual(
    args.slice(-6),
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
