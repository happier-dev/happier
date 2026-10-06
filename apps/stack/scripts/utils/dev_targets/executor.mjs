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
} from './mutagen_runtime.mjs';
import { resolveMutagenSessionName } from './mutagen_project.mjs';
import { appendExecutionProvenance } from './execution_provenance.mjs';
import { buildDevTargetControlLaunch } from './sync_project.mjs';

async function defaultRunCaptureResult({ command, args, env, streamLabel = '', timeoutMs }) {
  return await runCaptureResult(command, args, {
    env,
    ...(streamLabel ? { streamLabel } : {}),
    ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
  });
}

function defaultSpawnProcess({ label, command, args, env, tty, lifetimeStdin, onLine }) {
  return spawnProc(label, command, args, env, { onLine, ...(tty ? { stdio: 'inherit' } : lifetimeStdin ? { ownedProcessGroup: true, stdio: ['pipe', 'pipe', 'pipe'] } : {}) });
}

async function defaultStopProcess(child, signal) {
  return await killProcessTree(child, signal, { graceMs: 2_000 });
}

function assertReadySyncStatus(status, { allowSynchronizing = false } = {}) {
  if (status.state === 'ready' || (allowSynchronizing && status.state === 'synchronizing')) return;
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
  { target, stackBaseDir, env = process.env, timeoutMs = null },
  { runCaptureResult: runCaptureResultImpl = defaultRunCaptureResult } = {},
) {
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, env });
  const sessionName = resolveMutagenSessionName(target.name);
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

async function flushDevTarget(
  { target, stackBaseDir, env = process.env, timeoutMs = null },
  { runCaptureResult: runCaptureResultImpl = defaultRunCaptureResult } = {},
) {
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, env });
  const sessionName = resolveMutagenSessionName(target.name);
  const launch = buildDevTargetControlLaunch({
    command: 'mutagen',
    args: ['sync', 'flush', sessionName],
    syncFlushSession: sessionName,
  });
  const result = await runCaptureResultImpl({
    command: launch.command,
    args: launch.args,
    env: {
      ...runtime.env,
      HAPPIER_DEV_TARGET_CONTROL_STATE_DIR: `${stackBaseDir}/dev-target-command-load-native/sync-control`,
    },
    streamLabel: `sync:${target.name}`,
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
  assertReadySyncStatus(status, { allowSynchronizing: true });
  return await flushDevTarget(options, dependencies);
}

export async function runDevTargetDependencyBootstrap(
  {
    target,
    stackBaseDir,
    validationKind = 'runtime',
    componentRelativeDir = '.',
    syncAlreadyVerified = false,
    flush = false,
    env = process.env,
  },
  { runCommand = runDevTargetCommand } = {},
) {
  return await runCommand({
    target,
    stackBaseDir,
    commandArgs: [
      'node',
      './apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.mjs',
      `--validation-kind=${validationKind}`,
      `--component-relative-dir=${componentRelativeDir}`,
    ],
    environment: {
      HAPPIER_STACK_PM_CACHE_BASE_DIR: `${String(target.cliHomeDir).replace(/[\\/]+$/, '')}/cache`,
    },
    dependencyAdmission: 'skip',
    provenance: 'skip',
    syncAlreadyVerified,
    ...(flush ? { flush: true } : {}),
    env,
  });
}

export async function runDevTargetWorkspacePreparation(
  {
    target,
    stackBaseDir,
    cwd,
    validationKind = 'runtime',
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
    dependencyAdmission = 'auto',
    admissionMode = 'wait',
    workspacePreparation = 'auto',
    provenance = 'auto',
    syncAlreadyVerified = false,
    sourceDir = fileURLToPath(new URL('../../../../../', import.meta.url)),
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
    assertReadySyncStatus(syncStatus);
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
  // POSIX preparations are children of the same native admission and execution
  // identity as the payload. Windows retains its separate local-only transport.
  if (target.platform === 'windows' && bootstrapRequired) {
    const bootstrap = await runDependencyBootstrap({
      target,
      stackBaseDir,
      validationKind,
      componentRelativeDir: resolveRemoteValidationComponentRelativeDir(commandArgs, { cwd }),
      syncAlreadyVerified: true,
      env,
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
      syncAlreadyVerified: true,
      env,
    });
    if (preparation?.code !== 0) return preparation;
  }

  const executionId = createExecutionId();
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
      } : null,
      admissionClass: resolveRemoteCommandPolicy(commandArgs, { cwd }).heavyClass,
    }),
    environment,
    admissionMode,
    lifetimeStdin,
  });
  const sshArgs = [
    ...(target.sshConfigFile ? ['-F', target.sshConfigFile] : []),
    '-o',
    'ControlMaster=no',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
  ];
  const admittedAt = now();
  let admissionDeclined = false;
  const child = spawnProcess({
    label: `remote:${target.name}`,
    command: 'ssh',
    args: buildSshWorkerArgs(target, { remoteCommand, sshArgs, tty }),
    env,
    tty,
    lifetimeStdin,
    onLine: ({ stream, line }) => {
      if (stream === 'stderr' && line === '[preferred-execution] heavyweight admission declined before dispatch') admissionDeclined = true;
    },
  });
  const recordProvenance = async (record) => {
    if (provenance === 'skip') return;
    try {
      await recordExecutionProvenance(stackBaseDir, record);
    } catch {
      // Diagnostics must never change command execution behavior.
    }
  };
  let stopPromise = null;
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
              timeoutMs: 10_000,
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
    const result = await child.completion;
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
    for (const [signal, listener] of listeners) {
      if (typeof signalSource.off === 'function') signalSource.off(signal, listener);
      else signalSource.removeListener(signal, listener);
    }
  }
}
