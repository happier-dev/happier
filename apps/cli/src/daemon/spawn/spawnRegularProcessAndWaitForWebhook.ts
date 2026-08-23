import { spawn as spawnChildProcess } from 'node:child_process';

import { redactBugReportSensitiveText, trimBugReportTextToMaxBytes } from '@happier-dev/protocol';

import type { ChildExit } from '../sessions/onChildExited';
import { resolveSpawnWebhookResult } from '../sessions/resolveSpawnWebhookResult';
import type {
  RunnerAgentInvocationContext,
  TrackedSession,
} from '../types';
import type {
  RunnerAgentSessionBootstrapAuthorization,
} from '../agentRuntime/sessionBridgeAuthorization';
import { spawnHappyCLI, type HappyCliSubprocessLaunchOptions } from '@/utils/spawnHappyCLI';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionOptions, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';

import { buildSpawnChildProcessEnv } from './buildSpawnChildProcessEnv';
import { applySpawnedChildOomScoreAdjustment } from '../platform/linux/applySpawnedChildOomScoreAdjustment';
import { buildCgroupSelfMigratingHappyCliLaunchSpec } from '../platform/linux/buildCgroupSelfMigratingHappyCliLaunchSpec';
import type { SpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import {
  tombstoneTrackedSessionWebhookPids,
  waitForSessionWebhook,
} from './waitForSessionWebhook';
import type { SpawnCommitRevalidation } from './spawnCommitRevalidation';
import type { ProviderStreamingSanitizer } from '@/providers/spawn/redaction';
import {
  completeStartupCancellationCleanup,
  resolveSpawnErrorAfterStartupCancellation,
  type CancelStartupLaunch,
} from './startupLaunchCancellation';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { createExactWindowsProcessCancellation } from '../platform/windows/windowsProcessCustody';

const CHILD_STDERR_CAPTURE_MAX_CHARS = 16_384;
const CHILD_STDERR_DIAGNOSTIC_MAX_BYTES = 2_048;

function appendBoundedStderrTail(current: string, chunk: unknown): string {
  const next = `${current}${String(chunk ?? '')}`;
  return next.length > CHILD_STDERR_CAPTURE_MAX_CHARS
    ? next.slice(-CHILD_STDERR_CAPTURE_MAX_CHARS)
    : next;
}

function sanitizeChildStderrTail(
  stderrTail: string,
  sanitizeDiagnosticText: (value: string) => string,
): string | null {
  const trimmed = stderrTail.trim();
  if (!trimmed) return null;
  const redacted = redactBugReportSensitiveText(sanitizeDiagnosticText(trimmed));
  return trimBugReportTextToMaxBytes(redacted, CHILD_STDERR_DIAGNOSTIC_MAX_BYTES).trim() || null;
}

function appendRecentStderrDiagnostic(message: string, stderrTail: string | null): string {
  return stderrTail ? `${message}; recent stderr: ${stderrTail}` : message;
}

export async function spawnRegularProcessAndWaitForWebhook(params: Readonly<{
  args: readonly string[];
  directory: string;
  options: SpawnSessionOptions;
  trackedSpawnOptions: SpawnSessionOptions;
  normalizedExistingSessionId: string;
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
}>): Promise<SpawnSessionResult> {
  const sanitizeDiagnosticText = params.sanitizeDiagnosticText ?? ((value: string) => value);
  // NOTE: sessionId is reserved for future Happy session resume; we currently ignore it.
  const baseEnv = buildSpawnChildProcessEnv({
    processEnv: params.processEnv,
    extraEnv: params.extraEnvForChildWithMessage,
    unsetEnvKeys: params.unsetEnvKeys,
  });
  const useLinuxCgroupSelfMigration =
    process.platform === 'linux'
    && String(params.processEnv.HAPPIER_DAEMON_STARTUP_SOURCE ?? '').trim() === 'background-service';
  const cgroupSelfMigratingLaunchSpec = useLinuxCgroupSelfMigration
    ? await buildCgroupSelfMigratingHappyCliLaunchSpec({
      args: Array.from(params.args),
      daemonPid: process.pid,
      launchOptions: params.runnerLaunchOptions ?? { preferWindowsPackagedBinary: true },
    })
    : null;
  const commitRefusal = await params.revalidateBeforeCommit?.() ?? null;
  if (commitRefusal) return commitRefusal;
  const happyProcess = cgroupSelfMigratingLaunchSpec
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

  let capturedStderrTail = '';
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
    if (stderrFinal) capturedStderrTail = appendBoundedStderrTail(capturedStderrTail, stderrFinal);
    const stdoutFinal = stdoutSanitizer?.flush() ?? '';
    if (stdoutFinal && process.env.DEBUG) {
      params.logDebug(`[DAEMON RUN] Child stdout: ${stdoutFinal}`);
    }
  };
  happyProcess.stderr?.on('data', (data) => {
    const safeChunk = sanitizeStreamChunk(stderrSanitizer, data);
    if (safeChunk) capturedStderrTail = appendBoundedStderrTail(capturedStderrTail, safeChunk);
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
    params.logDebug('[DAEMON RUN] Failed to spawn process - no PID returned');
    await params.cleanupSpawnResources();
    await params.spawnLifecycleCallbacks.cleanupPendingSessionAttach();
    return {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_NO_PID,
      errorMessage: 'Failed to spawn Happier process - no PID returned',
    };
  }

  params.logDebug(`[DAEMON RUN] Spawned process with PID ${pid}`);
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
    childProcess: happyProcess,
    spawnOptions: params.trackedSpawnOptions,
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
  const isPidAlive = (candidatePid: number): boolean => {
    try {
      process.kill(candidatePid, 0);
      return true;
    } catch {
      return false;
    }
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
          || !trackedSession.processCommandHash
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
        await killProcessTree(happyProcess, { graceMs: 1_000 });
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
          || ownedPids.some(isPidAlive)
        )
      ) {
        return {
          status: 'incomplete' as const,
          reason: 'process_still_running' as const,
        };
      }
      return await completeStartupCancellationCleanup({
        trackedSession,
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

    if (markerPublished || custodyDenied) {
      const observation = delegateTerminalObservationIfStillOwned(exit);
      if (observation) {
        terminalObservationPromise = observation.then(() => {
          const promotedSameOwner = Array.from(
            params.pidToTrackedSession.values(),
          ).some(
            (candidate) =>
              candidate === trackedSession
              && candidate.pid !== pid,
          );
          if (!promotedSameOwner) {
            settleProvisionalSpawnResult(failure);
          }
        });
        return;
      }
    }
    if (!markerPublished && !custodyDenied) {
      return;
    }
    settleProvisionalSpawnResult(failure);
  };

  happyProcess.on('exit', (code, signal) => {
    if (terminalObservation) return;
    flushStreamingDiagnostics();
    const stderrTail = sanitizeChildStderrTail(capturedStderrTail, sanitizeDiagnosticText);
    params.logDebug(`[DAEMON RUN] Child PID ${pid} exited with code ${code}, signal ${signal}`, stderrTail ? { stderrTail } : undefined);
    if (pid) {
      const failure = {
        type: 'error' as const,
        errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
        errorMessage: appendRecentStderrDiagnostic(
          `Child process exited before session webhook (pid=${pid}, code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
          stderrTail,
        ),
      };
      observeTerminalOnce(failure, {
        reason: spawnRequestSettled ? 'process-exited' : 'process-exited-before-webhook',
        code,
        signal,
        stderrTail,
      });
    }
  });

  happyProcess.on('error', (error) => {
    const stderrTail = sanitizeChildStderrTail(capturedStderrTail, sanitizeDiagnosticText);
    params.logDebug('[DAEMON RUN] Child process error:', {
      error: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)),
      stderrTail,
    });
  });

  params.pidToTrackedSession.set(pid, trackedSession);
  params.logDebug(`[DAEMON RUN] Waiting for session webhook for PID ${pid}`);
  const spawnResultPromise = waitForSessionWebhook({
    pid,
    pidToAwaiter: params.pidToAwaiter,
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

  try {
    await params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker(trackedSession);
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
    const observation = delegateTerminalObservationIfStillOwned(
      pendingTerminalObservation.exit,
    );
    terminalObservationPromise = observation;
    if (observation) {
      await observation;
    }
    const promotedSameOwner = Array.from(
      params.pidToTrackedSession.values(),
    ).some(
      (candidate) =>
        candidate === trackedSession
        && candidate.pid !== pid,
    );
    if (!promotedSameOwner) {
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
  const acceptedPid = trackedSession.pid;
  params.spawnLifecycleCallbacks.consumeSessionAttachCleanupForPid(acceptedPid);
  params.spawnLifecycleCallbacks.registerConnectedServiceSpawnTarget(acceptedPid);
  params.spawnLifecycleCallbacks.registerSpawnResourceCleanupForPid(acceptedPid);
  trackedSession.acceptedSpawnMarkerGate = undefined;
  resolveAcceptedSpawnMarker(true);

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
