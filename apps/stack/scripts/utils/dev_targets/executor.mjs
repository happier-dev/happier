import { randomUUID } from 'node:crypto';

import { killProcessTree, runCaptureResult, spawnProc } from '../proc/proc.mjs';
import {
  buildRemoteCancelCommand,
  buildRemoteExecCommand,
  buildSshWorkerArgs,
  requiresRemoteDependencyBootstrap,
} from './remote_commands.mjs';
import {
  MUTAGEN_SYNC_LIST_JSON_TEMPLATE,
  parseMutagenSyncList,
  resolveDevTargetMutagenRuntime,
} from './mutagen_runtime.mjs';
import { resolveMutagenSessionName } from './mutagen_project.mjs';

async function defaultRunCaptureResult({ command, args, env, streamLabel = '', timeoutMs }) {
  return await runCaptureResult(command, args, {
    env,
    ...(streamLabel ? { streamLabel } : {}),
    ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
  });
}

function defaultSpawnProcess({ label, command, args, env, tty }) {
  return spawnProc(label, command, args, env, tty ? { stdio: 'inherit' } : {});
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
      + 'start or resume yarn tui, or run hstack dev-targets status for details',
  );
}

export async function inspectDevTargetSync(
  { target, stackBaseDir, env = process.env, timeoutMs = null },
  { runCaptureResult: runCaptureResultImpl = defaultRunCaptureResult } = {},
) {
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, env });
  const sessionName = resolveMutagenSessionName(target.name);
  const result = await runCaptureResultImpl({
    command: 'mutagen',
    args: ['sync', 'list', sessionName, '--template', MUTAGEN_SYNC_LIST_JSON_TEMPLATE],
    env: runtime.env,
    ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
  });
  if (!result?.ok) {
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
  const result = await runCaptureResultImpl({
    command: 'mutagen',
    args: ['sync', 'flush', sessionName],
    env: runtime.env,
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
    syncAlreadyVerified = false,
    env = process.env,
  },
  { runCommand = runDevTargetCommand } = {},
) {
  return await runCommand({
    target,
    stackBaseDir,
    commandArgs: [
      'corepack',
      'yarn',
      'node',
      './apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.mjs',
    ],
    environment: {
      HAPPIER_STACK_PM_CACHE_BASE_DIR: `${String(target.cliHomeDir).replace(/[\\/]+$/, '')}/cache`,
    },
    dependencyAdmission: 'skip',
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
    flush = false,
    tty = false,
    dependencyAdmission = 'auto',
    syncAlreadyVerified = false,
    env = process.env,
  },
  {
    runCaptureResult: runCaptureResultImpl = defaultRunCaptureResult,
    spawnProcess = defaultSpawnProcess,
    stopProcess = defaultStopProcess,
    signalSource = process,
    createExecutionId = randomUUID,
    runDependencyBootstrap = runDevTargetDependencyBootstrap,
  } = {},
) {
  if (!syncAlreadyVerified) {
    const status = await inspectDevTargetSync(
      { target, stackBaseDir, env },
      { runCaptureResult: runCaptureResultImpl },
    );
    assertReadySyncStatus(status);
  }
  if (flush) {
    await flushDevTarget(
      { target, stackBaseDir, env },
      { runCaptureResult: runCaptureResultImpl },
    );
  }

  if (dependencyAdmission !== 'skip' && requiresRemoteDependencyBootstrap(commandArgs)) {
    const bootstrap = await runDependencyBootstrap({
      target,
      stackBaseDir,
      syncAlreadyVerified: true,
      env,
    });
    if (bootstrap?.code !== 0) return bootstrap;
  }

  const executionId = createExecutionId();
  const remoteCommand = buildRemoteExecCommand(target, {
    executionId,
    cwd,
    commandArgs,
    environment,
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
  const child = spawnProcess({
    label: `remote:${target.name}`,
    command: 'ssh',
    args: buildSshWorkerArgs(target, { remoteCommand, sshArgs, tty }),
    env,
    tty,
  });
  let stopPromise = null;
  const listeners = new Map(
    ['SIGINT', 'SIGTERM'].map((signal) => [signal, () => {
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
    const result = await child.completion;
    const stopError = stopPromise ? await stopPromise : null;
    if (stopError) throw stopError;
    return result;
  } finally {
    for (const [signal, listener] of listeners) {
      if (typeof signalSource.off === 'function') signalSource.off(signal, listener);
      else signalSource.removeListener(signal, listener);
    }
  }
}
