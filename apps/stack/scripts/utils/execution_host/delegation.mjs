import { spawn } from 'node:child_process';
import { isAbsolute, relative, resolve, posix } from 'node:path';

import { createManagedLimaHostExecutor } from '../managed_lima/host_executor.mjs';
import { startManagedLimaInstance } from '../managed_lima/lifecycle.mjs';
import { doctorManagedLimaInstance } from '../managed_lima/manager.mjs';
import { parseArgs } from '../cli/args.mjs';
import { inferTuiStackName } from '../tui/args.mjs';
import { mountExecutionHostWorkspace } from './workspace_mount.mjs';
import { ensureExecutionHostServiceTunnel, superviseExecutionHostServiceTunnel } from './service_tunnel.mjs';

function defaultBoundary() {
  return {
    spawn(command, args, options) {
      return spawn(command, args, options);
    },
    onSignal(handler) {
      const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
      for (const signal of signals) process.on(signal, handler);
      return () => {
        for (const signal of signals) process.off(signal, handler);
      };
    },
    reportWarning(message) {
      process.stderr.write(`${message}\n`);
    },
  };
}

function relativeInside(parent, candidate) {
  const suffix = relative(resolve(parent), resolve(candidate));
  if (suffix === '') return '';
  if (suffix === '..' || suffix.startsWith(`..${posix.sep}`) || isAbsolute(suffix)) return null;
  return suffix;
}

function resolveDelegatedStackName(argv, env, workspace) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  const separatorIndex = args.indexOf('--');
  const commandArgs = separatorIndex < 0 ? args : args.slice(0, separatorIndex);
  const explicit = String(parseArgs(commandArgs).kv.get('--stack') ?? '').trim();
  const fromEnvironment = String(env.HAPPIER_STACK_STACK ?? '').trim();
  const commandIndex = commandArgs.findIndex((arg) => !arg.startsWith('-'));
  const command = commandIndex < 0 ? '' : commandArgs[commandIndex];
  let stackName = explicit;
  if (!stackName && command === 'tui') {
    stackName = inferTuiStackName(commandArgs.slice(commandIndex + 1), {}) ?? '';
  }
  if (!stackName && command === 'stack') {
    const positionals = commandArgs.slice(commandIndex + 1).filter((arg) => !arg.startsWith('-'));
    stackName = String(positionals[1] ?? '').trim();
  }
  if (!stackName) stackName = String(workspace?.stackName ?? '').trim();
  if (!stackName) stackName = fromEnvironment;
  if (!stackName && command === 'dev-targets') stackName = 'main';
  if (/[\0\r\n]/.test(stackName)) {
    throw new Error('[execution-host] stack name contains unsupported control characters');
  }
  return stackName;
}

function startsGuestStackServices(argv) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  const separatorIndex = args.indexOf('--');
  const commandArgs = separatorIndex < 0 ? args : args.slice(0, separatorIndex);
  const positionals = commandArgs.filter((arg) => !arg.startsWith('-'));
  if (['tui', 'start', 'dev'].includes(positionals[0])) return true;
  return positionals[0] === 'stack' && ['start', 'dev'].includes(positionals[1]);
}

async function reconcileManagedHostAfterStart({ profile, workspaceId, stackName, signal, env }) {
  const executor = createManagedLimaHostExecutor(
    { kind: 'local' },
    undefined,
    env,
    { hostEnvironment: { LIMA_HOME: profile.limaHome } },
  );
  return await superviseExecutionHostServiceTunnel({
    profile,
    workspaceId,
    stackName,
    executor,
    env,
    signal,
  });
}

export function mapHostCwdToGuest(profile, hostCwd) {
  if (profile.version === 2) {
    return resolveHostWorkspaceMapping(profile, hostCwd).guestCwd;
  }
  const mirror = resolve(profile.mirrorWorkspaceDir);
  const cwd = resolve(String(hostCwd ?? ''));
  const suffix = relativeInside(mirror, cwd);
  return suffix != null
    ? posix.join(profile.guestWorkspaceDir, ...suffix.split('/').filter(Boolean))
    : profile.guestWorkspaceDir;
}

export function resolveHostWorkspaceMapping(profile, hostCwd) {
  if (profile?.version !== 2 || !Array.isArray(profile.workspaces)) {
    throw new Error('[execution-host] named execution-host profile is required');
  }
  const cwd = resolve(String(hostCwd ?? ''));
  for (const workspace of profile.workspaces) {
    for (const hostRoot of [workspace.hostSourceDir, workspace.hostMirrorDir]) {
      const suffix = relativeInside(hostRoot, cwd);
      if (suffix != null) {
        return {
          workspace,
          guestCwd: posix.join(workspace.guestDir, ...suffix.split('/').filter(Boolean)),
        };
      }
    }
  }
  throw new Error(`[execution-host] host cwd does not belong to a configured execution-host workspace: ${cwd}`);
}

function isPendingLegacyServiceForwardCutover(diagnosis) {
  const drift = diagnosis?.drift;
  if (String(diagnosis?.status ?? '').toLowerCase() !== 'running') return false;
  if (diagnosis?.guestLoginManager?.ok === false || diagnosis?.guestToolchain?.ok === false) return false;
  if (drift?.creation?.length !== 0 || drift?.resources?.length !== 0 || drift?.configuration?.length !== 1) return false;
  const entry = drift.configuration[0];
  if (entry?.field !== 'portForwards' || entry?.expected?.length !== 0 || entry?.actual?.length !== 3) return false;
  const selected = entry.actual.map((forward) => ({
    guestIPMustBeZero: forward.guestIPMustBeZero,
    guestIP: forward.guestIP,
    guestPortRange: forward.guestPortRange,
    hostIP: forward.hostIP,
    hostPortRange: forward.hostPortRange,
    proto: forward.proto,
    ...(forward.ignore === true ? { ignore: true } : {}),
  }));
  return JSON.stringify(selected) === JSON.stringify([
    {
      guestIPMustBeZero: false,
      guestIP: '127.0.0.1',
      guestPortRange: [52005, 54004],
      hostIP: '0.0.0.0',
      hostPortRange: [52005, 54004],
      proto: 'any',
    },
    {
      guestIPMustBeZero: false,
      guestIP: '127.0.0.1',
      guestPortRange: [18081, 20080],
      hostIP: '0.0.0.0',
      hostPortRange: [18081, 20080],
      proto: 'any',
    },
    {
      guestIPMustBeZero: false,
      guestIP: '0.0.0.0',
      guestPortRange: [1, 65535],
      hostIP: '127.0.0.1',
      hostPortRange: [1, 65535],
      proto: 'any',
      ignore: true,
    },
  ]);
}

export async function prepareManagedHost(profile, dependencies = {}) {
  const executor = dependencies.executor ?? createManagedLimaHostExecutor(
    { kind: 'local' },
    undefined,
    process.env,
    { hostEnvironment: { LIMA_HOME: profile.limaHome } },
  );
  const start = dependencies.start ?? startManagedLimaInstance;
  const doctor = dependencies.doctor ?? doctorManagedLimaInstance;
  const reconcileServiceTunnel = dependencies.reconcileServiceTunnel ?? ensureExecutionHostServiceTunnel;
  const mount = dependencies.mount ?? mountExecutionHostWorkspace;
  await start({ executor, instance: profile.instance });
  const diagnosis = await doctor({
    executor,
    instance: profile.instance,
    profileName: profile.profile,
  });
  const pendingLegacyServiceForwardCutover = diagnosis.ok !== true
    && isPendingLegacyServiceForwardCutover(diagnosis);
  if (diagnosis.ok !== true && !pendingLegacyServiceForwardCutover) {
    throw new Error('[execution-host] managed Lima doctor reported drift; run `hstack dev-vm doctor` before execution');
  }
  const workspaceId = String(dependencies.workspaceId ?? '').trim();
  const stackName = String(dependencies.stackName ?? '').trim();
  const requiresServiceTunnel = dependencies.requiresServiceTunnel !== false;
  // A named profile can host several guest workspaces with overlapping service
  // ports. The caller that chose a guest workspace is the only safe place to
  // select which Stack declaration receives the host SSH transport.
  if (!pendingLegacyServiceForwardCutover && (profile.version !== 2 || workspaceId)) {
    try {
      await reconcileServiceTunnel({ profile, workspaceId, stackName, executor, env: process.env });
    } catch (error) {
      if (requiresServiceTunnel) throw error;
      dependencies.reportWarning?.(
        `[dev-vm] host service tunnel could not be reconciled; continuing delegated command without host service access: ${error?.message ?? error}`,
      );
    }
  }
  if (profile.autoMount === true) {
    await mount({
      profile,
      env: process.env,
      mountDir: profile.hostMountDir || '',
      executor,
    });
  }
}

export async function runDelegatedHstackCommand({
  profile,
  argv,
  cwd = process.cwd(),
  env = process.env,
  prepare = prepareManagedHost,
  reconcileAfterStart = null,
  boundary = defaultBoundary(),
  guestInvocation = null,
}) {
  const mapping = profile.version === 2 ? resolveHostWorkspaceMapping(profile, cwd) : null;
  const stackName = resolveDelegatedStackName(argv, env, mapping?.workspace);
  const preparation = {
    workspaceId: mapping?.workspace.id ?? '',
    stackName,
    requiresServiceTunnel: startsGuestStackServices(argv),
  };
  if (typeof boundary.reportWarning === 'function') preparation.reportWarning = boundary.reportWarning;
  await prepare(profile, preparation);
  const guestCwd = mapping?.guestCwd ?? mapHostCwdToGuest(profile, cwd);
  const invocation = guestInvocation ?? (mapping
    ? {
        command: 'node',
        args: [posix.join(mapping.workspace.guestDir, 'apps', 'stack', 'scripts', 'repo_local.mjs')],
      }
    : { command: 'hstack', args: [] });
  const command = argv.find((arg) => !String(arg).startsWith('-'));
  const delegatedArgv = command === 'tui' && !argv.includes('--rescue')
    ? [...argv, '--rescue']
    : argv;
  const child = boundary.spawn('limactl', [
    'shell', '--workdir', guestCwd, profile.instance, '--',
    'env',
    'HAPPIER_STACK_EXECUTION_HOST_REENTRY=1',
    `HAPPIER_STACK_INVOKED_CWD=${guestCwd}`,
    ...(stackName ? [`HAPPIER_STACK_STACK=${stackName}`] : []),
    invocation.command, ...(invocation.args ?? []), ...delegatedArgv,
  ], {
    cwd,
    env: { ...env, LIMA_HOME: profile.limaHome },
    stdio: 'inherit',
    shell: false,
  });
  const reconciliationController = new AbortController();
  const postStartReconciler = reconcileAfterStart
    ?? (prepare === prepareManagedHost ? reconcileManagedHostAfterStart : null);
  const reconciliation = startsGuestStackServices(argv) && postStartReconciler
    ? Promise.resolve(postStartReconciler({
        profile,
        workspaceId: mapping?.workspace.id ?? '',
        stackName,
        signal: reconciliationController.signal,
        env,
      })).catch((error) => {
        boundary.reportWarning?.(
          `[dev-vm] delegated Stack started, but its host service tunnel could not be reconciled: ${error?.message ?? error}`,
        );
        return { status: 'failed', error };
      })
    : Promise.resolve({ status: 'not_requested' });
  const removeSignalHandlers = boundary.onSignal((signal) => {
    try {
      child.kill(signal);
    } catch {
      // The delegated process may already have reached its terminal state.
    }
  });
  try {
    return await new Promise((resolvePromise, rejectPromise) => {
      child.once('error', rejectPromise);
      child.once('close', (exitCode, signal) => resolvePromise({ exitCode, signal }));
    });
  } finally {
    reconciliationController.abort();
    await reconciliation;
    removeSignalHandlers();
  }
}
