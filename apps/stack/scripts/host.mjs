import './utils/env/env.mjs';

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import {
  readExecutionHostProfile,
  resolveExecutionHostProfilePath,
  writeCandidateExecutionHostProfile,
} from './utils/execution_host/config.mjs';
import { executeCandidateHostCommand, inspectExecutionHost } from './utils/execution_host/controller.mjs';
import {
  inspectExecutionHostCandidateMirror,
  pauseExecutionHostCandidateMirror,
  prepareExecutionHostCandidateRepository,
  readExecutionHostCandidateState,
  refreshExecutionHostCandidateRepository,
  syncExecutionHostCandidateMirror,
} from './utils/execution_host/candidate_repository.mjs';
import { createManagedLimaHostExecutor } from './utils/managed_lima/host_executor.mjs';
import { startManagedLimaInstance, stopManagedLimaInstance } from './utils/managed_lima/lifecycle.mjs';
import { setupManagedLimaRuntime } from './utils/managed_lima/manager.mjs';
import { getHappyStacksHomeDir } from './utils/paths/paths.mjs';
import { resolveNamedWorkspaceConfiguration } from './utils/execution_host/workspace_config.mjs';

function flagValue(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index >= 0 && index + 1 < argv.length && !argv[index + 1].startsWith('--')) return argv[index + 1];
  return '';
}

function usage(json) {
  printResult({
    json,
    data: { commands: ['setup', 'mirror', 'status', 'doctor', 'start', 'stop', 'shell', 'exec'] },
    text: [
      '[host] usage:',
      '  hstack host setup [--instance=happier-agent-primary] [--profile=balanced] [--workspace=ID=/absolute/source ...] [--json]',
      '  hstack host mirror [--workspace-id=ID] [--source-dir=/absolute/path/to/repo] [--json]',
      '  hstack host mirror status|sync|stop [--workspace-id=ID] [--json]',
      '  hstack host status|doctor|start|stop [--json]',
      '  hstack host shell [--guest-cwd=/absolute/path] [-- COMMAND...]',
      '  hstack host exec [--guest-cwd=/absolute/path] -- COMMAND [ARG...]',
      '',
      'Setup always writes activation=candidate. Ordinary hstack commands remain on macOS until the cutover owner activates it.',
    ].join('\n'),
  });
}

function workspaceIdForProfile(profile, argv) {
  const workspaceId = flagValue(argv, '--workspace-id').trim();
  if (profile.version !== 2) {
    if (workspaceId) throw new Error('[host] --workspace-id requires a named execution-host profile');
    return '';
  }
  if (!workspaceId) throw new Error('[host] named execution-host profiles require --workspace-id=ID');
  if (!profile.workspaces.some((workspace) => workspace.id === workspaceId)) {
    throw new Error(`[host] unknown execution-host workspace: ${workspaceId}`);
  }
  return workspaceId;
}

function executorFor(profile) {
  return createManagedLimaHostExecutor(
    { kind: 'local' },
    undefined,
    process.env,
    { hostEnvironment: { LIMA_HOME: profile.limaHome } },
  );
}

function plainStatus(result) {
  if (!result.configured) return '[host] execution host: not configured';
  return [
    `[host] activation: ${result.activation}`,
    `[host] authoritative: ${result.authoritative ? 'yes' : 'no'}`,
    `[host] VM status: ${result.doctor?.status ?? 'unknown'}`,
    `[host] doctor: ${result.doctor?.ok === true ? 'ok' : 'attention required'}`,
  ].join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const json = wantsJson(argv);
  const command = argv.find((arg) => !arg.startsWith('-')) ?? '';
  if (!command || command === 'help' || wantsHelp(argv)) return usage(json);

  if (command === 'setup') {
    const stackHome = getHappyStacksHomeDir(process.env);
    const runtimeConfig = {
      instance: flagValue(argv, '--instance').trim() || 'happier-agent-primary',
      limaHome: flagValue(argv, '--lima-home').trim() || join(stackHome, 'lima'),
      profile: flagValue(argv, '--profile').trim() || 'balanced',
    };
    const guestProvisionScriptSource = await readFile(
      new URL('./provision/linux-ubuntu-provision.sh', import.meta.url),
      'utf8',
    );
    const guestPressureScriptSource = await readFile(
      new URL('./provision/linux-guest-pressure.sh', import.meta.url),
      'utf8',
    );
    const pressureProfile = flagValue(argv, '--pressure-profile').trim() || 'none';
    const runtime = await setupManagedLimaRuntime({
      executor: executorFor(runtimeConfig),
      instance: runtimeConfig.instance,
      profileName: runtimeConfig.profile,
      allowInstall: !argv.includes('--no-install'),
      guestProvisionScriptSource,
      guestPressureScriptSource,
      pressureProfileName: pressureProfile,
    });
    const guestWorkspaceDir = flagValue(argv, '--guest-workspace-dir').trim()
      || join(runtime.guest.homeDir, '.happier-stack', 'workspace');
    const mirrorWorkspaceDir = flagValue(argv, '--mirror-workspace-dir').trim()
      || join(stackHome, 'workspace-mirror');
    const workspaces = resolveNamedWorkspaceConfiguration({
      argv,
      guestWorkspaceDir,
      mirrorWorkspaceDir,
    });
    const profile = {
      version: workspaces.length > 0 ? 2 : 1,
      mode: 'managed-lima',
      activation: 'candidate',
      ...runtimeConfig,
      pressureProfile,
      guestWorkspaceDir,
      mirrorWorkspaceDir,
      ...(workspaces.length > 0 ? {
        controllerEntrypoint: fileURLToPath(new URL('./execution_host_bridge.mjs', import.meta.url)),
        workspaces,
      } : {}),
    };
    const saved = await writeCandidateExecutionHostProfile(profile, process.env);
    return printResult({
      json,
      data: { profilePath: resolveExecutionHostProfilePath(process.env), profile: saved, runtime },
      text: `[host] candidate configured at ${resolveExecutionHostProfilePath(process.env)}\n[host] macOS remains authoritative`,
    });
  }

  const profile = readExecutionHostProfile(process.env);
  if (command === 'status' || command === 'doctor') {
    const inspected = profile
      ? await inspectExecutionHost({ profile, executor: executorFor(profile) })
      : await inspectExecutionHost({ profile: null });
    const candidateRepository = profile?.version === 2
      ? Object.fromEntries((await Promise.all(profile.workspaces.map(async (workspace) => [
        workspace.id,
        await readExecutionHostCandidateState(profile, process.env, workspace.id),
      ]))).filter(([, state]) => state))
      : await readExecutionHostCandidateState(profile, process.env);
    const result = candidateRepository ? { ...inspected, candidateRepository } : inspected;
    printResult({ json, data: result, text: plainStatus(result) });
    if (command === 'doctor' && profile && result.doctor?.ok !== true) process.exitCode = 1;
    return;
  }
  if (!profile) throw new Error('[host] execution host is not configured; run `hstack host setup` explicitly');
  const executor = executorFor(profile);
  if (command === 'mirror') {
    const workspaceId = workspaceIdForProfile(profile, argv);
    const mirrorArgument = argv[argv.indexOf(command) + 1] ?? '';
    const mirrorAction = mirrorArgument.startsWith('-') ? '' : mirrorArgument;
    if (mirrorAction === 'status') {
      const result = await inspectExecutionHostCandidateMirror({ profile, workspaceId, env: process.env });
      return printResult({
        json,
        data: result,
        text: `[host] candidate synchronization: ${result.status.state}`,
      });
    }
    if (mirrorAction === 'sync') {
      const result = await syncExecutionHostCandidateMirror({
        profile,
        workspaceId,
        env: process.env,
        executor,
      });
      return printResult({
        json,
        data: result,
        text: `[host] candidate synchronization: ${result.status.state}`,
      });
    }
    if (mirrorAction === 'stop') {
      const result = await pauseExecutionHostCandidateMirror({ profile, workspaceId, env: process.env });
      return printResult({
        json,
        data: result,
        text: `[host] candidate synchronization: ${result.paused ? 'paused' : 'not owned'}`,
      });
    }
    if (mirrorAction) throw new Error(`[host] unknown mirror command: ${mirrorAction}`);
    const existing = await readExecutionHostCandidateState(profile, process.env, workspaceId);
    const prepareOrRefresh = existing
      ? refreshExecutionHostCandidateRepository
      : prepareExecutionHostCandidateRepository;
    const configuredSourceDir = profile.version === 2
      ? profile.workspaces.find((workspace) => workspace.id === workspaceId).hostSourceDir
      : '';
    const explicitSourceDir = flagValue(argv, '--source-dir').trim();
    if (configuredSourceDir && explicitSourceDir && resolve(configuredSourceDir) !== resolve(explicitSourceDir)) {
      throw new Error(`[host] workspace ${workspaceId} source is configured as ${configuredSourceDir}`);
    }
    const result = await prepareOrRefresh({
      profile,
      workspaceId,
      sourceDir: configuredSourceDir || explicitSourceDir || process.cwd(),
      env: process.env,
      executor,
    });
    return printResult({
      json,
      data: result,
      text: [
        `[host] candidate repository prepared at ${result.guestRepositoryDir}`,
        '[host] continuous sync: macOS -> Linux candidate',
        '[host] authoritative: no (macOS remains authoritative)',
      ].join('\n'),
    });
  }
  if (command === 'start') {
    const result = await startManagedLimaInstance({ executor, instance: profile.instance });
    return printResult({ json, data: result, text: `[host] VM status: ${result.status}` });
  }
  if (command === 'stop') {
    const result = await stopManagedLimaInstance({ executor, instance: profile.instance });
    return printResult({ json, data: result, text: `[host] VM status: ${result.status}` });
  }
  if (command === 'shell' || command === 'exec') {
    const separator = argv.indexOf('--');
    const guestArgs = separator >= 0 ? argv.slice(separator + 1) : [];
    const executable = guestArgs[0] || (command === 'shell' ? 'bash' : '');
    if (!executable) throw new Error('[host] exec requires `-- COMMAND [ARG...]`');
    const result = await executeCandidateHostCommand({
      profile,
      executor,
      guestCwd: flagValue(argv, '--guest-cwd').trim() || profile.guestWorkspaceDir,
      command: executable,
      args: guestArgs.slice(1),
    });
    if (Number.isInteger(result?.exitCode) && result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }
  throw new Error(`[host] unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.message ?? error)}\n`);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
});
