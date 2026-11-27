import type { PersistedTakeoverAdmissionWaitRegistration } from './persistedTakeoverAdmission';
import type { ChildProcess } from 'node:child_process';

import { buildChildExitBeforeWebhookFailure, sanitizeChildStderrTail, type CapturedChildStderr } from './childStderrDiagnostic';

import type { ChildExit } from '../sessions/onChildExited';
import type {
  RunnerAgentInvocationContext,
  TrackedSession,
} from '../types';
import type {
  RunnerAgentSessionBootstrapAuthorization,
} from '../agentRuntime/sessionBridgeAuthorization';
import type { HappyCliSubprocessLaunchOptions } from '@/utils/spawnHappyCLI';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionOptions, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';

import { buildSpawnChildProcessEnv } from './buildSpawnChildProcessEnv';
import { launchDetachedHappierProcess } from './launchDetachedHappierProcess';
import type { DaemonSessionHost, HostedSessionHandle } from '../sessionHost/daemonSessionHost';
import type { SessionHostLaunchRecordV1 } from '@/session/transport/rpc/localSessionRpcChannel';
import { readSessionRunnerStartingModeFromProcessCommand } from '../sessionRunnerRuntime/readSessionRunnerStartingMode';
import type { SpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import {
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
import type { SpawnFailureLimitsReader } from '@/processes/spawnFailure/classifySpawnFailure';
import { cleanupUnstartedLaunch } from './cleanupUnstartedLaunch';
import {
  SESSION_TRACKING_KEY_ENV,
  isCurrentTrackedSession,
  mintSessionTrackingKey,
  trackSession,
  untrackSession,
  type SessionTrackingKey,
  type TrackedSessionMap,
} from '@/daemon/sessions/sessionTrackingKey';

/** The process side of one spawned Session: its own runner, or its Session in the session host. */
type StartedSessionProcess = Readonly<{
  pid: number;
  childProcess?: ChildProcess;
  hosted?: HostedSessionHandle;
  linuxLaunchUnit?: string;
  readStderr(): CapturedChildStderr;
  flushDiagnostics(): void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  /** Startup cancellation: end this Session's process side and wait for it. */
  terminate(): Promise<void>;
}>;

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
  trackedSessionsByKey: TrackedSessionMap;
  spawnAwaiterByKey: Map<SessionTrackingKey, (session: TrackedSession) => void>;
  spawnResultResolverByKey: Map<SessionTrackingKey, (result: SpawnSessionResult) => void>;
  spawnWebhookTimeoutByKey: Map<SessionTrackingKey, NodeJS.Timeout>;
  takeoverAdmission?: PersistedTakeoverAdmissionWaitRegistration;
  resolveCanonicalTrackedSessionId: (trackingKey: SessionTrackingKey) => string;
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
  /** Placement: present when this headless Session joins the daemon's session host. */
  sessionHost?: DaemonSessionHost;
  releaseHostHold?: () => void;
  /** The Machine Account this launch was admitted under (session host launch record). */
  sessionHostLaunchAccount?: SessionHostLaunchRecordV1['account'];
}>): Promise<SpawnSessionResult> {
  const sanitizeDiagnosticText = params.sanitizeDiagnosticText ?? ((value: string) => value);
  const trackingKey = mintSessionTrackingKey();
  const extraEnv = { ...params.extraEnvForChildWithMessage, [SESSION_TRACKING_KEY_ENV]: trackingKey };
  let started: StartedSessionProcess;
  if (params.sessionHost) {
    // Placement: this Session joins the daemon's session host; no process is started for it when
    // the host already runs. The commit fence is the same as a runner launch's.
    const commitRefusal = await params.revalidateBeforeCommit?.() ?? null;
    if (commitRefusal) return commitRefusal;
    const sessionEnvironment = buildSpawnChildProcessEnv({
      ...(params.normalizedExistingSessionId ? { processOwner: { kind: 'session' as const, sessionId: params.normalizedExistingSessionId } } : {}),
      ...(params.processEnv.HAPPIER_HOME_DIR ? { happierHomeDir: params.processEnv.HAPPIER_HOME_DIR } : {}),
      processEnv: params.processEnv,
      extraEnv,
      unsetEnvKeys: params.unsetEnvKeys,
    });
    const added = await params.sessionHost.addSession({
      trackingKey,
      argv: params.args,
      env: Object.fromEntries(Object.entries(sessionEnvironment).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      cwd: params.directory,
      // What this admission already decided, so the host re-derives none of it (no credential).
      launch: {
        ...(params.sessionHostLaunchAccount ? { account: params.sessionHostLaunchAccount } : {}),
        ...(params.runnerAgentSessionBootstrapAuthorization?.bootstrap ? { runnerBootstrap: {
          path: params.runnerAgentSessionBootstrapAuthorization.bootstrapFilePath,
          bootstrap: params.runnerAgentSessionBootstrapAuthorization.bootstrap,
        } } : {}),
      },
    });
    params.releaseHostHold?.();
    if (added.status !== 'added') {
      await cleanupUnstartedLaunch(params);
      return added.result;
    }
    const hosted = added.session;
    let failureCause: CapturedChildStderr['failureCause'];
    started = {
      pid: hosted.hostPid,
      hosted,
      // Host stderr is shared: retain only this Session's typed end diagnostic.
      readStderr: () => ({ head: '', tail: '', ...(failureCause ? { failureCause } : {}) }),
      flushDiagnostics: () => {},
      onExit: (listener) => { void hosted.ended.then(end => {
        failureCause = end.failureCause;
        listener(end.exitCode, end.signal);
      }); },
      terminate: async () => {
        await hosted.end();
        await hosted.ended;
      },
    };
  } else {
    const launched = await launchDetachedHappierProcess({
      args: params.args,
      directory: params.directory,
      processEnv: params.processEnv,
      extraEnv,
      ...(params.unsetEnvKeys ? { unsetEnvKeys: params.unsetEnvKeys } : {}),
      ...(params.normalizedExistingSessionId ? { sessionId: params.normalizedExistingSessionId } : {}),
      ...(params.runnerLaunchOptions ? { runnerLaunchOptions: params.runnerLaunchOptions } : {}),
      memoryHighBytes: params.memoryHighBytes,
      ...(params.revalidateBeforeCommit ? { revalidateBeforeCommit: params.revalidateBeforeCommit } : {}),
      ...(params.readSpawnFailureLimits ? { readSpawnFailureLimits: params.readSpawnFailureLimits } : {}),
      logDebug: params.logDebug,
      sanitizeDiagnosticText,
      ...(params.createStreamingSanitizer ? { createStreamingSanitizer: params.createStreamingSanitizer } : {}),
    });
    if (launched.status === 'refused') return launched.result;
    if (launched.status === 'failed') {
      await cleanupUnstartedLaunch(params);
      return launched.result;
    }
    const { child } = launched.launch;
    child.on('error', (error) => {
      const stderrTail = sanitizeChildStderrTail(launched.launch.readStderr().tail, sanitizeDiagnosticText);
      params.logDebug('[DAEMON RUN] Child process error:', {
        error: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)),
        stderrTail,
      });
    });
    started = {
      pid: launched.launch.pid,
      childProcess: child,
      ...(launched.launch.linuxLaunchUnit ? { linuxLaunchUnit: launched.launch.linuxLaunchUnit } : {}),
      readStderr: launched.launch.readStderr,
      flushDiagnostics: launched.launch.flushDiagnostics,
      onExit: (listener) => { child.on('exit', listener); },
      terminate: () => terminateProcessTree(child, { graceMs: 1_000 }).then(() => undefined),
    };
  }
  const pid = started.pid;
  let observeHostedEnd!: () => void;
  const hostedEndObserved = new Promise<void>((resolve) => { observeHostedEnd = resolve; });
  let resolveAcceptedSpawnMarker!: (accepted: boolean) => void;
  const acceptedSpawnMarkerGate = new Promise<boolean>((resolve) => {
    resolveAcceptedSpawnMarker = resolve;
  });
  const trackedSession: TrackedSession = {
    trackingKey,
    startedBy: 'daemon',
    happySessionId:
      params.normalizedExistingSessionId || `PID-${pid}`,
    pid,
    ...(started.linuxLaunchUnit ? { linuxLaunchUnit: started.linuxLaunchUnit } : {}),
    ...(started.childProcess ? { childProcess: started.childProcess } : {}),
    ...(started.hosted ? {
      hostedSession: { end: started.hosted.end, observed: hostedEndObserved },
      sessionRunnerStartingMode: readSessionRunnerStartingModeFromProcessCommand(params.args.join(' ')),
    } : {}),
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
      ? `The path '${params.trackedSpawnOptions.directory}' did not exist. We created a new folder and spawned a new session there.`
      : undefined,
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
      if (started.hosted) {
        // Never a signal to the host pid: that would end every Session of the host. The host ends
        // this Session; its end is observed for this Session only (the host pid stays alive).
        await started.terminate();
        await hostedEndObserved;
        return isCurrentTrackedSession(params.trackedSessionsByKey, trackedSession)
          ? { status: 'incomplete' as const, reason: 'exit_cleanup_incomplete' as const }
          : { status: 'stopped' as const };
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
        await started.terminate();
      }
      return await completeStartupCancellationCleanup({
        trackedSession,
        wrapperPid: pid,
        trackedSessionsByKey: params.trackedSessionsByKey,
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
    if (params.spawnAwaiterByKey.get(trackingKey) === provisionalAwaiter) {
      params.spawnAwaiterByKey.delete(trackingKey);
    }
    if (params.spawnResultResolverByKey.get(trackingKey) === provisionalResolver) {
      params.spawnResultResolverByKey.delete(trackingKey);
    }
    if (provisionalTimeout) {
      clearTimeout(provisionalTimeout);
    }
    if (params.spawnWebhookTimeoutByKey.get(trackingKey) === provisionalTimeout) {
      params.spawnWebhookTimeoutByKey.delete(trackingKey);
    }
  };
  const settleProvisionalSpawnResult = (result: SpawnSessionResult): void => {
    if (!provisionalResolver) return;
    clearExactProvisionalWaiterCustody();
    provisionalResolver(result);
  };
  const retainsTrackedSessionOwner = (): boolean =>
    isCurrentTrackedSession(params.trackedSessionsByKey, trackedSession);
  const delegateTerminalObservationIfStillOwned = (exit: ChildExit): Promise<void> | null => {
    if (!isCurrentTrackedSession(params.trackedSessionsByKey, trackedSession)) {
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

    if (isCurrentTrackedSession(params.trackedSessionsByKey, trackedSession)) {
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

  started.onExit((code, signal) => {
    if (terminalObservation) return;
    started.flushDiagnostics();
    const capturedStderr = started.readStderr();
    const stderrTail = sanitizeChildStderrTail(capturedStderr.tail, sanitizeDiagnosticText);
    params.logDebug(`[DAEMON RUN] ${started.hosted ? `Hosted Session ${trackingKey} of PID` : 'Child PID'} ${pid} exited with code ${code}, signal ${signal}`, stderrTail ? { stderrTail } : undefined);
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
        // A hosted Session's end is that Session's only; the host process lives on.
        ...(started.hosted ? { trackingKey } : {}),
      });
    }
    void (terminalObservationPromise ?? Promise.resolve()).catch(() => undefined).then(() => observeHostedEnd());
  });

  trackSession(params.trackedSessionsByKey, trackedSession);
  params.spawnLifecycleCallbacks.onTrackedSessionRegistered?.(trackedSession);
  params.spawnLifecycleCallbacks.consumeSessionAttachCleanupForSession(trackingKey);
  params.spawnLifecycleCallbacks.registerSpawnResourceCleanupForSession(trackingKey);
  params.logDebug(`[DAEMON RUN] Waiting for session webhook for PID ${pid}`);
  const spawnResultPromise = waitForSessionWebhook({
    trackingKey,
    pid,
    spawnAwaiterByKey: params.spawnAwaiterByKey,
    takeoverAdmission: params.takeoverAdmission,
    spawnResultResolverByKey: params.spawnResultResolverByKey,
    spawnWebhookTimeoutByKey: params.spawnWebhookTimeoutByKey,
    trackedSessionsByKey: params.trackedSessionsByKey,
    timeoutErrorMessage: `Session webhook timeout for PID ${pid}`,
    onTimeout: (timedOutTrackedSession) => {
      params.logDebug(`[DAEMON RUN] Session webhook timeout for PID ${pid}`);
      void timedOutTrackedSession;
    },
  });
  provisionalAwaiter = params.spawnAwaiterByKey.get(trackingKey);
  provisionalResolver = params.spawnResultResolverByKey.get(trackingKey);
  provisionalTimeout = params.spawnWebhookTimeoutByKey.get(trackingKey);
  const removeExactProvisionalCustody = (): void => {
    untrackSession(params.trackedSessionsByKey, trackedSession);
    clearExactProvisionalWaiterCustody();
  };
  const acceptedRegistration = params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker(trackedSession).then(() => {
    const acceptedPid = trackedSession.pid;
    if (!isCurrentTrackedSession(params.trackedSessionsByKey, trackedSession)) return;
    params.spawnLifecycleCallbacks.registerConnectedServiceSpawnTarget(acceptedPid, trackedSession.trackingKey);
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
      isCurrentTrackedSession(params.trackedSessionsByKey, trackedSession)
    ) {
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
    isCurrentTrackedSession(params.trackedSessionsByKey, trackedSession);
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
        params.spawnLifecycleCallbacks.consumeSessionAttachCleanupForSession(trackingKey);
      }
      settleProvisionalSpawnResult(pendingTerminalObservation.failure);
      resolveAcceptedSpawnMarker(false);
      trackedSession.acceptedSpawnMarkerGate = undefined;
      spawnRequestSettled = true;
      return pendingTerminalObservation.failure;
    }
    terminalObservation = null;
    ownsTrackedPidAfterMarker =
      isCurrentTrackedSession(params.trackedSessionsByKey, trackedSession);
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
  return spawnResult;
}
