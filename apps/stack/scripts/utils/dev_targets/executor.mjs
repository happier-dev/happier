import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { killProcessTree, runCaptureResult, spawnProc } from '../proc/proc.mjs';
import {
  buildRemoteCancelCommand,
  buildRemoteExecCommand,
  buildSshWorkerArgs,
  resolvePackageCommandPolicy,
} from './remote_commands.mjs';
import {
  MUTAGEN_SYNC_LIST_JSON_TEMPLATE,
  describeDevTargetSyncRecovery,
  parseMutagenSyncList,
  resolveDevTargetMutagenRuntime,
  resolveDevTargetSshConfigFile,
} from './mutagen_runtime.mjs';
import { resolveMutagenSessionName } from './mutagen_project.mjs';
import { appendExecutionProvenance, readExecutionDurationP99 } from './execution_provenance.mjs';
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

function assertReadySyncStatus(status, { targetName, allowSynchronizing = false, allowRescan = false, allowNeedsFlush = false } = {}) {
  if (status.state === 'ready' || (allowSynchronizing && status.state === 'synchronizing')) return;
  if (allowNeedsFlush && status.state === 'needs-flush') return;
  if (allowRescan && status.recovery === 'rescan') return;
  const reason = status.lastError || status.error;
  const detail = reason ? `: ${reason}` : '';
  const recovery = describeDevTargetSyncRecovery(status, targetName);
  throw new Error(
    `[dev-targets] ${status.sessionName} synchronization is ${status.state}${detail}; `
      + (recovery || 'run hstack dev-targets sync-service start --detached to resume synchronization, '
        + `or run hstack dev-targets status ${targetName} for details`),
  );
}

function isMissingNamedMutagenSession(result) {
  const detail = `${String(result?.err ?? '')}\n${String(result?.error?.message ?? '')}`;
  return /unable to locate requested sessions/i.test(detail)
    && /did not match any sessions/i.test(detail);
}

export async function inspectDevTargetSync(
  { target, stackBaseDir, sourceDir, ownerId, env = process.env, timeoutMs = null },
  { runCaptureResult: runCaptureResultImpl = defaultRunCaptureResult } = {},
) {
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, sourceDir, ownerId, env });
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

/** Shared source admission for commands and finite SSH control helpers. The
 * synchronization owner repairs missing/paused mirrors; consumers only admit
 * a ready mirror and use its existing causal flush barrier. */
export async function prepareDevTargetSourceCommand(
  { target, stackBaseDir, sourceDir, syncAlreadyVerified = false, flush = null, env = process.env },
  { runCaptureResult: runCaptureResultImpl = defaultRunCaptureResult } = {},
) {
  const syncEnv = sourceDir ? { ...env, HAPPIER_STACK_SYNC_SOURCE_DIR: sourceDir } : env;
  let status = { state: 'unknown', successfulCycles: 0 };
  if (!syncAlreadyVerified) {
    status = await inspectDevTargetSync({ target, stackBaseDir, sourceDir, env: syncEnv }, { runCaptureResult: runCaptureResultImpl });
    assertReadySyncStatus(status, { targetName: target.name, allowRescan: flush !== false, allowNeedsFlush: flush !== false });
  }
  if (flush === true || (flush === null && !syncAlreadyVerified)) {
    await flushDevTarget({ target, stackBaseDir, env: syncEnv }, { runCaptureResult: runCaptureResultImpl });
  }
  return status;
}

/** Read-only worker observation, independent of admission and sync readiness. */
export async function inspectDevTargetAdmission({ target, env = process.env },
  { runCaptureResult: capture = defaultRunCaptureResult } = {}) {
  if (target.platform === 'windows') return { state: 'unsupported' };
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
    if (progress?.state === 'unsupported') return { state: 'unsupported' };
    const fields = ['activeCount', 'waitingCount', 'sampleCount', 'availableMemoryKiB', 'totalMemoryKiB',
      'reservedMemoryKiB', 'unreservedMemoryKiB', 'achievableMemoryKiB', 'residentMemoryKiB', 'queuedMemoryKiB'];
    if (progress?.state !== 'observed' || fields.some(field => !Number.isSafeInteger(progress[field]) || progress[field] < 0)) {
      return { state: 'unavailable', error: 'invalid worker admission observation' };
    }
    return progress;
  } catch (error) {
    return { state: 'unavailable', error: error instanceof Error ? error.message : String(error) };
  }
}

/** The broker pushes observations; transport lifetime/cancellation stays with
 * the ordinary remote execution owner, independent of source readiness. */
export async function watchDevTargetAdmission({ target, stackBaseDir, env = process.env, signal, onSample }) {
  if (target.platform === 'windows') return { state: 'unsupported' };
  const result = await runDevTargetCommand({
    target, stackBaseDir, env, signal,
    commandArgs: ['node', './apps/stack/scripts/utils/proc/service_memory.mjs', '--admission-watch'],
    environment: { HAPPIER_STACK_PM_CACHE_BASE_DIR: `${target.cliHomeDir.replace(/[\\/]+$/, '')}/cache` },
    sourceAdmission: 'skip', dependencyAdmission: 'skip', workspacePreparation: 'skip', provenance: 'skip',
    silent: true, persistOutput: false,
    onLine: ({ stream, line }) => {
      if (stream !== 'stdout') return;
      let sample;
      try { sample = JSON.parse(line); } catch { return; }
      onSample(sample);
    },
  });
  if (result.code !== 0 && !signal?.aborted) {
    throw Object.assign(new Error('Worker admission watch unavailable'), { code: 'HSTACK_ADMISSION_WATCH_UNAVAILABLE' });
  }
  return result;
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
  for (let recoveryUsed = false; ; recoveryUsed = true) {
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
      if (postFlushStatus.recovery === 'rescan' && !recoveryUsed) {
        console.error(`[dev-targets] ${target.name} rescanning reported problems through one fresh flush`);
        continue;
      }
      assertReadySyncStatus(postFlushStatus, { targetName: target.name });
    }
    return { state: 'ready', sessionName, flushed: true };
  }
}

export async function syncDevTarget(
  options,
  dependencies = {},
) {
  const status = await inspectDevTargetSync(options, dependencies);
  assertReadySyncStatus(status, { targetName: options.target.name, allowSynchronizing: true, allowRescan: true, allowNeedsFlush: true });
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
    signal,
    env = process.env,
  },
  { runCommand = runDevTargetCommand } = {},
) {
  const result = await runCommand({
    target,
    stackBaseDir,
    commandArgs: [
      'node',
      './apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.mjs',
      '--execution-placement=remote',
      `--validation-kind=${validationKind}`,
      `--component-relative-dir=${componentRelativeDir}`,
      `--default-build-mode=${env.HAPPIER_WORKSPACE_BUILD_MODE ?? defaultBuildMode}`,
    ],
    environment: {
      HAPPIER_STACK_PM_CACHE_BASE_DIR: `${String(target.cliHomeDir).replace(/[\\/]+$/, '')}/cache`,
    },
    dependencyAdmission: 'skip',
    provenance: 'skip',
    onLine,
    signal,
    syncAlreadyVerified,
    ...(flush ? { flush: true } : {}),
    ...(silent !== undefined ? { silent } : {}),
    env,
  });
  return result;
}

export async function runDevTargetWorkspacePreparation(
  {
    target,
    stackBaseDir,
    cwd,
    validationKind = 'runtime',
    requiredTools = '',
    preparationScope = '',
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
      ...(preparationScope ? [`--preparation-scope=${preparationScope}`] : []),
      ...(requiredTools ? [`--required-tools=${requiredTools}`] : []),
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
    sourceAdmission = 'auto',
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
  const commandPolicy = await resolvePackageCommandPolicy(commandArgs, {
    cwd: resolve(sourceDir, cwd), repoRoot: sourceDir, env: { ...env, ...environment },
  });
  if (commandPolicy.placement === 'primary-only') {
    if (commandPolicy.generator === '1') {
      throw new Error('[dev-targets] tracked-source writer must execute on the authoritative primary checkout');
    }
    if (commandPolicy.commandClass === 'source-search') {
      throw new Error('[dev-targets] source searches must execute on the authoritative primary checkout');
    }
    throw new Error('[dev-targets] Git/index/worktree commands must execute on the authoritative primary checkout');
  }
  // Runtime-state observations do not consume a fresh source snapshot. Keep
  // their transport/cancellation without requiring mirror readiness or a flush.
  const syncStatus = sourceAdmission === 'skip' ? { state: 'not-required' } : await prepareDevTargetSourceCommand(
    { target, stackBaseDir, syncAlreadyVerified, flush, env },
    { runCaptureResult: runCaptureResultImpl },
  );

  const bootstrapRequired = dependencyAdmission !== 'skip' && commandPolicy.bootstrap === '1';
  const preparationRequired = workspacePreparation !== 'skip' && commandPolicy.commandClass === 'targeted-validation';
  const validationKind = commandPolicy.kind;
  const defaultBuildMode = environment.HAPPIER_WORKSPACE_BUILD_MODE ?? env.HAPPIER_WORKSPACE_BUILD_MODE
    ?? commandPolicy.preparationBuildMode;
  // POSIX preparation shares the payload's execution custody, but completes
  // before its native admission. Windows retains its separate transport.
  if (target.platform === 'windows' && bootstrapRequired) {
    const bootstrap = await runDependencyBootstrap({
      target,
      stackBaseDir,
      validationKind,
      defaultBuildMode,
      componentRelativeDir: commandPolicy.component,
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
      cwd: commandPolicy.component,
      validationKind,
      requiredTools: commandPolicy.requiredTools,
      preparationScope: commandPolicy.preparationScope,
      defaultBuildMode,
      syncAlreadyVerified: true,
      env: { ...env, HAPPIER_WORKSPACE_BUILD_MODE: defaultBuildMode },
    });
    if (preparation?.code !== 0) return preparation;
  }

  const executionId = createExecutionId();
  signal?.throwIfAborted();
  const lifetimeStdin = target.platform !== 'windows' && !tty;
  const durationP99 = commandPolicy.heavyClass
    ? await readExecutionDurationP99(stackBaseDir, commandPolicy.commandClass) : null;
  const remoteCommand = buildRemoteExecCommand(target, {
    executionId,
    cwd,
    commandArgs,
    commandPolicy,
    ...(target.platform === 'windows' ? {} : {
      preparation: bootstrapRequired || preparationRequired ? {
        bootstrap: bootstrapRequired,
        bootstrapComponentRelativeDir: commandPolicy.component,
        ...(preparationRequired ? { componentRelativeDir: commandPolicy.component } : {}),
        validationKind,
        defaultBuildMode,
      } : null,
      admissionClass: commandPolicy.heavyClass,
    }),
    environment: {
      ...environment,
      ...(durationP99 === null ? {} : {
        HAPPIER_ADMISSION_DURATION_CLASS: commandPolicy.commandClass,
        HAPPIER_ADMISSION_DURATION_P99_MS: String(durationP99),
      }),
    },
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
  let runMs;
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
        if ([`HSTACK_ADMISSION_BUSY:${executionId}`, `HSTACK_ADMISSION_DISK:${executionId}`, `HSTACK_ADMISSION_CAPACITY:${executionId}`].includes(line)) admissionDeclined = true;
        // Wall time below includes the worker queue; the admitted client reports run time.
        const reportedRunMs = line.startsWith(`HSTACK_ADMISSION_RUN_MS:${executionId}:`)
          ? Number(line.slice(`HSTACK_ADMISSION_RUN_MS:${executionId}:`.length)) : NaN;
        if (Number.isSafeInteger(reportedRunMs) && reportedRunMs > 0) runMs = reportedRunMs;
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
            if (cancelResult?.err) process.stderr.write(cancelResult.err);
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
      commandClass: commandPolicy.commandClass,
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
      commandClass: commandPolicy.commandClass,
      exitCode: result.code,
      signal: result.signal,
      durationMs: completedAt - admittedAt,
      ...(runMs === undefined ? {} : { runMs }),
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
