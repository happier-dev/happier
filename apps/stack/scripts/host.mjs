import './utils/env/env.mjs';

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import {
  readExecutionHostProfile,
  activateExecutionHostProfile,
  configureExecutionHostWorkspaceMount,
  resolveExecutionHostSetupConfiguration,
  resolveExecutionHostProfilePath,
  writeCandidateExecutionHostProfile,
} from './utils/execution_host/config.mjs';
import { executeCandidateHostCommand, inspectExecutionHost } from './utils/execution_host/controller.mjs';
import {
  adoptLegacyExecutionHostCandidate,
  inspectExecutionHostCandidateRetirement,
  inspectExecutionHostCandidateMirror,
  pauseExecutionHostCandidateMirror,
  prepareExecutionHostCandidateRepository,
  readExecutionHostCandidateState,
  recoverExecutionHostCandidateRepository,
  refreshExecutionHostCandidateRepository,
  syncExecutionHostCandidateMirror,
} from './utils/execution_host/candidate_repository.mjs';
import { createManagedLimaHostExecutor } from './utils/managed_lima/host_executor.mjs';
import { startManagedLimaInstance, stopManagedLimaInstance } from './utils/managed_lima/lifecycle.mjs';
import { setupManagedLimaRuntime } from './utils/managed_lima/manager.mjs';
import { restartManagedLimaGuestAgent } from './utils/managed_lima/provisioner.mjs';
import { getHappyStacksHomeDir } from './utils/paths/paths.mjs';
import { resolveNamedWorkspaceConfiguration } from './utils/execution_host/workspace_config.mjs';
import {
  inspectExecutionHostWorkspaceMount,
  mountExecutionHostWorkspace,
  unmountExecutionHostWorkspace,
} from './utils/execution_host/workspace_mount.mjs';
import {
  createExecutionHostBackup,
  inspectExecutionHostBackup,
} from './utils/execution_host/backup.mjs';
import {
  installExecutionHostBackupSchedule,
  inspectExecutionHostBackupSchedule,
  removeExecutionHostBackupSchedule,
  runExecutionHostBackupSchedule,
} from './utils/execution_host/backup_schedule.mjs';
import {
  ensureExecutionHostServiceTunnel,
  inspectExecutionHostServiceTunnel,
  inspectExecutionHostServiceTunnels,
  stopExecutionHostServiceTunnel,
} from './utils/execution_host/service_tunnel.mjs';
import {
  installExecutionHostRecovery,
  inspectExecutionHostRecovery,
  removeExecutionHostRecovery,
  runExecutionHostRecovery,
} from './utils/execution_host/recovery.mjs';

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
    data: { commands: ['setup', 'activate', 'mirror', 'mount', 'unmount', 'backup', 'forward', 'recovery', 'status', 'doctor', 'start', 'stop', 'shell', 'exec'] },
    text: [
      '[dev-vm] usage:',
      '  hstack dev-vm setup [--instance=happier-agent-primary] [--profile=balanced] [--workspace=ID=/absolute/source ...] [--workspace-stack=ID=STACK_NAME ...] [--json]',
      '  hstack dev-vm activate [--json]',
      '  hstack dev-vm mirror [--workspace-id=ID] [--source-dir=/absolute/path/to/repo] [--json]',
      '  hstack dev-vm mirror status|sync|stop|adopt-legacy|recover [--workspace-id=ID] [--json]',
      '  hstack dev-vm status|doctor [--repair-forwarding] [--json]',
      '  hstack dev-vm start|stop [--json]',
      '  hstack dev-vm mount [status|enable|disable] [--mount-dir=/absolute/path] [--json]',
      '  hstack dev-vm unmount [--mount-dir=/absolute/path] [--json]',
      '  hstack dev-vm backup [status] [--stack=NAME] [--destination=/absolute/path] [--retention=1..30, default=3] [--json]',
      '  hstack dev-vm backup schedule enable --stacks=NAME,NAME --interval-hours=HOURS --destination-root=/absolute/path [--retention=1..30, default=3] [--json]',
      '  hstack dev-vm backup schedule status|disable [--json]',
      '  hstack dev-vm forward [status|reconcile|stop] [--workspace-id=ID] [--stack=NAME] [--json]',
      '  hstack dev-vm recovery enable|status|disable|run [--json]',
      '  hstack dev-vm shell [--guest-cwd=/absolute/path] [-- COMMAND...]',
      '  hstack dev-vm exec [--guest-cwd=/absolute/path] -- COMMAND [ARG...]',
      '  yarn -s dev-vm -- exec --guest-cwd=/absolute/path -- COMMAND [ARG...]',
      '',
      'Setup always writes activation=candidate. Ordinary hstack commands remain on macOS until the cutover owner activates it.',
    ].join('\n'),
  });
}

function workspaceIdForProfile(profile, argv) {
  const workspaceId = flagValue(argv, '--workspace-id').trim();
  if (profile.version !== 2) {
    if (workspaceId) throw new Error('[dev-vm] --workspace-id requires a named execution-host profile');
    return '';
  }
  if (!workspaceId) throw new Error('[dev-vm] named execution-host profiles require --workspace-id=ID');
  if (!profile.workspaces.some((workspace) => workspace.id === workspaceId)) {
    throw new Error(`[dev-vm] unknown execution-host workspace: ${workspaceId}`);
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
  if (!result.configured) return '[dev-vm] execution host: not configured';
  return [
    `[dev-vm] activation: ${result.activation}`,
    `[dev-vm] authoritative: ${result.authoritative ? 'yes' : 'no'}`,
    `[dev-vm] VM status: ${result.doctor?.status ?? 'unknown'}`,
    `[dev-vm] doctor: ${result.doctor?.ok === true ? 'ok' : 'attention required'}`,
    ...(result.mount ? [`[dev-vm] workspace mount: ${result.mount.health?.ok === true && result.mount.mounted ? 'mounted' : result.mount.health?.code ?? 'not mounted'}`] : []),
    ...(result.backup ? [`[dev-vm] backup schedule: ${result.backup.health?.code ?? 'unknown'} (${result.backup.stacks?.length ?? 0} configured Stack${result.backup.stacks?.length === 1 ? '' : 's'})`] : []),
    ...(result.serviceTunnels ? [`[dev-vm] service forwards: ${result.serviceTunnels.map((tunnel) => tunnel.status).join(', ') || 'none'}`] : []),
    ...(result.candidateRetirement ? [`[dev-vm] candidate mirror retirement: ${result.candidateRetirement.state}`] : []),
  ].join('\n');
}

function backupScheduleStackNames(argv) {
  const raw = flagValue(argv, '--stacks');
  return raw.split(',').map((value) => value.trim());
}

function backupScheduleProgramArgs() {
  // The globally installed hstack shim may intentionally belong to another
  // development stack version. Keep the scheduled job bound to the same
  // repo-local controller that enabled it.
  return [process.execPath, fileURLToPath(import.meta.url), 'backup', 'schedule', 'run', '--json'];
}

function recoveryProgramArgs() {
  // Bind launchd to this checkout's controller rather than a possibly older
  // globally installed hstack shim.
  return [process.execPath, fileURLToPath(import.meta.url), 'recovery', 'run', '--json'];
}

async function main() {
  const argv = process.argv.slice(2);
  const json = wantsJson(argv);
  const command = argv.find((arg) => !arg.startsWith('-')) ?? '';
  if (!command || command === 'help' || wantsHelp(argv)) return usage(json);

  if (command === 'setup') {
    const stackHome = getHappyStacksHomeDir(process.env);
    const current = readExecutionHostProfile(process.env);
    const requested = {
      instance: flagValue(argv, '--instance').trim(),
      limaHome: flagValue(argv, '--lima-home').trim(),
      profile: flagValue(argv, '--profile').trim(),
      pressureProfile: flagValue(argv, '--pressure-profile').trim(),
      guestWorkspaceDir: flagValue(argv, '--guest-workspace-dir').trim(),
      mirrorWorkspaceDir: flagValue(argv, '--mirror-workspace-dir').trim(),
    };
    const selected = resolveExecutionHostSetupConfiguration({
      current,
      requested,
      defaults: {
        instance: 'happier-agent-primary',
        limaHome: join(stackHome, 'lima'),
        profile: 'balanced',
        pressureProfile: 'none',
        mirrorWorkspaceDir: join(stackHome, 'workspace-mirror'),
      },
    });
    const runtimeConfig = {
      instance: selected.instance,
      limaHome: selected.limaHome,
      profile: selected.profile,
    };
    const guestProvisionScriptSource = await readFile(
      new URL('./provision/linux-ubuntu-provision.sh', import.meta.url),
      'utf8',
    );
    const guestPressureScriptSource = await readFile(
      new URL('./provision/linux-guest-pressure.sh', import.meta.url),
      'utf8',
    );
    const pressureProfile = selected.pressureProfile;
    const runtime = await setupManagedLimaRuntime({
      executor: executorFor(runtimeConfig),
      instance: runtimeConfig.instance,
      profileName: runtimeConfig.profile,
      allowInstall: !argv.includes('--no-install'),
      guestProvisionScriptSource,
      guestPressureScriptSource,
      pressureProfileName: pressureProfile,
    });
    const guestWorkspaceDir = selected.guestWorkspaceDir
      || join(runtime.guest.homeDir, '.happier-stack', 'workspace');
    const mirrorWorkspaceDir = selected.mirrorWorkspaceDir;
    const requestedWorkspaces = resolveNamedWorkspaceConfiguration({
      argv,
      guestWorkspaceDir,
      mirrorWorkspaceDir,
    });
    const { workspaces } = resolveExecutionHostSetupConfiguration({
      current,
      requested: { ...requested, workspaces: requestedWorkspaces },
      defaults: {
        ...runtimeConfig,
        pressureProfile,
        guestWorkspaceDir,
        mirrorWorkspaceDir,
        workspaces: [],
      },
    });
    const profile = {
      version: workspaces.length > 0 ? 2 : 1,
      mode: 'managed-lima',
      activation: 'candidate',
      ...runtimeConfig,
      pressureProfile,
      guestWorkspaceDir,
      mirrorWorkspaceDir,
      ...(selected.autoMount != null ? { autoMount: selected.autoMount } : {}),
      ...(selected.hostMountDir != null ? { hostMountDir: selected.hostMountDir } : {}),
      ...(workspaces.length > 0 ? {
        controllerEntrypoint: fileURLToPath(new URL('./execution_host_bridge.mjs', import.meta.url)),
        workspaces,
      } : {}),
    };
    const saved = await writeCandidateExecutionHostProfile(profile, process.env);
    return printResult({
      json,
      data: { profilePath: resolveExecutionHostProfilePath(process.env), profile: saved, runtime },
      text: `[dev-vm] candidate configured at ${resolveExecutionHostProfilePath(process.env)}\n[dev-vm] macOS remains authoritative`,
    });
  }

  const profile = readExecutionHostProfile(process.env);
  if (command === 'status' || command === 'doctor') {
    const repairForwarding = command === 'doctor' && argv.includes('--repair-forwarding');
    if (argv.includes('--repair-forwarding') && !repairForwarding) {
      throw new Error('[dev-vm] --repair-forwarding is only supported by `hstack dev-vm doctor`');
    }
    if (repairForwarding && !profile) {
      throw new Error('[dev-vm] --repair-forwarding requires a configured execution host');
    }
    const forwardingRepair = repairForwarding
      ? await restartManagedLimaGuestAgent({ executor: executorFor(profile), instance: profile.instance })
      : null;
    const inspected = profile
      ? await inspectExecutionHost({ profile, executor: executorFor(profile) })
      : await inspectExecutionHost({ profile: null });
    const candidateRepository = profile?.activation === 'candidate'
      ? profile.version === 2
        ? Object.fromEntries((await Promise.all(profile.workspaces.map(async (workspace) => [
          workspace.id,
          await readExecutionHostCandidateState(profile, process.env, workspace.id),
        ]))).filter(([, state]) => state))
        : await readExecutionHostCandidateState(profile, process.env)
      : null;
    const candidateRetirement = profile?.activation === 'active'
      ? await inspectExecutionHostCandidateRetirement({ profile, env: process.env })
      : null;
    const [mount, backup, serviceTunnels] = profile
      ? await Promise.all([
        inspectExecutionHostWorkspaceMount({ profile, env: process.env, mountDir: profile.hostMountDir || '' }),
        inspectExecutionHostBackupSchedule({ profile, env: process.env }),
        inspectExecutionHostServiceTunnels({ profile, env: process.env }),
      ])
      : [null, null, null];
    const result = {
      ...inspected,
      ...(forwardingRepair ? { forwardingRepair } : {}),
      ...(candidateRepository ? { candidateRepository } : {}),
      ...(candidateRetirement ? { candidateRetirement } : {}),
      ...(mount ? { mount } : {}),
      ...(backup ? { backup } : {}),
      ...(serviceTunnels ? { serviceTunnels } : {}),
    };
    printResult({ json, data: result, text: plainStatus(result) });
    if (command === 'doctor' && profile && (
      result.doctor?.ok !== true || result.mount?.health?.ok !== true || result.backup?.health?.ok !== true
      || result.serviceTunnels?.some((tunnel) => tunnel.healthy !== true)
      || result.candidateRetirement?.state === 'attention-required'
    )) process.exitCode = 1;
    return;
  }
  if (!profile) throw new Error('[dev-vm] execution host is not configured; run `hstack dev-vm setup` explicitly');
  if (command === 'activate') {
    const result = await activateExecutionHostProfile(process.env);
    return printResult({
      json,
      data: result,
      text: `[dev-vm] execution host activated; candidate mirrors retired: ${result.retiredCandidateMirrors.length}`,
    });
  }
  const executor = executorFor(profile);
  if (command === 'recovery') {
    const recoveryArgument = argv[argv.indexOf(command) + 1] ?? '';
    const recoveryAction = recoveryArgument.startsWith('-') ? 'status' : recoveryArgument || 'status';
    if (!['enable', 'status', 'disable', 'run'].includes(recoveryAction)) {
      throw new Error(`[dev-vm] unknown recovery command: ${recoveryAction}`);
    }
    const result = recoveryAction === 'enable'
      ? await installExecutionHostRecovery({
        profile,
        env: process.env,
        programArgs: recoveryProgramArgs(),
      })
      : recoveryAction === 'disable'
        ? await removeExecutionHostRecovery({ profile, env: process.env })
        : recoveryAction === 'run'
          ? await runExecutionHostRecovery({ profile, executor, env: process.env })
          : await inspectExecutionHostRecovery({ profile, env: process.env });
    const logs = result.paths
      ? `\n[dev-vm] logs: ${result.paths.stdoutPath} (stdout), ${result.paths.stderrPath} (stderr)`
      : '';
    printResult({
      json,
      data: result,
      text: recoveryAction === 'enable'
        ? `[dev-vm] login recovery enabled; it will reconcile at the next macOS login${logs}`
        : recoveryAction === 'disable'
          ? `[dev-vm] login recovery disabled${logs}`
          : `[dev-vm] login recovery: ${result.health?.code ?? 'unknown'}${logs}`,
    });
    if (recoveryAction === 'run' && result.health?.ok !== true) process.exitCode = 1;
    return;
  }
  if (command === 'mount' || command === 'unmount') {
    const mountDir = flagValue(argv, '--mount-dir').trim();
    const mountArgument = argv[argv.indexOf(command) + 1] ?? '';
    const mountAction = mountArgument.startsWith('-') ? '' : mountArgument;
    if (mountAction && !['status', 'enable', 'disable'].includes(mountAction)) {
      throw new Error(`[dev-vm] unknown mount command: ${mountAction}`);
    }
    const requestedMountDir = mountDir || profile.hostMountDir || '';
    const result = command === 'unmount' || mountAction === 'disable'
      ? await unmountExecutionHostWorkspace({ profile, env: process.env, mountDir: requestedMountDir })
      : mountAction === 'status'
        ? await inspectExecutionHostWorkspaceMount({ profile, env: process.env, mountDir: requestedMountDir })
        : await mountExecutionHostWorkspace({ profile, env: process.env, mountDir: requestedMountDir, executor });
    if (mountAction === 'enable' || mountAction === 'disable') {
      await configureExecutionHostWorkspaceMount({
        enabled: mountAction === 'enable',
        mountDir: result.mountDir,
      }, process.env);
    }
    return printResult({
      json,
      data: {
        ...result,
        autoMount: mountAction === 'enable' ? true : mountAction === 'disable' ? false : profile.autoMount === true,
      },
      text: `[dev-vm] workspace mount: ${result.health?.ok === true && result.mounted ? 'mounted' : result.health?.code ?? 'not mounted'}\n[dev-vm] path: ${result.mountDir}`,
    });
  }
  if (command === 'backup') {
    const backupArgument = argv[argv.indexOf(command) + 1] ?? '';
    const backupAction = backupArgument.startsWith('-') ? '' : backupArgument;
    if (backupAction && !['status', 'schedule'].includes(backupAction)) throw new Error(`[dev-vm] unknown backup command: ${backupAction}`);
    if (backupAction === 'schedule') {
      const scheduleArgument = argv[argv.indexOf(command) + 2] ?? '';
      const scheduleAction = scheduleArgument.startsWith('-') ? '' : scheduleArgument;
      if (!['enable', 'status', 'disable', 'run'].includes(scheduleAction)) {
        throw new Error(`[dev-vm] unknown backup schedule command: ${scheduleAction || '(missing)'}`);
      }
      const result = scheduleAction === 'enable'
        ? await installExecutionHostBackupSchedule({
          profile,
          env: process.env,
          programArgs: backupScheduleProgramArgs(),
          stackNames: backupScheduleStackNames(argv),
          destinationRoot: flagValue(argv, '--destination-root').trim(),
          intervalHours: flagValue(argv, '--interval-hours').trim(),
          retention: flagValue(argv, '--retention').trim() || undefined,
        })
        : scheduleAction === 'disable'
          ? await removeExecutionHostBackupSchedule({ profile, env: process.env })
          : scheduleAction === 'run'
            ? await runExecutionHostBackupSchedule({ profile, executor, env: process.env })
            : await inspectExecutionHostBackupSchedule({ profile, env: process.env });
      const logs = result.paths ? `\n[dev-vm] logs: ${result.paths.stdoutPath} (stdout), ${result.paths.stderrPath} (stderr)` : '';
      const failures = Array.isArray(result.stacks)
        ? result.stacks.filter((stack) => stack.health?.ok === false && stack.error).map((stack) => `\n[dev-vm] ${stack.stackName} failed: ${stack.error}`).join('')
        : '';
      printResult({
        json,
        data: result,
        text: scheduleAction === 'enable'
          ? `[dev-vm] backup schedule enabled\n[dev-vm] destination root: ${result.schedule.destinationRoot}${logs}`
          : scheduleAction === 'disable'
            ? `[dev-vm] backup schedule disabled${logs}`
            : `[dev-vm] backup schedule: ${result.health?.code ?? 'unknown'}${logs}${failures}`,
      });
      if (scheduleAction === 'run' && result.health?.ok !== true) process.exitCode = 1;
      return;
    }
    const options = {
      profile,
      env: process.env,
      stackName: flagValue(argv, '--stack').trim() || 'main',
      destination: flagValue(argv, '--destination').trim(),
    };
    const result = backupAction === 'status'
      ? await inspectExecutionHostBackup(options)
      : await createExecutionHostBackup({
        ...options,
        executor,
        retention: flagValue(argv, '--retention').trim() || undefined,
      });
    return printResult({
      json,
      data: result,
      text: backupAction === 'status'
        ? `[dev-vm] backup: ${result.health.code}\n[dev-vm] destination: ${result.destination}`
        : `[dev-vm] backup: complete\n[dev-vm] destination: ${result.destination}`,
    });
  }
  if (command === 'forward') {
    const forwardArgument = argv[argv.indexOf(command) + 1] ?? '';
    const forwardAction = forwardArgument.startsWith('-') ? 'reconcile' : forwardArgument || 'reconcile';
    if (!['status', 'reconcile', 'stop'].includes(forwardAction)) {
      throw new Error(`[dev-vm] unknown forward command: ${forwardAction}`);
    }
    const workspaceId = workspaceIdForProfile(profile, argv);
    const options = {
      profile,
      workspaceId,
      env: process.env,
      stackName: flagValue(argv, '--stack').trim(),
    };
    const result = forwardAction === 'status'
      ? await inspectExecutionHostServiceTunnel(options)
      : forwardAction === 'stop'
        ? await stopExecutionHostServiceTunnel(options)
        : await ensureExecutionHostServiceTunnel({ ...options, executor });
    return printResult({
      json,
      data: result,
      text: `[dev-vm] service forward: ${result.status ?? result.reason ?? 'running'}`,
    });
  }
  if (command === 'mirror') {
    const workspaceId = workspaceIdForProfile(profile, argv);
    const configuredSourceDir = profile.version === 2
      ? profile.workspaces.find((workspace) => workspace.id === workspaceId).hostSourceDir
      : '';
    const explicitSourceDir = flagValue(argv, '--source-dir').trim();
    if (configuredSourceDir && explicitSourceDir && resolve(configuredSourceDir) !== resolve(explicitSourceDir)) {
      throw new Error(`[dev-vm] workspace ${workspaceId} source is configured as ${configuredSourceDir}`);
    }
    const sourceDir = configuredSourceDir || explicitSourceDir || process.cwd();
    const mirrorArgument = argv[argv.indexOf(command) + 1] ?? '';
    const mirrorAction = mirrorArgument.startsWith('-') ? '' : mirrorArgument;
    if (mirrorAction === 'status') {
      const result = await inspectExecutionHostCandidateMirror({ profile, workspaceId, env: process.env });
      return printResult({
        json,
        data: result,
        text: `[dev-vm] candidate synchronization: ${result.status.state}`,
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
        text: `[dev-vm] candidate synchronization: ${result.status.state}`,
      });
    }
    if (mirrorAction === 'stop') {
      const result = await pauseExecutionHostCandidateMirror({ profile, workspaceId, env: process.env });
      return printResult({
        json,
        data: result,
        text: `[dev-vm] candidate synchronization: ${result.paused ? 'paused' : 'not owned'}`,
      });
    }
    if (mirrorAction === 'adopt-legacy') {
      const result = await adoptLegacyExecutionHostCandidate({
        profile,
        workspaceId,
        env: process.env,
        executor,
      });
      return printResult({
        json,
        data: result,
        text: `[dev-vm] legacy candidate adopted as workspace ${workspaceId}`,
      });
    }
    if (mirrorAction === 'recover') {
      const result = await recoverExecutionHostCandidateRepository({
        profile,
        workspaceId,
        sourceDir,
        env: process.env,
        executor,
      });
      return printResult({
        json,
        data: result,
        text: `[dev-vm] candidate workspace ${workspaceId || 'default'} recovered`,
      });
    }
    if (mirrorAction) throw new Error(`[dev-vm] unknown mirror command: ${mirrorAction}`);
    const existing = await readExecutionHostCandidateState(profile, process.env, workspaceId);
    const prepareOrRefresh = existing
      ? refreshExecutionHostCandidateRepository
      : prepareExecutionHostCandidateRepository;
    const result = await prepareOrRefresh({
      profile,
      workspaceId,
      sourceDir,
      env: process.env,
      executor,
    });
    return printResult({
      json,
      data: result,
      text: [
        `[dev-vm] candidate repository prepared at ${result.guestRepositoryDir}`,
        '[dev-vm] continuous sync: macOS -> Linux candidate',
        '[dev-vm] authoritative: no (macOS remains authoritative)',
      ].join('\n'),
    });
  }
  if (command === 'start') {
    const result = await startManagedLimaInstance({ executor, instance: profile.instance });
    const requestedWorkspace = flagValue(argv, '--workspace-id').trim();
    const serviceTunnel = (profile.version !== 2 || requestedWorkspace)
      ? await ensureExecutionHostServiceTunnel({
        profile,
        workspaceId: workspaceIdForProfile(profile, argv),
        stackName: flagValue(argv, '--stack').trim(),
        executor,
        env: process.env,
      })
      : null;
    if (profile.autoMount === true) {
      await mountExecutionHostWorkspace({ profile, env: process.env, mountDir: profile.hostMountDir || '', executor });
    }
    return printResult({ json, data: { ...result, ...(serviceTunnel ? { serviceTunnel } : {}) }, text: `[dev-vm] VM status: ${result.status}` });
  }
  if (command === 'stop') {
    const workspaceIds = profile.version === 2 ? profile.workspaces.map((workspace) => workspace.id) : [''];
    const serviceTunnels = [];
    for (const workspaceId of workspaceIds) {
      // eslint-disable-next-line no-await-in-loop
      serviceTunnels.push(await stopExecutionHostServiceTunnel({ profile, workspaceId, env: process.env }));
    }
    await unmountExecutionHostWorkspace({ profile, env: process.env, mountDir: profile.hostMountDir || '' });
    const result = await stopManagedLimaInstance({ executor, instance: profile.instance });
    return printResult({ json, data: { ...result, serviceTunnels }, text: `[dev-vm] VM status: ${result.status}` });
  }
  if (command === 'shell' || command === 'exec') {
    const separator = argv.indexOf('--');
    const guestArgs = separator >= 0 ? argv.slice(separator + 1) : [];
    const executable = guestArgs[0] || (command === 'shell' ? 'bash' : '');
    if (!executable) throw new Error('[dev-vm] exec requires `-- COMMAND [ARG...]`');
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
  throw new Error(`[dev-vm] unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.message ?? error)}\n`);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
});
