import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { killProcessTree, runCaptureResult, spawnProc } from '../proc/proc.mjs';
import {
  buildRemoteCancelCommand,
  buildRemoteExecCommand,
  buildSshWorkerArgs,
  classifyRemoteCommand,
  requiresRemoteWorkspacePreparation,
  resolveRemoteCommandPolicy,
  resolveRemoteValidationKind,
  resolveRemoteValidationComponentRelativeDir,
} from './remote_commands.mjs';
import {
  MUTAGEN_SYNC_LIST_JSON_TEMPLATE,
  parseMutagenSyncList,
  resolveDevTargetMutagenRuntime,
  resolveDevTargetSshConfigFile,
} from './mutagen_runtime.mjs';
import { resolveMutagenSessionName } from './mutagen_project.mjs';
import { appendExecutionProvenance } from './execution_provenance.mjs';
import { buildDevTargetControlLaunch } from './sync_project.mjs';
import { classifyDevTargetSshDiagnostic, runDevTargetSshProcess } from './ssh_transport.mjs';

async function defaultRunCaptureResult({ command, args, env, streamLabel = '', stdoutDiagnosticStream, timeoutMs }) {
  return await runCaptureResult(command, args, {
    env,
    ...(streamLabel ? { streamLabel } : {}),
    ...(stdoutDiagnosticStream !== undefined ? { stdoutDiagnosticStream } : {}),
    ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
  });
}

function defaultSpawnProcess({ label, command, args, env, tty, lifetimeStdin, onLine, silent, lineFilter, persistOutput }) {
  return spawnProc(label, command, args, env, { onLine, silent, lineFilter, persistOutput, ...(tty ? { stdio: 'inherit' } : lifetimeStdin ? { ownedProcessGroup: true, stdio: ['pipe', 'pipe', 'pipe'] } : {}) });
}

async function defaultStopProcess(child, signal) {
  return await killProcessTree(child, signal, { graceMs: 2_000 });
}

function assertReadySyncStatus(status, { allowSynchronizing = false, allowRescan = false, allowNeedsFlush = false } = {}) {
  if (status.state === 'ready' || (allowSynchronizing && status.state === 'synchronizing')) return;
  if (allowNeedsFlush && status.state === 'needs-flush') return;
  if (allowRescan && status.recovery === 'rescan') return;
  const reason = status.lastError || status.error;
  const detail = reason ? `: ${reason}` : '';
  throw new Error(
    `[dev-targets] ${status.sessionName} synchronization is ${status.state}${detail}; `
      + 'run hstack dev-targets sync-service start --detached to resume synchronization, '
      + 'or run hstack dev-targets status for details',
  );
}

function isMissingNamedMutagenSession(result) {
  const detail = `${String(result?.err ?? '')}\n${String(result?.error?.message ?? '')}`;
  return /unable to locate requested sessions/i.test(detail)
    && /did not match any sessions/i.test(detail);
}

export async function inspectDevTargetSync(
  { target, stackBaseDir, sourceDir, env = process.env, timeoutMs = null },
  { runCaptureResult: runCaptureResultImpl = defaultRunCaptureResult } = {},
) {
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, sourceDir, env });
  const sessionName = resolveMutagenSessionName(target.name, runtime.sourceDir);
  const launch = buildDevTargetControlLaunch({
    command: 'mutagen',
    args: ['sync', 'list', sessionName, '--template', MUTAGEN_SYNC_LIST_JSON_TEMPLATE],
  });
  const result = await runCaptureResultImpl({
    command: launch.command,
    args: launch.args,
    env: runtime.env,
    ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
  });
  if (!result?.ok) {
    if (isMissingNamedMutagenSession(result)) {
      return { state: 'missing', sessionName };
    }
    return {
      state: 'unavailable',
      sessionName,
      exitCode: result?.exitCode ?? null,
      error: String(result?.err ?? '').trim() || result?.error?.message || 'Mutagen session query failed',
    };
  }
  try {
    return parseMutagenSyncList(result.out, sessionName);
  } catch (error) {
    return {
      state: 'unavailable',
      sessionName,
      exitCode: result?.exitCode ?? null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Read-only worker observation, independent of admission and sync readiness. */
export async function inspectDevTargetAdmission({ target, env = process.env },
  { runCaptureResult: capture = defaultRunCaptureResult } = {}) {
  if (target.platform === 'windows') return { state: 'unsupported', owners: [] };
  const remoteCommand = buildRemoteExecCommand(target, {
    executionId: randomUUID(), commandArgs: ['node', './apps/stack/scripts/utils/proc/service_memory.mjs', '--admission-status'],
    environment: { HAPPIER_STACK_PM_CACHE_BASE_DIR: `${target.cliHomeDir.replace(/[\\/]+$/, '')}/cache` },
  });
  try {
    const result = await capture({ command: 'ssh', args: buildSshWorkerArgs(target, {
      remoteCommand, tty: false, sshArgs: target.sshConfigFile ? ['-F', target.sshConfigFile] : [],
    }), env });
    if (!result?.ok) return { state: 'unavailable', error: result?.err || 'worker admission observation failed' };
    const progress = JSON.parse(result.out);
    if (!['observed', 'unsupported'].includes(progress?.state) || !Array.isArray(progress.owners)
      || progress.owners.some(owner => !Number.isSafeInteger(owner.pid) || owner.pid <= 1
        || typeof owner.token !== 'string' || !/^\d+$/.test(owner.token)
        || typeof owner.className !== 'string' || !/^[a-z][a-z-]*$/.test(owner.className)
        || ![owner.ageSeconds, owner.cpuSeconds, owner.recentCpuPercent].every(value => value === null || (Number.isFinite(value) && value >= 0)))) {
      return { state: 'unavailable', error: 'invalid worker admission observation' };
    }
    return progress;
  } catch (error) {
    return { state: 'unavailable', error: error instanceof Error ? error.message : String(error) };
  }
}

async function flushDevTarget(
  { target, stackBaseDir, env = process.env, timeoutMs = null },
  { runCaptureResult: runCaptureResultImpl = defaultRunCaptureResult } = {},
) {
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, env });
  const sessionName = resolveMutagenSessionName(target.name, runtime.sourceDir);
  const launch = buildDevTargetControlLaunch({
    command: 'mutagen',
    args: ['sync', 'flush', sessionName],
    syncFlushSession: sessionName,
  });
  const result = await runCaptureResultImpl({
    command: launch.command,
    args: launch.args,
    env: runtime.env,
    streamLabel: `sync:${target.name}`,
    stdoutDiagnosticStream: process.stderr,
    ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
  });
  if (!result?.ok) {
    const detail = String(result?.err ?? '').trim();
    throw new Error(
      `[dev-targets] ${target.name} synchronization flush failed`
        + (detail ? `: ${detail}` : ''),
    );
  }
  if (process.platform === 'win32') {
    const postFlushStatus = await inspectDevTargetSync(
      { target, stackBaseDir, env, timeoutMs },
      { runCaptureResult: runCaptureResultImpl },
    );
    assertReadySyncStatus(postFlushStatus);
  }
  return { state: 'ready', sessionName, flushed: true };
}

export async function syncDevTarget(
  options,
  dependencies = {},
) {
  const status = await inspectDevTargetSync(options, dependencies);
  assertReadySyncStatus(status, { allowSynchronizing: true, allowRescan: true, allowNeedsFlush: true });
  return await flushDevTarget(options, dependencies);
}

export async function runDevTargetDependencyBootstrap(
  {
    target,
    stackBaseDir,
    validationKind = 'runtime',
    defaultBuildMode = 'strict',
    componentRelativeDir = '.',
    syncAlreadyVerified = false,
    flush = false,
    silent,
    onLine,
    env = process.env,
  },
  { runCommand = runDevTargetCommand } = {},
) {
  let ownershipRefused = false;
  let ownershipDetail = '';
  const result = await runCommand({
    target,
    stackBaseDir,
    commandArgs: [
      'node',
      './apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.mjs',
      `--validation-kind=${validationKind}`,
      `--component-relative-dir=${componentRelativeDir}`,
      `--default-build-mode=${env.HAPPIER_WORKSPACE_BUILD_MODE ?? defaultBuildMode}`,
    ],
    environment: {
      HAPPIER_STACK_PM_CACHE_BASE_DIR: `${String(target.cliHomeDir).replace(/[\\/]+$/, '')}/cache`,
    },
    dependencyAdmission: 'skip',
    provenance: 'skip',
    onLine: event => {
      if (event.stream === 'stderr') {
        if (event.line.includes('HAPPIER_DEPENDENCY_METRO_RESTART_REQUIRED')) ownershipRefused = true;
        if (event.line.startsWith('Error: Expo') || event.line.startsWith('Error: Cannot stop verified Expo')) ownershipDetail = event.line;
      }
      onLine?.(event);
    },
    syncAlreadyVerified,
    ...(flush ? { flush: true } : {}),
    ...(silent !== undefined ? { silent } : {}),
    env,
  });
  if (result?.code !== 0 && ownershipRefused) {
    const error = new Error(ownershipDetail || 'Stop the owning Stack once on this target, verify its recorded Expo process has exited, then start again.');
    error.code = 'HAPPIER_DEPENDENCY_METRO_RESTART_REQUIRED';
    return { ...result, error };
  }
  return result;
}

export async function runDevTargetWorkspacePreparation(
  {
    target,
    stackBaseDir,
    cwd,
    validationKind = 'runtime',
    defaultBuildMode = 'strict',
    syncAlreadyVerified = false,
    env = process.env,
  },
  { runCommand = runDevTargetCommand } = {},
) {
  return await runCommand({
    target,
    stackBaseDir,
    commandArgs: [
      'node',
      './apps/stack/scripts/utils/dev_targets/remote_validation_preparation.mjs',
      `--component-relative-dir=${cwd}`,
      `--validation-kind=${validationKind}`,
      `--default-build-mode=${env.HAPPIER_WORKSPACE_BUILD_MODE ?? defaultBuildMode}`,
    ],
    environment: {
      HAPPIER_STACK_PM_CACHE_BASE_DIR: `${String(target.cliHomeDir).replace(/[\\/]+$/, '')}/cache`,
    },
    dependencyAdmission: 'skip',
    workspacePreparation: 'skip',
    provenance: 'skip',
    syncAlreadyVerified,
    env,
  });
}

export async function runDevTargetCommand(
  {
    target,
    stackBaseDir,
    commandArgs,
    cwd = '.',
    environment = {},
    flush = null,
    tty = false,
    controlStdin = false,
    dependencyAdmission = 'auto',
    admissionMode = 'wait',
    workspacePreparation = 'auto',
    provenance = 'auto',
    syncAlreadyVerified = false,
    sourceDir = fileURLToPath(new URL('../../../../../', import.meta.url)),
    onLine,
    silent = false,
    lineFilter,
    persistOutput,
    signal,
    env = process.env,
  },
  {
    runCaptureResult: runCaptureResultImpl = defaultRunCaptureResult,
    spawnProcess = defaultSpawnProcess,
    stopProcess = defaultStopProcess,
    signalSource = process,
    createExecutionId = randomUUID,
    runDependencyBootstrap = runDevTargetDependencyBootstrap,
    runWorkspacePreparation = runDevTargetWorkspacePreparation,
    recordExecutionProvenance = appendExecutionProvenance,
    now = Date.now,
  } = {},
) {
  signal?.throwIfAborted();
  const classification = classifyRemoteCommand(commandArgs, { cwd });
  if (classification.placement === 'primary-only') {
    throw new Error('[dev-targets] Git/index/worktree commands must execute on the authoritative primary checkout');
  }
  let syncStatus = { state: 'unknown', successfulCycles: 0 };
  if (!syncAlreadyVerified) {
    syncStatus = await inspectDevTargetSync(
      { target, stackBaseDir, env },
      { runCaptureResult: runCaptureResultImpl },
    );
    assertReadySyncStatus(syncStatus, { allowRescan: flush !== false, allowNeedsFlush: flush !== false });
  }
  if (flush === true || (flush === null && !syncAlreadyVerified)) {
    await flushDevTarget(
      { target, stackBaseDir, env },
      { runCaptureResult: runCaptureResultImpl },
    );
  }

  const bootstrapRequired = dependencyAdmission !== 'skip' && classification.requiresDependencyBootstrap;
  const preparationRequired = workspacePreparation !== 'skip' && requiresRemoteWorkspacePreparation(commandArgs, { cwd });
  const validationKind = resolveRemoteValidationKind(commandArgs, { cwd });
  const defaultBuildMode = environment.HAPPIER_WORKSPACE_BUILD_MODE ?? env.HAPPIER_WORKSPACE_BUILD_MODE
    ?? resolveRemoteCommandPolicy(commandArgs, { cwd }).preparationBuildMode;
  // POSIX preparation shares the payload's execution custody, but completes
  // before its native admission. Windows retains its separate transport.
  if (target.platform === 'windows' && bootstrapRequired) {
    const bootstrap = await runDependencyBootstrap({
      target,
      stackBaseDir,
      validationKind,
      defaultBuildMode,
      componentRelativeDir: resolveRemoteValidationComponentRelativeDir(commandArgs, { cwd }),
      syncAlreadyVerified: true,
      env: { ...env, HAPPIER_WORKSPACE_BUILD_MODE: defaultBuildMode },
    });
    if (bootstrap?.code !== 0) return bootstrap;
  }

  if (
    target.platform === 'windows' && preparationRequired
  ) {
    const preparation = await runWorkspacePreparation({
      target,
      stackBaseDir,
      cwd: resolveRemoteValidationComponentRelativeDir(commandArgs, { cwd }),
      validationKind,
      defaultBuildMode,
      syncAlreadyVerified: true,
      env: { ...env, HAPPIER_WORKSPACE_BUILD_MODE: defaultBuildMode },
    });
    if (preparation?.code !== 0) return preparation;
  }

  const executionId = createExecutionId();
  signal?.throwIfAborted();
  const lifetimeStdin = target.platform !== 'windows' && !tty;
  const remoteCommand = buildRemoteExecCommand(target, {
    executionId,
    cwd,
    commandArgs,
    ...(target.platform === 'windows' ? {} : {
      preparation: bootstrapRequired || preparationRequired ? {
        bootstrap: bootstrapRequired,
        bootstrapComponentRelativeDir: resolveRemoteValidationComponentRelativeDir(commandArgs, { cwd }),
        ...(preparationRequired ? { componentRelativeDir: resolveRemoteValidationComponentRelativeDir(commandArgs, { cwd }) } : {}),
        validationKind,
        defaultBuildMode,
      } : null,
      admissionClass: resolveRemoteCommandPolicy(commandArgs, { cwd }).heavyClass,
    }),
    environment,
    admissionMode,
    lifetimeStdin,
    controlStdin,
  });
  const sshConfigFile = resolveDevTargetSshConfigFile(target, { stackBaseDir, env });
  const sshArgs = [
    ...(sshConfigFile ? ['-F', sshConfigFile] : []),
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
  ];
  const admittedAt = now();
  let admissionDeclined = false;
  let child;
  let stopPromise = null;
  const completion = runDevTargetSshProcess({
    label: `remote:${target.name}`,
    command: 'ssh',
    args: buildSshWorkerArgs(target, { remoteCommand, sshArgs, tty }),
    env,
    tty,
    lifetimeStdin,
    silent,
    lineFilter,
    persistOutput,
  }, async input => {
    signal?.throwIfAborted();
    if (stopPromise) return { code: 130, signal: 'SIGINT' };
    let diagnosticReason = null;
    child = spawnProcess({ ...input, onLine: ({ stream, line }) => {
      onLine?.({ stream, line });
      if (stream === 'stderr') {
        diagnosticReason ??= classifyDevTargetSshDiagnostic(line);
        if ([`HSTACK_ADMISSION_BUSY:${executionId}`, `HSTACK_ADMISSION_DISK:${executionId}`].includes(line)) admissionDeclined = true;
      }
    } });
    const result = await child.completion;
    return { ...result, ...(diagnosticReason ? { diagnosticReason } : {}) };
  });
  const recordProvenance = async (record) => {
    if (provenance === 'skip') return;
    try {
      await recordExecutionProvenance(stackBaseDir, record);
    } catch {
      // Diagnostics must never change command execution behavior.
    }
  };
  const listeners = new Map(
    ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => {
      stopPromise ??= Promise.resolve()
        .then(async () => {
          let cancellationError = null;
          try {
            const cancelCommand = buildRemoteCancelCommand(target, { executionId });
            const cancelResult = await runCaptureResultImpl({
              command: 'ssh',
              args: buildSshWorkerArgs(target, {
                remoteCommand: cancelCommand,
                sshArgs,
                tty: false,
              }),
              env,
            });
            if (!cancelResult?.ok) {
              const detail = String(cancelResult?.err ?? '').trim()
                || cancelResult?.error?.message
                || `SSH exited with code ${cancelResult?.exitCode ?? 'unknown'}`;
              cancellationError = new Error(
                `[dev-targets] remote cancellation was not confirmed: ${detail}`,
              );
            }
          } catch (error) {
            cancellationError = new Error(
              `[dev-targets] remote cancellation was not confirmed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          try {
            await stopProcess(child, signal);
          } catch (error) {
            cancellationError ??= error;
          }
          return cancellationError;
        });
    }]),
  );
  for (const [signal, listener] of listeners) signalSource.on(signal, listener);
  const abortListener = () => listeners.get('SIGINT')();
  signal?.addEventListener('abort', abortListener, { once: true });
  if (signal?.aborted) abortListener();
  try {
    await recordProvenance({
      phase: 'admitted',
      executionId,
      timestamp: admittedAt,
      target: target.name,
      commandClass: classification.commandClass,
      syncStatus: syncStatus.state,
      syncSuccessfulCycles: syncStatus.session?.successfulCycles ?? 0,
    });
    const result = await completion;
    const stopError = stopPromise ? await stopPromise : null;
    if (stopError) throw stopError;
    const completedAt = now();
    await recordProvenance({
      phase: 'completed',
      executionId,
      timestamp: completedAt,
      target: target.name,
      commandClass: classification.commandClass,
      exitCode: result.code,
      signal: result.signal,
      durationMs: completedAt - admittedAt,
    });
    return admissionMode === 'try' && result.code === 75 && admissionDeclined
      ? { ...result, admissionUnavailable: true }
      : result;
  } finally {
    signal?.removeEventListener('abort', abortListener);
    for (const [signal, listener] of listeners) {
      if (typeof signalSource.off === 'function') signalSource.off(signal, listener);
      else signalSource.removeListener(signal, listener);
    }
  }
}
