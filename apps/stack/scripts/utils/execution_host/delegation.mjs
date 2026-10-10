import { spawn } from 'node:child_process';
import { isAbsolute, relative, resolve, posix } from 'node:path';

import { createManagedLimaHostExecutor } from '../managed_lima/host_executor.mjs';
import { startManagedLimaInstance } from '../managed_lima/lifecycle.mjs';
import { doctorManagedLimaInstance } from '../managed_lima/manager.mjs';
import { resolveManagedLimaCapacityResources } from '../managed_lima/capacity.mjs';
import { parseArgs } from '../cli/args.mjs';
import { inferTuiStackName } from '../tui/args.mjs';
import { mountExecutionHostWorkspace, superviseExecutionHostWorkspaceMount } from './workspace_mount.mjs';
import { ensureExecutionHostServiceTunnel, superviseExecutionHostServiceTunnel } from './service_tunnel.mjs';
import { resolveSshPrimaryTarget } from './primary.mjs';
import { buildSshWorkerArgs, posixQuote, prependRemotePath } from '../dev_targets/remote_commands.mjs';
import { runDevTargetSshProcess } from '../dev_targets/ssh_transport.mjs';
import { runCaptureResult } from '../proc/proc.mjs';

let delegatedCommandSequence = 0;

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

function executionHostExecutor(profile, env, boundary) {
  if (profile.mode === 'ssh-dev-target') {
    return { capture: boundary?.capture?.bind(boundary) ?? ((command, args, options = {}) => runCaptureResult(command, args, { env, ...options })) };
  }
  return createManagedLimaHostExecutor(
    { kind: 'local' }, undefined, env, { hostEnvironment: { LIMA_HOME: profile.limaHome } },
  );
}

async function reconcileExecutionHostAfterStart({
  profile,
  workspaceId,
  stackName,
  signal,
  env,
  previousRuntimeStartedAt,
  executor,
}) {
  const sshPrimary = profile.mode === 'ssh-dev-target';
  const selectedExecutor = executor ?? executionHostExecutor(profile, env);
  const workspaces = sshPrimary ? profile.workspaces : [{ id: workspaceId, stackName }];
  const supervision = workspaces.map(workspace => superviseExecutionHostServiceTunnel({
    profile, workspaceId: workspace.id,
    stackName: workspace.id === workspaceId ? stackName : workspace.stackName,
    executor: selectedExecutor, env, signal,
    ...(sshPrimary ? {} : { previousRuntimeStartedAt }),
  }));
  const tunnel = sshPrimary ? Promise.all(supervision) : supervision[0];
  if (profile.autoMount !== true) return await tunnel;
  const mount = superviseExecutionHostWorkspaceMount({
    profile,
    env,
    mountDir: sshPrimary ? '' : profile.hostMountDir || '',
    executor: selectedExecutor,
    signal,
  });
  const [tunnelResult] = await Promise.all([tunnel, mount]);
  return tunnelResult;
}

async function prepareSshHost(profile, { workspaceId, stackName, env, executor, reportWarning }) {
  for (const workspace of profile.workspaces) {
    try {
      // The same controller serves both named checkouts. Keep their declared
      // service addresses available even when only one TUI is open.
      await ensureExecutionHostServiceTunnel({ profile, workspaceId: workspace.id,
        stackName: workspace.id === workspaceId ? stackName : workspace.stackName, executor, env });
    } catch (error) {
      if (error.code !== 'EXECUTION_HOST_SERVICE_TUNNEL_PORT_CONFLICT') throw error;
      reportWarning?.(`${error.message}; existing listener left in place. Release the manual tunnel to enable supervised forwarding.`);
    }
  }
  if (profile.autoMount === true) await mountExecutionHostWorkspace({ profile, env, executor });
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

export function assertManagedHostExecutionReady(profile, diagnosis, reportWarning = defaultBoundary().reportWarning) {
  // Full provisioning compliance is not a prerequisite for controlling an
  // already-active guest. Keep using its current capacity and toolchain until
  // the operator explicitly applies updates; individual commands own their
  // actual tool requirements. Creation identity and security configuration
  // still fail closed, as does unavailable guest session management.
  const canRetainRunningHost = profile.activation === 'active'
    && diagnosis.exists === true
    && String(diagnosis.status ?? '').toLowerCase() === 'running'
    && diagnosis.guestLoginManager?.ok === true
    && diagnosis.drift?.creation?.length === 0
    && diagnosis.drift?.configuration?.length === 0
    && Array.isArray(diagnosis.drift?.resources)
    && (diagnosis.drift.resources.length > 0 || diagnosis.guestToolchain?.ok === false);
  if (diagnosis.ok !== true && !canRetainRunningHost) {
    throw new Error('[execution-host] managed Lima doctor reported drift; run `hstack dev-vm doctor` before execution');
  }
  if (diagnosis.ok !== true && canRetainRunningHost) {
    const pendingUpdates = [
      ...diagnosis.drift.resources.map((entry) => entry.field),
      ...(diagnosis.guestToolchain?.ok === false
        ? [diagnosis.guestToolchain.error || 'guest toolchain update pending'] : []),
    ].join('; ');
    reportWarning(`[execution-host] retaining the running VM without applying pending updates: ${pendingUpdates}. Run hstack dev-vm doctor for details.`);
  }
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
    diskImageFormat: profile.diskImageFormat,
    resources: resolveManagedLimaCapacityResources(profile.capacity),
  });
  const pendingLegacyServiceForwardCutover = diagnosis.ok !== true
    && isPendingLegacyServiceForwardCutover(diagnosis);
  if (!pendingLegacyServiceForwardCutover) {
    assertManagedHostExecutionReady(profile, diagnosis, dependencies.reportWarning);
  }
  const workspaceId = String(dependencies.workspaceId ?? '').trim();
  const stackName = String(dependencies.stackName ?? '').trim();
  const requiresServiceTunnel = dependencies.requiresServiceTunnel !== false;
  let serviceTunnelRuntimeStartedAt = '';
  // A named profile can host several guest workspaces with overlapping service
  // ports. The caller that chose a guest workspace is the only safe place to
  // select which Stack declaration receives the host SSH transport.
  if (!pendingLegacyServiceForwardCutover && (profile.version !== 2 || workspaceId)) {
    try {
      const reconciliation = await reconcileServiceTunnel({ profile, workspaceId, stackName, executor, env: process.env });
      serviceTunnelRuntimeStartedAt = String(reconciliation?.runtimeStartedAt ?? '').trim();
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
  return { serviceTunnelRuntimeStartedAt };
}

export async function runExecutionHostGuestCommand({
  profile, guestCwd, command, args = [], cwd = process.cwd(), env = process.env,
  boundary = defaultBoundary(), onStarted,
}) {
  const sshPrimary = profile.mode === 'ssh-dev-target';
  const transport = sshPrimary ? await resolveSshPrimaryTarget({ profile, env }) : null;
  const sshArgs = transport ? [
    ...(transport.sshConfigFile ? ['-F', transport.sshConfigFile] : []),
    '-o', 'ConnectTimeout=10',
  ] : [];
  const remoteScript = script => `exec bash -lc ${posixQuote(prependRemotePath(transport.target, script))}`;
  if (transport) {
    const probe = await runDevTargetSshProcess({ command: 'ssh', env,
      args: buildSshWorkerArgs(transport.target, { sshArgs, tty: false,
        remoteCommand: remoteScript(`cd -- ${posixQuote(guestCwd)} && command -v systemd-run >/dev/null`) }) },
    async ({ command: executable, args: probeArgs }) => {
      const captured = await (boundary.capture ?? runCaptureResult)(executable, probeArgs, { cwd, env });
      return { ...captured, code: captured.exitCode, stderr: captured.err };
    });
    if (probe.code !== 0) {
      throw new Error(`[execution-host] SSH primary ${profile.sshPrimary.targetName} is unreachable or its mapped workspace/session tools are unavailable; execution refused (no local fallback)`);
    }
  }
  delegatedCommandSequence += 1;
  const delegatedUnit = [
    'happier-execution-host', process.pid.toString(36),
    Date.now().toString(36), delegatedCommandSequence.toString(36),
  ].join('-') + '.scope';
  const scopedCommand = [
    'systemd-run', '--user', '--scope', '--quiet', `--unit=${delegatedUnit}`, '--',
    command, ...args,
  ];
  const spawnTransport = (commandArgs, { tty, workdir, stdio }) => boundary.spawn(
    transport ? 'ssh' : 'limactl',
    transport ? buildSshWorkerArgs(transport.target, { sshArgs, tty,
      remoteCommand: remoteScript(`cd -- ${posixQuote(workdir)} && exec ${commandArgs.map(posixQuote).join(' ')}`) })
      : ['shell', '--workdir', workdir, profile.instance, '--', ...commandArgs],
    { cwd, env: transport ? env : { ...env, LIMA_HOME: profile.limaHome }, stdio, shell: false },
  );
  // OpenSSH inherits the controller terminal and forwards its window changes;
  // the same systemd scope retains guest job ownership for either transport.
  const child = spawnTransport(scopedCommand, { tty: true, workdir: guestCwd, stdio: 'inherit' });
  let guestCancellation = null;
  let interruptionSignal = null;
  const removeSignalHandlers = boundary.onSignal((signal) => {
    if (!guestCancellation) {
      interruptionSignal = signal;
      const cancellationScript = [
        `systemctl --user kill --kill-whom=all --signal=SIGTERM ${delegatedUnit} >/dev/null 2>&1 || true`,
        `grace_attempt=0; while [ "$grace_attempt" -lt 150 ]; do state=$(systemctl --user show --property=ActiveState --value ${delegatedUnit} 2>/dev/null || true); case "$state" in active|activating|deactivating) ;; *) break ;; esac; sleep 0.1; grace_attempt=$((grace_attempt + 1)); done`,
        `systemctl --user kill --kill-whom=all --signal=SIGKILL ${delegatedUnit} >/dev/null 2>&1 || true`,
      ].join('; ');
      const cancellationChild = spawnTransport(['/bin/sh', '-c', cancellationScript],
        { tty: false, workdir: '/', stdio: 'ignore' });
      guestCancellation = new Promise((resolveCancellation) => {
        let settled = false;
        const settle = (code) => {
          if (settled) return;
          settled = true;
          if (transport && code !== 0) {
            boundary.reportWarning?.(`[execution-host] SSH primary ${profile.sshPrimary.targetName} cancellation was not confirmed; its delegated job may still be running`);
          }
          resolveCancellation();
        };
        cancellationChild.once('error', settle);
        cancellationChild.once('close', settle);
      }).finally(() => {
        try {
          child.kill(signal);
        } catch {
          // The delegated process may already have reached its terminal state.
        }
      });
    }
  });
  try {
    onStarted?.();
    const result = await new Promise((resolvePromise, rejectPromise) => {
      child.once('error', rejectPromise);
      child.once('close', (exitCode, signal) => resolvePromise({ exitCode, signal }));
    });
    if (guestCancellation) await guestCancellation;
    if (transport && result.exitCode === 255 && !interruptionSignal) {
      boundary.reportWarning?.(`[execution-host] SSH primary ${profile.sshPrimary.targetName} transport or command exited 255; no replay or local fallback`);
    }
    return interruptionSignal ? { exitCode: null, signal: interruptionSignal } : result;
  } finally { removeSignalHandlers(); }
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
  const sshPrimary = profile.mode === 'ssh-dev-target';
  const executor = sshPrimary ? executionHostExecutor(profile, env, boundary) : undefined;
  const prepared = sshPrimary && prepare === prepareManagedHost
    ? await prepareSshHost(profile, { ...preparation, env, executor })
    : await prepare(profile, preparation);
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
  const reconciliationController = new AbortController();
  const postStartReconciler = reconcileAfterStart
    ?? (prepare === prepareManagedHost ? reconcileExecutionHostAfterStart : null);
  const startReconciliation = () => startsGuestStackServices(argv) && postStartReconciler
    ? Promise.resolve(postStartReconciler({
        profile,
        workspaceId: mapping?.workspace.id ?? '',
        stackName,
        signal: reconciliationController.signal,
        env,
        executor,
        previousRuntimeStartedAt: String(prepared?.serviceTunnelRuntimeStartedAt ?? '').trim(),
      })).catch((error) => {
        boundary.reportWarning?.(
          `[dev-vm] delegated Stack started, but its host service tunnel could not be reconciled: ${error?.message ?? error}`,
        );
        return { status: 'failed', error };
      })
    : Promise.resolve({ status: 'not_requested' });
  let reconciliation = Promise.resolve({ status: 'not_requested' });
  try {
    return await runExecutionHostGuestCommand({
      profile, guestCwd, command: 'env',
      args: [
        'HAPPIER_STACK_EXECUTION_HOST_REENTRY=1',
        `HAPPIER_STACK_INVOKED_CWD=${guestCwd}`,
        ...(stackName ? [`HAPPIER_STACK_STACK=${stackName}`] : []),
        invocation.command, ...(invocation.args ?? []), ...delegatedArgv,
      ],
      cwd, env, boundary,
      onStarted: () => { reconciliation = startReconciliation(); },
    });
  } finally {
    reconciliationController.abort();
    await reconciliation;
  }
}
