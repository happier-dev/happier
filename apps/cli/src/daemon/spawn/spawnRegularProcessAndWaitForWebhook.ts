import type { PersistedTakeoverAdmissionWaitRegistration } from './persistedTakeoverAdmission';
import { spawn as spawnChildProcess } from 'node:child_process';
import { observeProcessLaunch } from '@/processes/launchNotification';
import { isPidPresent } from '@happier-dev/cli-common/process';

import { appendBoundedChildStderr, buildChildExitBeforeWebhookFailure, sanitizeChildStderrTail, type CapturedChildStderr } from './childStderrDiagnostic';

import type { ChildExit } from '../sessions/onChildExited';
import { resolveSpawnWebhookResult } from '../sessions/resolveSpawnWebhookResult';
import type {
  RunnerAgentInvocationContext,
  TrackedSession,
} from '../types';
import type {
  RunnerAgentSessionBootstrapAuthorization,
} from '../agentRuntime/sessionBridgeAuthorization';
import { buildHappyCliSubprocessLaunchSpec, spawnHappyCLI, type HappyCliSubprocessLaunchOptions } from '@/utils/spawnHappyCLI';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionOptions, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';

import { buildSpawnChildProcessEnv } from './buildSpawnChildProcessEnv';
import { applySpawnedChildOomScoreAdjustment } from '../platform/linux/applySpawnedChildOomScoreAdjustment';
import { buildCgroupSelfMigratingHappyCliLaunchSpec } from '../platform/linux/buildCgroupSelfMigratingHappyCliLaunchSpec';
import { createHappierLinuxScopeName, shouldUseSystemdUserSessionResourceGovernor } from '../platform/linux/systemdUserResourceGovernor';
import { readHostProcessOwnerTag, withHostProcessOwnerEnvironment } from '@/processes/ownerTag';
import type { SpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import {
  tombstoneTrackedSessionWebhookPids,
  armSessionWebhookStartupCustody,
  waitForSessionWebhook,
} from './waitForSessionWebhook';
import type { SpawnCommitRevalidation } from './spawnCommitRevalidation';
import type { ProviderStreamingSanitizer } from '@/providers/spawn/redaction';
import {
  completeStartupCancellationCleanup,
  resolveSpawnErrorAfterStartupCancellation,
  projectRetiredStartupLaunchResult,
  type CancelStartupLaunch,
} from './startupLaunchCancellation';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import { createExactWindowsProcessCancellation } from '../platform/windows/windowsProcessCustody';
import { classifySpawnFailure, spawnFailureMessage, type SpawnFailureLimitsReader } from '@/processes/spawnFailure/classifySpawnFailure';

export async function spawnRegularProcessAndWaitForWebhook(params: Readonly<{
  args: readonly string[];
  directory: string;
  options: SpawnSessionOptions;
  trackedSpawnOptions: SpawnSessionOptions;
  normalizedExistingSessionId: string;
  /** Creation outcome of a Session the daemon committed before launch; its attaching runner reports none. */
  sessionCreationOutcome?: TrackedSession['sessionCreationOutcome'];
  effectiveResume: string;
  directoryCreated: boolean;
  extraEnvForChildWithMessage: Record<string, string>;
  unsetEnvKeys?: readonly string[];
  runnerAgentSessionBootstrapAuthorization?:
    RunnerAgentSessionBootstrapAuthorization | null;
  runnerAgentInvocationContext?: RunnerAgentInvocationContext | null;
  processEnv: NodeJS.ProcessEnv;
  pidToTrackedSession: Map<number, TrackedSession>;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
  pidToSpawnWebhookTimeout: Map<number, NodeJS.Timeout>;
  takeoverAdmission?: PersistedTakeoverAdmissionWaitRegistration;
  resolveCanonicalTrackedSessionId: (pid: number) => string;
  onChildExited: (pid: number, exit: ChildExit) => void | Promise<void>;
  spawnLifecycleCallbacks: SpawnLifecycleCallbacks;
  cleanupSpawnResources: () => void | Promise<void>;
  logDebug: (message: string, payload?: unknown) => void;
  warn: (message: string) => void;
  sanitizeDiagnosticText?: (value: string) => string;
  createStreamingSanitizer?: () => ProviderStreamingSanitizer;
  revalidateBeforeCommit?: SpawnCommitRevalidation;
  runnerLaunchOptions?: HappyCliSubprocessLaunchOptions;
  memoryHighBytes?: number | null;
  readSpawnFailureLimits?: SpawnFailureLimitsReader;
}>): Promise<SpawnSessionResult> {
  const processExecStartedAt = performance.now();
  const sanitizeDiagnosticText = params.sanitizeDiagnosticText ?? ((value: string) => value);
  const useLinuxCgroupSelfMigration = shouldUseSystemdUserSessionResourceGovernor({
    platform: process.platform,
    startupSource: String(params.processEnv.HAPPIER_DAEMON_STARTUP_SOURCE ?? '').trim(),
  });
  const runnerLaunchSpec = useLinuxCgroupSelfMigration
    ? buildHappyCliSubprocessLaunchSpec(Array.from(params.args), params.runnerLaunchOptions ?? { preferWindowsPackagedBinary: true })
    : null;
  const childEnv = buildSpawnChildProcessEnv({
    ...(params.normalizedExistingSessionId ? { processOwner: { kind: 'session' as const, sessionId: params.normalizedExistingSessionId } } : {}),
    ...(params.processEnv.HAPPIER_HOME_DIR ? { happierHomeDir: params.processEnv.HAPPIER_HOME_DIR } : {}),
    processEnv: params.processEnv,
    extraEnv: { ...params.extraEnvForChildWithMessage, ...(runnerLaunchSpec?.env ?? {}) },
    unsetEnvKeys: params.unsetEnvKeys,
  });
  const baseEnv = useLinuxCgroupSelfMigration && !params.normalizedExistingSessionId
    ? withHostProcessOwnerEnvironment(childEnv, readHostProcessOwnerTag(params.processEnv))
    : childEnv;
  const cgroupSelfMigratingLaunchSpec = runnerLaunchSpec
    ? await buildCgroupSelfMigratingHappyCliLaunchSpec({
      unit: createHappierLinuxScopeName(baseEnv.HAPPIER_PROCESS_OWNER),
      memoryHighBytes: params.memoryHighBytes,
      launchSpec: { ...runnerLaunchSpec, env: baseEnv },
      daemonPid: process.pid,
      environment: params.processEnv,
    })
    : null;
  const commitRefusal = await params.revalidateBeforeCommit?.() ?? null;
  if (commitRefusal) return commitRefusal;
  let happyProcess: ReturnType<typeof spawnChildProcess>;
  try {
    happyProcess = cgroupSelfMigratingLaunchSpec
    ? spawnChildProcess(cgroupSelfMigratingLaunchSpec.filePath, cgroupSelfMigratingLaunchSpec.args, {
      cwd: params.directory,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...baseEnv,
        ...(cgroupSelfMigratingLaunchSpec.env ?? {}),
      },
    })
    : spawnHappyCLI(Array.from(params.args), {
      cwd: params.directory,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: baseEnv,
    }, params.runnerLaunchOptions ?? { preferWindowsPackagedBinary: true });
  } catch (error) {
    const spawnFailure = classifySpawnFailure(error, { syscall: 'spawn', limits: params.readSpawnFailureLimits?.() });
    await params.cleanupSpawnResources();
    await params.spawnLifecycleCallbacks.cleanupPendingSessionAttach();
    return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: spawnFailureMessage(spawnFailure, 'Failed to spawn Happier process'),
      errorDetail: { kind: 'spawn_failure', ...spawnFailure } };
  }

  let capturedStderr: CapturedChildStderr = { head: '', tail: '' };
  observeProcessLaunch(happyProcess);
  const stderrSanitizer = params.createStreamingSanitizer?.() ?? null;
  const stdoutSanitizer = params.createStreamingSanitizer?.() ?? null;
  const sanitizeStreamChunk = (
    sanitizer: ProviderStreamingSanitizer | null,
    chunk: unknown,
  ): string => sanitizer
    ? sanitizer.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array))
    : sanitizeDiagnosticText(String(chunk ?? ''));
  const flushStreamingDiagnostics = () => {
    const stderrFinal = stderrSanitizer?.flush() ?? '';
    if (stderrFinal) capturedStderr = appendBoundedChildStderr(capturedStderr, stderrFinal);
    const stdoutFinal = stdoutSanitizer?.flush() ?? '';
    if (stdoutFinal && process.env.DEBUG) {
      params.logDebug(`[DAEMON RUN] Child stdout: ${stdoutFinal}`);
    }
  };
  happyProcess.stderr?.on('data', (data) => {
    const safeChunk = sanitizeStreamChunk(stderrSanitizer, data);
    if (safeChunk) capturedStderr = appendBoundedChildStderr(capturedStderr, safeChunk);
    if (safeChunk && process.env.DEBUG) {
      params.logDebug(`[DAEMON RUN] Child stderr: ${safeChunk}`);
    }
  });
  if (process.env.DEBUG) {
    happyProcess.stdout?.on('data', (data) => {
      const safeChunk = sanitizeStreamChunk(stdoutSanitizer, data);
      if (safeChunk) params.logDebug(`[DAEMON RUN] Child stdout: ${safeChunk}`);
    });
  }

  const pid = happyProcess.pid;
  if (typeof pid !== 'number') {
    // A failed Node OS spawn has no PID and emits its errno on the next tick.
    // Observe it before returning, so it cannot become an unhandled error.
    const error = await new Promise<Error>((resolve) => happyProcess.once('error', resolve));
    const spawnFailure = classifySpawnFailure(error, { syscall: 'spawn', limits: params.readSpawnFailureLimits?.() });
    params.logDebug('[DAEMON RUN] Failed to spawn process - no PID returned');
    await params.cleanupSpawnResources();
    await params.spawnLifecycleCallbacks.cleanupPendingSessionAttach();
    return {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_NO_PID,
      errorMessage: spawnFailureMessage(spawnFailure, 'Failed to spawn Happier process - no PID returned'),
      errorDetail: { kind: 'spawn_failure', ...spawnFailure },
    };
  }

  params.logDebug(`[DAEMON RUN] Spawned process with PID ${pid}`);
  params.logDebug('[DAEMON RUN] Spawn process phase', { phase: 'process_exec', pid,
    ...(params.normalizedExistingSessionId ? { sessionId: params.normalizedExistingSessionId } : {}),
    durationMs: Math.round(performance.now() - processExecStartedAt) });
  void applySpawnedChildOomScoreAdjustment({
    pid,
    env: params.processEnv,
    startupSource: String(params.processEnv.HAPPIER_DAEMON_STARTUP_SOURCE ?? '').trim() || undefined,
    logDebug: params.logDebug,
  });
  let resolveAcceptedSpawnMarker!: (accepted: boolean) => void;
  const acceptedSpawnMarkerGate = new Promise<boolean>((resolve) => {
    resolveAcceptedSpawnMarker = resolve;
  });
  const trackedSession: TrackedSession = {
    startedBy: 'daemon',
    happySessionId:
      params.normalizedExistingSessionId || `PID-${pid}`,
    pid,
    ...(cgroupSelfMigratingLaunchSpec?.linuxLaunchUnit ? { linuxLaunchUnit: cgroupSelfMigratingLaunchSpec.linuxLaunchUnit } : {}),
    childProcess: happyProcess,
    spawnOptions: params.trackedSpawnOptions,
    ...(params.sessionCreationOutcome
        ? { sessionCreationOutcome: params.sessionCreationOutcome }
        : {}),
    acceptedSpawnMarkerGate,
    ...(params.runnerAgentSessionBootstrapAuthorization ? {
      agentRuntimeDaemonServiceAuthorityFilePath:
        params.runnerAgentSessionBootstrapAuthorization
          .authorityFilePath,
      runnerAgentBootstrapIdentity: {
        agentId:
          params.runnerAgentSessionBootstrapAuthorization.descriptor.agentId,
        backendId:
          params.runnerAgentSessionBootstrapAuthorization.descriptor.backendId,
      },
    } : {}),
    ...(params.runnerAgentInvocationContext ? {
      runnerAgentInvocationContext:
        params.runnerAgentInvocationContext,
    } : {}),
    vendorResumeId: params.effectiveResume || undefined,
    directoryCreated: params.directoryCreated,
    message: params.directoryCreated
      ? `The path '${params.directory}' did not exist. We created a new folder and spawned a new session there.`
      : undefined,
  };
  const isOriginalProcessGroupAlive = (): boolean => {
    if (process.platform === 'win32') return false;
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  let startupLaunchCancellation: ReturnType<CancelStartupLaunch> | null =
    null;
  const cancelStartupLaunch: CancelStartupLaunch = () => {
    startupLaunchCancellation ??= (async () => {
      try {
        await params.cleanupSpawnResources();
      } catch {
        return {
          status: 'incomplete' as const,
          reason: 'exit_cleanup_incomplete' as const,
        };
      }
      if (process.platform === 'win32') {
        if (
          trackedSession.processStartTimeMs === undefined
        ) {
          return {
            status: 'incomplete' as const,
            reason:
              'terminal_host_custody_unproven' as const,
          };
        }
        const windowsDisposition =
          await createExactWindowsProcessCancellation({
            pid: trackedSession.pid,
            processStartTimeMs:
              trackedSession.processStartTimeMs,
            processCommandHash:
              trackedSession.processCommandHash,
          })();
        if (windowsDisposition.status !== 'stopped') {
          return windowsDisposition;
        }
      } else {
        await terminateProcessTree(happyProcess, { graceMs: 1_000 });
      }
      const ownedPids = Array.from(new Set([
        pid,
        trackedSession.pid,
        trackedSession.sessionRunnerPid,
      ].filter((candidate): candidate is number =>
        typeof candidate === 'number' && candidate > 0)));
      if (
        process.platform !== 'win32'
        && (
          isOriginalProcessGroupAlive()
          || ownedPids.some((ownedPid) => isPidPresent(ownedPid))
        )
      ) {
        return {
          status: 'incomplete' as const,
          reason: 'process_still_running' as const,
        };
      }
      return await completeStartupCancellationCleanup({
        trackedSession,
        wrapperPid: pid,
        pidToTrackedSession: params.pidToTrackedSession,
        onChildExited: params.onChildExited,
      });
    })();
    return startupLaunchCancellation;
  };
  trackedSession.cancelStartupLaunchBeforeAck =
    cancelStartupLaunch;
  let terminalObservation: Readonly<{
    failure: Extract<SpawnSessionResult, { type: 'error' }>;
    exit: ChildExit;
  }> | null = null;
  let spawnRequestSettled = false;
  let markerPublished = false;
  let terminalObservationPromise: Promise<void> | null = null;
  let custodyDenied = false;
  let provisionalAwaiter: ((session: TrackedSession) => void) | undefined;
  let provisionalResolver: ((result: SpawnSessionResult) => void) | undefined;
  let provisionalTimeout: NodeJS.Timeout | undefined;
  const clearExactProvisionalWaiterCustody = (): void => {
    if (params.pidToAwaiter.get(pid) === provisionalAwaiter) {
      params.pidToAwaiter.delete(pid);
    }
    if (params.pidToSpawnResultResolver.get(pid) === provisionalResolver) {
      params.pidToSpawnResultResolver.delete(pid);
    }
    if (provisionalTimeout) {
      clearTimeout(provisionalTimeout);
    }
    if (params.pidToSpawnWebhookTimeout.get(pid) === provisionalTimeout) {
      params.pidToSpawnWebhookTimeout.delete(pid);
    }
  };
  const settleProvisionalSpawnResult = (result: SpawnSessionResult): void => {
    if (!provisionalResolver) return;
    clearExactProvisionalWaiterCustody();
    provisionalResolver(result);
  };
  const retainsTrackedSessionOwner = (): boolean =>
    params.pidToTrackedSession.get(trackedSession.pid) === trackedSession;
  const delegateTerminalObservationIfStillOwned = (exit: ChildExit): Promise<void> | null => {
    if (params.pidToTrackedSession.get(pid) !== trackedSession) {
      return null;
    }
    const observation = Promise.resolve(params.onChildExited(pid, exit));
    void observation.catch((error) => {
      params.logDebug('[DAEMON RUN] Failed to observe terminal spawned child', error);
    });
    return observation;
  };

  const observeTerminalOnce = (
    failure: Extract<SpawnSessionResult, { type: 'error' }>,
    exit: ChildExit,
  ): void => {
    if (terminalObservation) return;
    terminalObservation = { failure, exit };

    if (params.pidToTrackedSession.get(pid) === trackedSession) {
      const observation = delegateTerminalObservationIfStillOwned(exit);
      if (observation) {
        terminalObservationPromise = observation.then(() => {
          // The canonical exit owner may retain unresolved runner custody at
          // the wrapper PID as well as promote it. Neither is a startup failure.
          if (!retainsTrackedSessionOwner()) {
            settleProvisionalSpawnResult(failure);
          }
        });
        return;
      }
    }
    if (!markerPublished && !custodyDenied) return;
    settleProvisionalSpawnResult(failure);
  };

  happyProcess.on('exit', (code, signal) => {
    if (terminalObservation) return;
    flushStreamingDiagnostics();
    const stderrTail = sanitizeChildStderrTail(capturedStderr.tail, sanitizeDiagnosticText);
    params.logDebug(`[DAEMON RUN] Child PID ${pid} exited with code ${code}, signal ${signal}`, stderrTail ? { stderrTail } : undefined);
    if (pid) {
      const failure = buildChildExitBeforeWebhookFailure({ pid, code, signal, stderrTail: capturedStderr.head,
        failureCause: capturedStderr.failureCause }, sanitizeDiagnosticText);
      observeTerminalOnce(failure, {
        reason: spawnRequestSettled ? 'process-exited' : 'process-exited-before-webhook',
        code,
        signal,
        stderrTail,
        childExit: failure.errorDetail.childExit,
        failureCause: failure.errorDetail.failureCause,
      });
    }
  });

  happyProcess.on('error', (error) => {
    const stderrTail = sanitizeChildStderrTail(capturedStderr.tail, sanitizeDiagnosticText);
    params.logDebug('[DAEMON RUN] Child process error:', {
      error: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)),
      stderrTail,
    });
  });

  params.pidToTrackedSession.set(pid, trackedSession);
  params.spawnLifecycleCallbacks.onTrackedSessionRegistered?.(trackedSession);
  params.spawnLifecycleCallbacks.consumeSessionAttachCleanupForPid(pid);
  params.spawnLifecycleCallbacks.registerSpawnResourceCleanupForPid(pid);
  params.logDebug(`[DAEMON RUN] Waiting for session webhook for PID ${pid}`);
  const spawnResultPromise = waitForSessionWebhook({
    pid,
    pidToAwaiter: params.pidToAwaiter,
    takeoverAdmission: params.takeoverAdmission,
    pidToSpawnResultResolver: params.pidToSpawnResultResolver,
    pidToSpawnWebhookTimeout: params.pidToSpawnWebhookTimeout,
    pidToTrackedSession: params.pidToTrackedSession,
    timeoutErrorMessage: `Session webhook timeout for PID ${pid}`,
    onTimeout: (timedOutTrackedSession) => {
      params.logDebug(`[DAEMON RUN] Session webhook timeout for PID ${pid}`);
      void timedOutTrackedSession;
    },
  });
  provisionalAwaiter = params.pidToAwaiter.get(pid);
  provisionalResolver = params.pidToSpawnResultResolver.get(pid);
  provisionalTimeout = params.pidToSpawnWebhookTimeout.get(pid);
  const removeExactProvisionalCustody = (): void => {
    if (params.pidToTrackedSession.get(pid) === trackedSession) {
      params.pidToTrackedSession.delete(pid);
    }
    clearExactProvisionalWaiterCustody();
  };
  const acceptedRegistration = params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker(trackedSession).then(() => {
    const acceptedPid = trackedSession.pid;
    if (params.pidToTrackedSession.get(acceptedPid) !== trackedSession) return;
    params.spawnLifecycleCallbacks.registerConnectedServiceSpawnTarget(acceptedPid);
    trackedSession.acceptedSpawnMarkerGate = undefined;
    resolveAcceptedSpawnMarker(true);
  });
  armSessionWebhookStartupCustody(trackedSession, spawnResultPromise, acceptedRegistration);

  try {
    await acceptedRegistration;
  } catch (error) {
    spawnRequestSettled = true;
    custodyDenied = true;
    resolveAcceptedSpawnMarker(false);
    clearExactProvisionalWaiterCustody();
    if (
      params.pidToTrackedSession.get(trackedSession.pid)
      === trackedSession
    ) {
      tombstoneTrackedSessionWebhookPids(pid, trackedSession);
      const incompleteRetirement =
        resolveSpawnErrorAfterStartupCancellation(
          await cancelStartupLaunch(),
        );
      if (incompleteRetirement) {
        throw new Error(incompleteRetirement);
      }
    }
    throw error;
  }

  markerPublished = true;
  let ownsTrackedPidAfterMarker =
    params.pidToTrackedSession.get(pid) === trackedSession;
  // EventEmitter callbacks mutate this after TypeScript's synchronous control-flow pass.
  const pendingTerminalObservation = terminalObservation as typeof terminalObservation | Readonly<{
    failure: Extract<SpawnSessionResult, { type: 'error' }>;
    exit: ChildExit;
  }>;
  if (pendingTerminalObservation) {
    const observation = terminalObservationPromise ?? delegateTerminalObservationIfStillOwned(
      pendingTerminalObservation.exit,
    );
    terminalObservationPromise = observation;
    if (observation) {
      await observation;
    }
    if (!retainsTrackedSessionOwner()) {
      if (ownsTrackedPidAfterMarker) {
        params.spawnLifecycleCallbacks.consumeSessionAttachCleanupForPid(pid);
      }
      settleProvisionalSpawnResult(pendingTerminalObservation.failure);
      resolveAcceptedSpawnMarker(false);
      trackedSession.acceptedSpawnMarkerGate = undefined;
      spawnRequestSettled = true;
      return pendingTerminalObservation.failure;
    }
    terminalObservation = null;
    ownsTrackedPidAfterMarker =
      params.pidToTrackedSession.get(trackedSession.pid)
      === trackedSession;
  }
  if (!ownsTrackedPidAfterMarker) {
    resolveAcceptedSpawnMarker(false);
    trackedSession.acceptedSpawnMarkerGate = undefined;
    clearExactProvisionalWaiterCustody();
    spawnRequestSettled = true;
    return {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: `Spawn custody for PID ${pid} was superseded before marker acceptance completed`,
    };
  }
  const spawnResult = await spawnResultPromise;
  spawnRequestSettled = true;
  if (
    spawnResult.type === 'error'
    && (
      trackedSession.spawnStartupReadinessFailure
      || typeof trackedSession.sessionWebhookTimedOutAtMs === 'number'
    )
  ) {
    custodyDenied = true;
    const incompleteRetirement =
      resolveSpawnErrorAfterStartupCancellation(
        await cancelStartupLaunch(),
      );
    if (incompleteRetirement) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
        errorMessage: incompleteRetirement,
      };
    }
    // Generic SPAWN_FAILED is not terminal custody evidence. Publish this
    // exact proof only after the incumbent cancellation owner verified exit
    // and completed cleanup; a deadline or failed retirement supplies none.
    return projectRetiredStartupLaunchResult({ result: spawnResult,
      readinessFailure: trackedSession.spawnStartupReadinessFailure,
      spawnNonce: params.options.spawnNonce, wrapperPid: pid });
  }
  if (spawnResult.type === 'success') {
    delete trackedSession.cancelStartupLaunchBeforeAck;
    params.logDebug('[DAEMON RUN] Session fully spawned with webhook');
  }
  return resolveSpawnWebhookResult({
    pid,
    result: spawnResult,
    pidToTrackedSession: params.pidToTrackedSession,
    warn: params.warn,
  });
}
