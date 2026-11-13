import type { SparedHeldAgentTransaction } from '@/daemon/processSupervision/sparedHeldAgents';
import { isPidPresent } from '@happier-dev/cli-common/process';
import type { ApiMachineClient } from '@/api/apiMachine';
import { logger } from '@/ui/logger';
import { writeSessionExitReport } from '@/session/diagnostics/sessionExitReport';

import type { TrackedSession } from '../types';
import type { OwnerRemainderPort } from '../processes/endOwnerRemainder';
import {
  promoteSessionMarkerPid,
  removeSessionMarker,
  removeSessionMarkerIfOwned,
  type SessionMarkerOwnership,
  updateSessionMarkerActiveTurn,
} from '../sessionRegistry';
import { cleanupSessionResources, type SessionAttachCleanupByKey, type SpawnResourceCleanupByKey } from './cleanupSessionResources';
import { promoteTrackedSessionPidCustody } from './promoteTrackedSessionPidCustody';
import { classifyTrackedSessionProcessPresence } from './isSessionRunnerActive';
import { readProcessRunState } from '../processRunState';
import { readProcessIdentityByPid } from '../processIdentity';
import { resolveTrackedSessionExitSettlementEvidence } from './resolveTrackedSessionExitSettlementEvidence';
import { stageObservedExit } from './stageObservedExit';
import type { SkillStore } from '@/prompts/skills/store/skillStore';
import { readRetainedPlainRunnerExitMarker } from './retireTerminalControlServiceability';
import type { SessionSpawnLaunchErrorV1 } from '@happier-dev/protocol/spawnSession';
import { settleFinalExitPublisher } from './sessionTerminalSettlement';
import { releaseUnretainedRequesterSessionRuntimeContext } from '../sessionEncryption/requesterSessionCredentials';
import { buildChildExitBeforeWebhookFailure } from '../spawn/childStderrDiagnostic';
import {
  isCurrentTrackedSession,
  trackedSessionsForProcess,
  untrackSession,
  type SessionTrackingKey,
  type TrackedSessionMap,
} from '@/daemon/sessions/sessionTrackingKey';

export type ChildExit = {
  reason: string;
  code: number | null;
  signal: string | null;
  stderrTail?: string | null;
  /** Producer-redacted startup diagnostic; custody forwards it without recapturing stderr. */
  childExit?: NonNullable<SessionSpawnLaunchErrorV1['childExit']>;
  failureCause?: SessionSpawnLaunchErrorV1['failureCause'];
  /**
   * The end of one Session of a session host (the host process lives on): observed for that
   * Session only. Absent = the process exited, observed for every Session it hosted.
   */
  trackingKey?: SessionTrackingKey;
};

function normalizeSessionId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveTrackedMarkerOwnership(tracked: TrackedSession): Readonly<{
  happySessionId: string;
  processCommandHash?: string;
  processStartTimeMs?: number;
}> {
  const happySessionId = normalizeSessionId(tracked.happySessionId) || `PID-${tracked.pid}`;
  // Exit retirement compares the captured OS evidence with the persisted record;
  // rereading a departed/reused PID or hashing launch arguments cannot supply it.
  return {
    happySessionId,
    ...(tracked.processCommandHash ? { processCommandHash: tracked.processCommandHash } : {}),
    ...(tracked.processStartTimeMs !== undefined ? { processStartTimeMs: tracked.processStartTimeMs } : {}),
  };
}

function isTrackedSessionAlive(tracked: TrackedSession): boolean {
  if (isPidPresent(tracked.pid)) return true;
  const runnerPid = tracked.sessionRunnerPid;
  return typeof runnerPid === 'number' && runnerPid !== tracked.pid && isPidPresent(runnerPid);
}

function findLiveReplacementForSameSession(
  trackedSessionsByKey: TrackedSessionMap,
  pid: number,
  tracked: TrackedSession,
): TrackedSession | null {
  const sessionId = normalizeSessionId(tracked.happySessionId);
  if (!sessionId) return null;

  for (const candidate of trackedSessionsByKey.values()) {
    if (candidate.pid === pid) continue;
    if (normalizeSessionId(candidate.happySessionId) !== sessionId) continue;
    if (isTrackedSessionAlive(candidate)) return candidate;
  }

  return null;
}

function isServerBackedSessionId(sessionId: string): boolean {
  return !/^PID-\d+$/.test(sessionId);
}

export type SessionNativeCredentialLifetimeAccount = Readonly<{
  credentials: import('@/persistence').StoredCredentials;
  serverHttpBaseUrl: string;
  homeServerIdentityId: string | null;
  accountId: string;
}>;

export type ChildExitHandler = ((pid: number, exit: ChildExit) => Promise<void>) & Readonly<{
  awaitPendingExits(): Promise<void>;
}>;

export function createOnChildExited(params: Readonly<{
  skillStore?: SkillStore;
  trackedSessionsByKey: TrackedSessionMap;
  ownerRemainder?: OwnerRemainderPort;
  /**
   * A crashed runner's live held primary Agent that its respawned runner may adopt
   * (null otherwise). Its tree is spared by this exit's remainder end; the respawn
   * owner ends it on every give-up.
   */
  spareHeldAgent?: (tracked: TrackedSession) => Promise<SparedHeldAgentTransaction | null>;
  observeSessionScopeExit?: (tracked: TrackedSession) => Promise<void>;
  processPresenceDependencies?: Readonly<{
    readProcessRunState?: typeof readProcessRunState;
    readProcessIdentityByPid?: typeof readProcessIdentityByPid;
  }>;
  spawnResourceCleanupByKey: SpawnResourceCleanupByKey;
  sessionAttachCleanupByKey: SessionAttachCleanupByKey;
  getApiMachineForSessions: () => Pick<ApiMachineClient,
    'enqueueDaemonTerminalExactTurnEnd' | 'captureMachineSessionTerminal' | 'finalizeMachineSessionTerminal'> | null;
  beforeUnexpectedExitSettlement?: (
    trackedSession: TrackedSession,
    exit: ChildExit,
    lifetimeAccount?: SessionNativeCredentialLifetimeAccount,
  ) => void | Promise<void>;
  onUnexpectedExit?: (trackedSession: TrackedSession, exit: ChildExit) => void | Promise<void>;
  /** Owning Session retirement only; PID cleanup and respawn retain installed
   * use. True confirms removal; prepared/no-effect success must be re-read if
   * terminal publication later needs another real exit trigger. */
  releaseSessionOwnedNativeBindings?: (sessionId: string, trackedSession: TrackedSession,
    lifetimeAccount?: SessionNativeCredentialLifetimeAccount) => Promise<boolean | void>;
  /**
   * Retire the managed children this Session runner owned, before anything respawns it.
   *
   * A runner that was killed or crashed ran none of its own disposal, and its managed services are
   * spawned detached, so they keep running with their port, listener and injected host credential.
   * Only reachable when no live runner still owns this session — a replacement PID means those
   * children still have their owner.
   */
  retireSessionRunnerOwnedManagedServices?: (
    input: Readonly<{ sessionId: string; trackedSession: TrackedSession; exit: ChildExit }>,
  ) => void | Promise<void>;
  isExitUnexpectedOverride?: (trackedSession: TrackedSession, exit: ChildExit) => boolean | null | undefined;
  onPidPromoted?: (input: Readonly<{ fromPid: number; toPid: number; trackedSession: TrackedSession }>) => void;
  shouldPreserveSessionMarkerOnExit?: (input: Readonly<{
    pid: number;
    trackedSession: TrackedSession;
    exit: ChildExit;
    unexpected: boolean;
  }>) => boolean | Promise<boolean>;
  onFinalTrackedSessionExitStaged?: (input: Readonly<{
    pid: number;
    trackedSession: TrackedSession;
    exit: ChildExit;
    observedAt: number;
  }>) => void | Promise<void>;
  removeSessionMarkerFn?: typeof removeSessionMarker;
  removeSessionMarkerIfOwnedFn?: typeof removeSessionMarkerIfOwned;
  promoteSessionMarkerFn?: typeof promoteSessionMarkerPid;
  updateSessionMarkerActiveTurnFn?: typeof updateSessionMarkerActiveTurn;
  stageObservedExitFn?: typeof stageObservedExit;
}>): ChildExitHandler {
  const {
    trackedSessionsByKey,
    spawnResourceCleanupByKey,
    sessionAttachCleanupByKey,
    getApiMachineForSessions,
    beforeUnexpectedExitSettlement,
    onUnexpectedExit,
    retireSessionRunnerOwnedManagedServices,
    isExitUnexpectedOverride,
    onPidPromoted,
    shouldPreserveSessionMarkerOnExit,
    onFinalTrackedSessionExitStaged,
    removeSessionMarkerFn,
    removeSessionMarkerIfOwnedFn = removeSessionMarkerIfOwned,
    promoteSessionMarkerFn = promoteSessionMarkerPid,
    updateSessionMarkerActiveTurnFn = updateSessionMarkerActiveTurn,
    stageObservedExitFn = stageObservedExit,
  } = params;

  const removeObservedSessionMarker = async (
    tracked: TrackedSession,
    isStillOwned: () => boolean,
    markerOwnership: SessionMarkerOwnership = resolveTrackedMarkerOwnership(tracked),
  ): Promise<void> => {
    if (removeSessionMarkerFn) {
      await removeSessionMarkerFn(tracked.trackingKey);
      return;
    }
    await removeSessionMarkerIfOwnedFn({
      trackingKey: tracked.trackingKey,
      ...markerOwnership,
      isStillOwned,
    });
  };

  type ExitLifetime = { account?: SessionNativeCredentialLifetimeAccount; nativeBindingsReleased: boolean; scopeExitObserved: boolean };
  // The spare decision is settled by this observation: handed to the respawn
  // owner, or ended on every other way out (early return or failure).
  const observeChildExit = async (pid: number, exit: ChildExit, tracked?: TrackedSession, lifetime?: ExitLifetime) => {
    const spare: { transaction: SparedHeldAgentTransaction | null } = { transaction: null };
    try {
      await observeChildExitWithSpare(pid, exit, spare, tracked, lifetime);
    } finally {
      await spare.transaction?.abandon();
    }
  };
  const observeChildExitWithSpare = async (pid: number, exit: ChildExit,
    spare: { transaction: SparedHeldAgentTransaction | null }, tracked: TrackedSession | undefined, lifetime?: ExitLifetime) => {
    const lifetimeAccount = lifetime?.account;
    // This Session is still tracked on the exited process (a wrapper→runner
    // promotion moves it to another pid).
    const isCurrentPidOwner = (): boolean => tracked !== undefined && isCurrentTrackedSession(trackedSessionsByKey, tracked) && tracked.pid === pid;
    if (exit.reason === 'process-missing' && tracked?.windowsTerminalLaunchCustody) {
      const presence = await classifyTrackedSessionProcessPresence({
        tracked,
        readProcessRunState: params.processPresenceDependencies?.readProcessRunState ?? readProcessRunState,
        readProcessIdentityByPid: params.processPresenceDependencies?.readProcessIdentityByPid ?? readProcessIdentityByPid,
      });
      if (!isCurrentPidOwner()) return;
      if (tracked.stopRequestedAtMs === undefined && presence !== 'absent'
        && (presence !== 'present' || !tracked.sessionRunnerPid || tracked.sessionRunnerPid === pid)) {
        logger.infoFile('[DAEMON RUN] Missing Windows dispatcher does not prove runner exit; retaining startup custody', { pid });
        return;
      }
    }
    logger.debug(`[DAEMON RUN] Removing exited process PID ${pid} from tracking`);
    const runnerPid = tracked?.sessionRunnerPid;
    const override = tracked && isExitUnexpectedOverride ? isExitUnexpectedOverride(tracked, exit) : null;
    if (tracked && typeof runnerPid === 'number' && runnerPid !== pid && isPidPresent(runnerPid)) {
      if (tracked.acceptedSpawnMarkerGate && !await tracked.acceptedSpawnMarkerGate) return;
      if (!isCurrentPidOwner()) return;
      const currentRunnerPid = tracked.sessionRunnerPid;
      let canPromoteRunner = typeof currentRunnerPid === 'number' && currentRunnerPid !== pid && isPidPresent(currentRunnerPid);
      if (canPromoteRunner && (tracked.runnerProcessIdentity || tracked.startupCustody)) {
        const presence = await classifyTrackedSessionProcessPresence({
          tracked,
          readProcessRunState: params.processPresenceDependencies?.readProcessRunState ?? readProcessRunState,
          readProcessIdentityByPid: params.processPresenceDependencies?.readProcessIdentityByPid ?? readProcessIdentityByPid,
        });
        if (!isCurrentPidOwner() || tracked.sessionRunnerPid !== currentRunnerPid || tracked.reportMarkerCustody?.retiring) return;
        if (presence === 'unknown' || presence === 'recoverable_stopped') {
          logger.infoFile('[DAEMON RUN] Runner generation unresolved; retaining wrapper custody', { pid, runnerPid: currentRunnerPid, presence });
          return;
        }
        canPromoteRunner = presence === 'present';
      }
      if (typeof currentRunnerPid === 'number' && canPromoteRunner) {
        logger.debug(`[DAEMON RUN] Wrapper PID ${pid} exited; promoting tracked session to runner PID ${currentRunnerPid}`);
        await promoteTrackedSessionPidCustody({
          fromPid: pid,
          toPid: currentRunnerPid,
          trackedSession: tracked,
          trackedSessionsByKey,
          promoteSessionMarkerFn,
          onPidPromoted,
        });
        return;
      }
    }

    if (tracked) {
      // Native open may still be pending after webhook custody has settled.
      // Retain the producer-validated cause before Home publication or cleanup,
      // so startup settlement does not depend on a later diagnostic HTTP read.
      if (exit.failureCause) {
        tracked.spawnStartupReadinessFailure ??= buildChildExitBeforeWebhookFailure({ pid, ...exit });
      }
      const startupCustody = tracked.startupCustody;
      startupCustody?.observeExit(exit);
      const markerCustody = tracked.reportMarkerCustody;
      tracked.reportMarkerCustody ??= { pending: Promise.resolve(), retiring: true };
      tracked.reportMarkerCustody.retiring = true;
      if (markerCustody) await markerCustody.pending;
      if (startupCustody) await startupCustody.finalization;
      if (!isCurrentPidOwner()) return;
      try {
        if (!lifetime?.scopeExitObserved) {
          await params.observeSessionScopeExit?.(tracked);
          if (lifetime) lifetime.scopeExitObserved = true;
        }
        await tracked.guardStopReceipt?.settle('stopped');
      } catch (error) {
        logger.warn('[DAEMON RUN] Session exit evidence settlement unavailable; retaining exit custody', { pid, error });
        return;
      }
      if (!isCurrentPidOwner()) return;
      const resourceCleanupStartedAtMs = Date.now();
      const observeStopExitPhase = async <T>(phase: 'pid_resources' | 'requester_release', operation: () => Promise<T>): Promise<T> => {
        if (typeof tracked.stopRequestedAtMs !== 'number') return await operation();
        const startedAtMs = Date.now();
        logger.infoFile('[DAEMON STOP] Runner exit phase started', { sessionId: tracked.happySessionId, pid, phase });
        try {
          return await operation();
        } finally {
          logger.infoFile('[DAEMON STOP] Runner exit phase settled', {
            sessionId: tracked.happySessionId, pid, phase, elapsedMs: Date.now() - startedAtMs,
          });
        }
      };
      const cleanupComplete = await observeStopExitPhase('pid_resources', () => cleanupSessionResources({
        trackingKey: tracked.trackingKey,
        spawnResourceCleanupByKey,
        sessionAttachCleanupByKey,
      }));
      if (!cleanupComplete || !isCurrentPidOwner()) return;
      const requester = tracked.requesterSessionRuntimeContext;
      // Consume only this PID's custody once its dependents have finished.
      // Another PID may still share it, including during overlapping cleanup.
      delete tracked.requesterSessionRuntimeContext;
      try {
        // Recovery may replace the launch-time requester. The observed runner
        // exit retires the current pointer after its dependent PID resources.
        await observeStopExitPhase('requester_release', async () => {
          if (requester) await releaseUnretainedRequesterSessionRuntimeContext(requester,
            [...trackedSessionsByKey.values()].map(candidate => candidate.requesterSessionRuntimeContext));
        });
      } catch (error) {
        if (requester && !tracked.requesterSessionRuntimeContext) tracked.requesterSessionRuntimeContext = requester;
        logger.warn('[DAEMON RUN] Requester retirement incomplete; retaining exit custody', { pid, error });
        return;
      }
      if (!isCurrentPidOwner()) return;
      if (typeof tracked.stopRequestedAtMs === 'number') {
        logger.infoFile('[DAEMON STOP] Runner exit resources completed', {
          sessionId: tracked.happySessionId, pid, elapsedMs: Date.now() - resourceCleanupStartedAtMs,
        });
      }
      const liveReplacement = findLiveReplacementForSameSession(trackedSessionsByKey, pid, tracked);
      const shouldReportSessionEnd = liveReplacement === null;
      const isUnexpectedBase =
        exit.reason === 'process-exited-before-webhook' ||
        exit.reason === 'process-error-before-webhook' ||
        exit.reason === 'process-missing' ||
        exit.reason === 'process-error' ||
        (typeof exit.code === 'number' && exit.code !== 0) ||
        (typeof exit.signal === 'string' && exit.signal.length > 0 && !['SIGTERM', 'SIGINT'].includes(exit.signal));
      const personRequestedKill = tracked.stopRequestedReason === 'user_process_kill'
        && typeof tracked.stopRequestedAtMs === 'number';
      const isUnexpected = !personRequestedKill && (typeof override === 'boolean' ? override
        : typeof tracked.stopRequestedAtMs !== 'number' && isUnexpectedBase);

      if (liveReplacement) {
        logger.debug('[DAEMON RUN] Skipping session-end for exited PID because another live PID owns the same session', {
          sessionId: tracked.happySessionId,
          exitedPid: pid,
          livePid: liveReplacement.pid,
        });
      }

      const finalSessionId = normalizeSessionId(tracked.happySessionId);
      // A physical exit (including Stop) leaves the Session resumable. Keep its
      // private birth so cold Resume selects the original requester Account.
      if (shouldReportSessionEnd && finalSessionId && params.skillStore) {
        try {
          const skillsStartedAtMs = Date.now();
          await params.skillStore.releaseSkillSessionDirs(finalSessionId);
          if (typeof tracked.stopRequestedAtMs === 'number') {
            logger.infoFile('[DAEMON STOP] Runner skill directory release completed', {
              sessionId: finalSessionId, elapsedMs: Date.now() - skillsStartedAtMs,
            });
          }
          // Account-wide inventory must not delay runner or explicit Stop retirement.
          void params.skillStore.collectSkillCache().catch((error) => {
            logger.warn('[DAEMON RUN] Skill cache collection unavailable', { sessionId: finalSessionId, error });
          });
        } catch (error) {
          // Startup reconciliation retries owner-local cleanup after an unavailable filesystem/library read.
          logger.warn('[DAEMON RUN] Skill session directory cleanup unavailable', { sessionId: finalSessionId, error });
        }
        if (!isCurrentPidOwner()) return;
      }
      if ((shouldReportSessionEnd || tracked.ownerRemainderCapture?.scope === 'subtree') && finalSessionId && params.ownerRemainder) {
        const remainderStartedAtMs = Date.now();
        // Only an unexpected exit of a daemon runner may be respawned and adopt its Agent.
        spare.transaction = shouldReportSessionEnd && isUnexpected && tracked.startedBy === 'daemon'
          && isServerBackedSessionId(finalSessionId) ? await params.spareHeldAgent?.(tracked) ?? null : null;
        const spared = spare.transaction?.held;
        if (spared) tracked.sparedHeldAgentV1 = { ...spared, ...(spare.transaction?.turnId ? { turnId: spare.transaction.turnId } : {}) };
        // A target-held Agent's pids are the target's: nothing on this Machine to spare.
        const sparedLocalHolder = spared && !tracked.spawnOptions?.managedTargetPlacement ? spared.holderPid : null;
        const remainder = await params.ownerRemainder.end({ kind: 'session', sessionId: finalSessionId }, tracked.ownerRemainderCapture,
          sparedLocalHolder !== null ? { spare: [sparedLocalHolder] } : undefined);
        tracked.ownerRemainderResult = remainder;
        if (typeof tracked.stopRequestedAtMs === 'number') {
          logger.infoFile('[DAEMON STOP] Runner remainder cleanup completed', {
            sessionId: finalSessionId, status: remainder.status, elapsedMs: Date.now() - remainderStartedAtMs,
          });
        }
        if (!isCurrentPidOwner()) return;
        if (remainder.status !== 'complete') {
          logger.warn('[DAEMON RUN] Runner remainder cleanup incomplete; survivors retained for left-behind observation', {
            sessionId: finalSessionId, status: remainder.status, outcomes: remainder.outcomes,
          });
        }
      }
      const hasServerBackedSession = Boolean(finalSessionId) && isServerBackedSessionId(finalSessionId);
      const actionableUnexpectedExit = shouldReportSessionEnd && isUnexpected && hasServerBackedSession;
      let finalPublisherUnavailable = false;
      const preserveTerminalHostMarker = !personRequestedKill && hasServerBackedSession && await shouldPreserveSessionMarkerOnExit?.({
        pid,
        trackedSession: tracked,
        exit,
        unexpected: actionableUnexpectedExit,
      }) === true;
      let shouldPreserveMarker = preserveTerminalHostMarker;
      // Explicit Stop still owes control-serviceability publication after this
      // exit callback. Keep its existing durable evidence until that owner settles.
      if (hasServerBackedSession && typeof tracked.stopRequestedAtMs === 'number'
          && await readRetainedPlainRunnerExitMarker(tracked)) shouldPreserveMarker = true;
      const apiMachineForSessions = getApiMachineForSessions();
      const observedAt = Date.now();
      const trackedExitSettlementEvidence = resolveTrackedSessionExitSettlementEvidence(tracked);
      if (
        actionableUnexpectedExit
        && typeof tracked.happySessionId === 'string'
        && tracked.happySessionId.trim().length > 0
      ) {
        try {
          await beforeUnexpectedExitSettlement?.(tracked, exit, ...(lifetimeAccount ? [lifetimeAccount] as const : [] as const));
        } catch (error) {
          logger.warn('[DAEMON RUN] Failed to capture unexpected runner exit authority; retaining marker evidence', {
            sessionId: tracked.happySessionId,
            pid,
            error,
          });
          return;
        }
      }
      if (
        shouldReportSessionEnd
        && !isUnexpected
        && finalSessionId
        && isServerBackedSessionId(finalSessionId)
      ) {
        try {
          if (!lifetime?.nativeBindingsReleased) {
            const confirmedRemoval = await params.releaseSessionOwnedNativeBindings?.(finalSessionId, tracked, ...(lifetimeAccount ? [lifetimeAccount] as const : [] as const));
            if (lifetime) lifetime.nativeBindingsReleased = confirmedRemoval === true;
          }
        } catch (error) {
          logger.warn('[DAEMON RUN] Native binding retirement unconfirmed; retaining exit custody', {
            sessionId: finalSessionId, pid, error,
          });
          throw error;
        }
        if (!isCurrentPidOwner()) return;
        // Exact turn settlement updates turn state only. Runner presence has its
        // own captured publisher authority even when that turn is already terminal.
        const publisherSettlement = apiMachineForSessions ? await settleFinalExitPublisher({
          apiMachine: apiMachineForSessions,
          sessionId: finalSessionId,
        }) : 'pending';
        finalPublisherUnavailable = publisherSettlement === 'unavailable';
        // Permanent Home refusal ends its publication obligation; independent
        // physical terminal-host evidence still keeps its original custody.
        if (finalPublisherUnavailable) shouldPreserveMarker = preserveTerminalHostMarker;
        if (publisherSettlement === 'pending') {
          if (!await readRetainedPlainRunnerExitMarker(tracked)) return;
          shouldPreserveMarker = true;
        }
      }
      const stagingStartedAtMs = Date.now();
      try {
        if (finalPublisherUnavailable) {
          // A permanently unavailable peer/Session cannot accept exact-turn or
          // control retirement. Release only this already-dead runner's evidence.
          if (!shouldPreserveMarker) {
            await removeObservedSessionMarker(tracked, isCurrentPidOwner);
          }
        } else await stageObservedExitFn({
          // A spared Agent's running turn is not ended here: the respawned runner
          // completes it, and the spare's give-up ends it (one turn owner at a time).
          trackedSession: spare.transaction
            ? { ...trackedExitSettlementEvidence, activeTurnId: undefined } : trackedExitSettlementEvidence,
          observedAt,
          enqueueExactTurnEnd: async (mutation) => {
            if (!apiMachineForSessions?.enqueueDaemonTerminalExactTurnEnd) {
              throw new Error('Daemon terminal mutation custody is unavailable');
            }
            await apiMachineForSessions.enqueueDaemonTerminalExactTurnEnd(mutation);
          },
          releaseMarkerEvidence: async ({ sessionId, turnId }) => {
            if (!isCurrentPidOwner()) return;
            if (shouldPreserveMarker) {
              if (turnId === null) return;
              await updateSessionMarkerActiveTurnFn({
                trackingKey: tracked.trackingKey,
                sessionId,
                activeTurnId: null,
              });
              return;
            }
            await removeObservedSessionMarker(tracked, isCurrentPidOwner);
          },
        });
        if (typeof tracked.stopRequestedAtMs === 'number') {
          logger.infoFile('[DAEMON STOP] Runner exit durable staging completed', {
            sessionId: tracked.happySessionId, pid, elapsedMs: Date.now() - stagingStartedAtMs,
          });
        }
      } catch (error) {
        logger.warn('[DAEMON RUN] Failed to durably stage observed runner exit; retaining marker evidence', {
          sessionId: tracked.happySessionId,
          pid,
          error,
        });
        return;
      }
      if (!isCurrentPidOwner()) {
        logger.debug('[DAEMON RUN] PID ownership changed during durable exit staging; preserving replacement custody', {
          pid,
          exitedSessionId: tracked.happySessionId,
        });
        return;
      }

      if (
        shouldReportSessionEnd
        && hasServerBackedSession
        && exit.reason !== 'startup-cancelled-before-ack'
        && onFinalTrackedSessionExitStaged
      ) {
        const recoveryStartedAtMs = Date.now();
        try {
          await onFinalTrackedSessionExitStaged({
            pid,
            trackedSession: tracked,
            exit,
            observedAt,
          });
          if (typeof tracked.stopRequestedAtMs === 'number') {
            logger.infoFile('[DAEMON STOP] Runner exit terminal recovery completed', {
              sessionId: tracked.happySessionId, pid, elapsedMs: Date.now() - recoveryStartedAtMs,
            });
          }
        } catch (error) {
          logger.warn('[DAEMON RUN] Failed to register the final runner exit with terminal-host recovery; retaining tracked custody', {
            sessionId: tracked.happySessionId,
            pid,
            error,
          });
          return;
        }
      }

      if (actionableUnexpectedExit && typeof tracked.happySessionId === 'string' && tracked.happySessionId.trim().length > 0) {
        try {
          await retireSessionRunnerOwnedManagedServices?.({
            sessionId: tracked.happySessionId,
            trackedSession: tracked,
            exit,
          });
        } catch (error) {
          logger.warn('[DAEMON RUN] Failed to retire managed services owned by an exited runner', {
            sessionId: tracked.happySessionId,
            pid,
            error,
          });
        }
        try {
          // The respawn owner now holds the spared Agent: respawn adopts it, every give-up ends it.
          if (onUnexpectedExit) spare.transaction?.handOff();
          await onUnexpectedExit?.(tracked, exit);
        } catch (error) {
          logger.debug('[DAEMON RUN] Failed to run onUnexpectedExit handler', error);
          throw error;
        }
      }
      void writeSessionExitReport({
        sessionId: tracked.happySessionId ?? null,
        pid,
        report: {
          observedAt,
          observedBy: 'daemon',
          reason: personRequestedKill ? 'killed_by_person' : exit.reason,
          ...(personRequestedKill ? {
            terminationKind: 'kill', terminationReason: 'user_request',
            terminationRequestedAt: tracked.stopRequestedAtMs,
          } : {}),
          code: exit.code,
          signal: exit.signal,
          stderrTail: exit.stderrTail ?? null,
        },
      }).catch((error) => logger.debug('[DAEMON RUN] Failed to write session exit report', error));
      if (!isCurrentPidOwner()) return;
      // Durable staging and the retained marker own pending Home publication.
      // A disconnected Machine must not retain a fully cleaned, dead runner in
      // the local inventory or prevent Stop from completing.
      if (isCurrentPidOwner()) {
        untrackSession(trackedSessionsByKey, tracked);
      }
      return;
    }
    // A process with no tracked Session holds no per-Session resources.
  };

  type ExitSettlement = { completion: Promise<void>; pending: boolean; lifetime: ExitLifetime };
  const inFlightByTrackedSession = new WeakMap<TrackedSession, ExitSettlement>();
  const isTrackedOnProcess = (trackedSession: TrackedSession, pid: number): boolean =>
    isCurrentTrackedSession(trackedSessionsByKey, trackedSession) && trackedSession.pid === pid;
  // A process exit is observed for every Session it hosts.
  const handleChildExit = async (pid: number, exit: ChildExit): Promise<void> => {
    const hosted = trackedSessionsForProcess(trackedSessionsByKey, pid)
      .filter(trackedSession => exit.trackingKey === undefined || trackedSession.trackingKey === exit.trackingKey);
    if (hosted.length === 0) {
      await observeChildExit(pid, exit);
      return;
    }
    await Promise.all(hosted.map(trackedSession => handleTrackedSessionExit(pid, exit, trackedSession)));
  };
  const handleTrackedSessionExit = async (pid: number, exit: ChildExit, trackedSession: TrackedSession): Promise<void> => {
    const existing = inFlightByTrackedSession.get(trackedSession);
    if (existing?.pending) {
      await existing.completion;
      if (exit.reason !== 'process-missing' && isTrackedOnProcess(trackedSession, pid)) {
        await handleTrackedSessionExit(pid, exit, trackedSession);
      }
      return;
    }

    const requesterBirth = trackedSession.requesterSessionRuntimeContext?.bootstrap;
    const lifetimeAccount = existing?.lifetime.account ?? (requesterBirth ? {
      credentials: requesterBirth.credentials, serverHttpBaseUrl: requesterBirth.serverHttpBaseUrl,
      homeServerIdentityId: requesterBirth.homeServerIdentityId ?? null, accountId: requesterBirth.attribution.accountId,
    } : undefined);
    const lifetime: ExitLifetime = existing?.lifetime ?? { nativeBindingsReleased: false, scopeExitObserved: false,
      ...(lifetimeAccount ? { account: lifetimeAccount } : {}) };
    const observation = observeChildExit(pid, exit, trackedSession, lifetime);
    const settlement: ExitSettlement = { completion: observation, pending: true, lifetime };
    inFlightByTrackedSession.set(trackedSession, settlement);
    try {
      await observation;
    } finally {
      settlement.pending = false;
      if (!isTrackedOnProcess(trackedSession, pid) && inFlightByTrackedSession.get(trackedSession) === settlement) {
        inFlightByTrackedSession.delete(trackedSession);
      }
    }
  };
  return Object.assign(handleChildExit, { async awaitPendingExits(): Promise<void> {
    const completions = [...new Set(trackedSessionsByKey.values())].flatMap(tracked => {
      const pending = inFlightByTrackedSession.get(tracked);
      return pending ? [pending.completion] : [];
    });
    const results = await Promise.allSettled(completions);
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  } });
}
