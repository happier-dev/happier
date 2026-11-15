import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { randomBytes } from 'node:crypto';
import { backfillAutomationManagedTargetsV1 } from '@happier-dev/protocol/actions/executor/workflowTriggerAccountHost';
import { listAutomationDefinitionDetails, updateAutomationDefinition } from '@/api/automations';
import { resolveAutomationWorkerAccountEncryption } from '@/plugins/runtime/automations/automationAccountCurrentness';
import { createAutomationAssignmentCache } from './automationAssignmentCache';
import { createAutomationRunLifecycleObservers } from './automationRunLifecycleObservers';
import {
  classifyAutomationWorkerError,
  nextAutomationRetryDelayMs,
} from './automationBackoffPolicy';
import {
  createAutomationClaimClient,
} from './automationClaimClient';
import { getAutomationWorkerFeatureDecision } from './automationFeatureGate';
import { executeClaimedRun, type ClaimableRunPayload } from './automationRunExecutor';
import { resolveAutomationPollingConfig } from './automationScheduler';
import { logAutomationInfo, logAutomationWarn } from './automationTelemetry';
import { logger } from '@/ui/logger';
import type {
  AutomationClaimedRunPayload,
  AutomationClaimRunResponse,
} from './automationTypes';
import type { Update } from '@/api/types';
import { readStoredCredentials, sameStoredCredentials, type StoredCredentials } from '@/persistence';
import { DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE, isTerminalAutomationRunStateV3 } from '@happier-dev/protocol/automations/automationApiV3';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { invalidateActiveAutomationRun } from './automationRunInvalidation';
import type { sendSessionMessage } from '@/session/services/sendSessionMessage';
import type { createProductionWorkflowRunCoordinator } from '@/daemon/workflows/production';
import type { DaemonAdmissionDrain } from '../lifecycle/admissionDrain';
import type { LiveWorkItemV1, LiveWorkListenerV1, LiveWorkProducerV1 } from '../lifecycle/managedActivity';
import { RequesterWorkAttributionV1Schema, type RequesterWorkAttributionV1 } from '../lifecycle/requesterWorkAttribution';
import { armDeadlineTimer } from '@happier-dev/protocol/common/deadlineTimer';
import { configuration } from '@/configuration';
import { acquireWorkflowRequesterCredentials, createWorkflowRequesterCustody, listWorkflowRequesterCredentialScopes, observeWorkflowRequesterCredentialCustody, reconcileWorkflowRequesterCredentialScope, retireWorkflowRequesterCredentials, settleWorkflowRequesterCredentialRetirement } from '../workflows/requesterCustody';

type AutomationMachineAdmissionTransport = NonNullable<
  Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport']
>;

export type AutomationWorkerHandle = Readonly<{
  liveWorkProducer: LiveWorkProducerV1;
  stop: () => void;
  refreshAssignments: () => Promise<void>;
  /** Rejoin durable queued work after connection or changes-feed recovery. */
  catchUp: () => Promise<void>;
  handleServerUpdate: (update: Update) => void;
  pause: () => void;
  resume: () => void;
}>;

function toClaimableRunPayload(claimResult: AutomationClaimRunResponse): ClaimableRunPayload | null {
  if (claimResult.run === null) {
    return null;
  }
  return claimResult as AutomationClaimedRunPayload;
}

export function startAutomationWorker(params: {
  requesterWorkAttributionV1?: RequesterWorkAttributionV1;
  admissionDrain?: DaemonAdmissionDrain;
  token: string;
  credentials: StoredCredentials;
  machineId: string;
  requesterHomeServerIdentityId?: string;
  machineAdmissionTransport?: AutomationMachineAdmissionTransport;
  env?: NodeJS.ProcessEnv;
  coordinateWorkflowRun?: (claim: Parameters<ReturnType<typeof createProductionWorkflowRunCoordinator>>[0], requester?: Readonly<{
    credentials: StoredCredentials; attribution: RequesterWorkAttributionV1;
  }>) => ReturnType<ReturnType<typeof createProductionWorkflowRunCoordinator>>;
  /** Existing custody reader, woken by control invalidation or release of a Workflow claim. */
  recoverWorkflowRuns?: (runId?: string, requester?: Readonly<{ credentials: StoredCredentials; attribution: RequesterWorkAttributionV1 }>, signal?: AbortSignal) => Promise<void>;
}): AutomationWorkerHandle {
  const env = params.env ?? process.env;
  const workerDecision = getAutomationWorkerFeatureDecision(env);
  const assignments = createAutomationAssignmentCache();
  if (workerDecision.state !== 'enabled') {
    logAutomationInfo('Automation worker disabled', {
      machineId: params.machineId,
      blockedBy: workerDecision.blockedBy,
      blockerCode: workerDecision.blockerCode,
    });
    return {
      liveWorkProducer: { read: () => ({ coverage: 'complete', items: [] }), subscribe: () => () => {} },
      stop: () => {
        logAutomationInfo('Automation worker stop called while disabled', {
          machineId: params.machineId,
          blockedBy: workerDecision.blockedBy,
          blockerCode: workerDecision.blockerCode,
        });
      },
      refreshAssignments: async () => {},
      catchUp: async () => {},
      handleServerUpdate: () => {},
      pause: () => {},
      resume: () => {},
    };
  }

  const scheduler = resolveAutomationPollingConfig(env);
  const attribution = params.requesterWorkAttributionV1
    ? Object.freeze(RequesterWorkAttributionV1Schema.parse(params.requesterWorkAttributionV1)) : { kind: 'unknown' as const };
  const claimClient = createAutomationClaimClient({ token: params.token });
  const requesterWakes = new Map<string, { scopeId: string; runId?: string; nextClaimAt: number }>();

  let stopped = false;
  let requesterCustodyObservation: ReturnType<typeof observeWorkflowRequesterCredentialCustody> | undefined;
  const observeRequesterCustody = () => {
    const host = params.requesterWorkAttributionV1;
    if (!host || !params.requesterHomeServerIdentityId) return;
    requesterCustodyObservation = observeWorkflowRequesterCredentialCustody({ happyHomeDir: configuration.happyHomeDir,
      serverId: host.serverId, machineId: params.machineId, installationId: host.installationId,
      homeServerIdentityId: params.requesterHomeServerIdentityId, hostAccountId: host.accountId,
      serverHttpBaseUrl: resolveServerHttpBaseUrl(), onError: error =>
        logAutomationWarn('Workflow requester custody observation failed', error, { machineId: params.machineId }) });
  };
  const workerCancellation = new AbortController();
  const managedTargetBackfillCancellation = new AbortController();
  let paused = false;
  // These values govern only the one claim request loop. A per-Run executor
  // failure is already reflected in that Run's server-owned lifecycle and
  // must not race another claim's retry state.
  let claimReadFailed = false;
  let claimRetryAfter = 0;
  let pendingQueuedWake = false;
  let assignmentReadFailed = false;
  let assignmentRetryAfter = 0;
  const directRunClaimDeadlines = new Map<string, number>();
  let assignmentReadInFlight: Promise<void> | null = null;
  let assignmentReadCancellation: AbortController | null = null;
  let assignmentRefreshPending = false;

  let claimTimer: (() => void) | null = null;
  let claimTimerAt = 0;
  let claimInFlight: Promise<void> | null = null;
  // One map owns capacity and cancellation. Workflow claims open their private
  // accepted graph before reserving a slot; existing-Session writes reserve none.
  const activeExecutions = new Map<string, {
    runId: string;
    automationId: string | null;
    scopeSessionId?: string | null;
    consumesStartCapacity: boolean;
    attempt: number;
    controller: AbortController;
    refreshReviewHolds?: () => void;
    materialWorkReleased?: boolean;
    coordinatorWork?: LiveWorkProducerV1;
    unsubscribeCoordinatorWork?: () => void;
  }>();
  const activityListeners = new Set<LiveWorkListenerV1>();
  const publishActivity: LiveWorkListenerV1 = change => { for (const listener of activityListeners) listener(change); };
  const liveWorkProducer: LiveWorkProducerV1 = {
    read: async () => {
      // A claim is an observation until Home returns material custody. Join
      // its completion so an empty claim observation cannot reset aggregate idle,
      // and a drain cannot prove absence while a claim may still acquire work.
      if (claimInFlight) await claimInFlight;
      const items: LiveWorkItemV1[] = [];
      // An unreadable claim may have acquired a Run. The existing retry owner
      // clears this marker only after a valid authoritative claim response.
      let coverage: 'complete' | 'unknown' = claimReadFailed || assignmentReadFailed ? 'unknown' : 'complete';
      for (const active of activeExecutions.values()) {
        if (active.materialWorkReleased) continue;
        if (active.coordinatorWork) {
          try {
            const observation = await active.coordinatorWork.read();
            items.push(...observation.items);
            // Registration/closure borders the coordinator's owned lifetime;
            // until the worker settles, preparation/commit custody still holds.
            if (observation.items.length === 0 && !active.materialWorkReleased) {
              items.push({ category: 'workflow_run', ownerRef: active.runId,
                attribution, state: 'active' });
            }
            if (observation.coverage === 'unknown') coverage = 'unknown';
          } catch { coverage = 'unknown'; }
        } else {
          items.push({ category: 'workflow_run', ownerRef: active.runId,
            attribution, state: 'active' });
        }
      }
      return { items, coverage };
    },
    subscribe: listener => { activityListeners.add(listener); return () => { activityListeners.delete(listener); }; },
  };
  const capacityWaiters = new Set<() => void>();
  const wakeCapacityWaiters = () => { for (const wake of capacityWaiters) wake(); };
  const actionExecutor = createCliActionExecutorFromCredentials({
      credentials: params.credentials,
      readCredentials: async () => await readStoredCredentials().catch(() => null),
      machineId: params.machineId,
      isAutomationRunCurrent: (caller) => {
        const active = activeExecutions.get(caller.runId);
        return active?.runId === caller.runId && active.automationId === caller.automationId;
      },
      ...(params.machineAdmissionTransport
        ? { machineAdmissionTransport: params.machineAdmissionTransport }
        : {}),
    });
  let maxActiveRunsPerMachine = DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE;
  const sourceObservers = createAutomationRunLifecycleObservers({
    executor: actionExecutor,
    report: (occurrence, signal) => claimClient.reportRunLifecycle(params.machineId, occurrence, signal),
    onError: (error, source) => {
      requestAssignmentRecovery(error);
      logAutomationWarn('Run notification source observation failed; assignment recovery scheduled', error,
        { machineId: source.machineId, runId: source.runId });
    },
  });

  function clearClaimTimer() {
    if (claimTimer) {
      claimTimer();
      claimTimer = null;
      claimTimerAt = 0;
    }
  }

  function scheduleClaimAt(
    whenMs: number,
    reason: string,
    force = false,
    forceCapacityRefill = false,
  ) {
    if (stopped) return;
    if (paused) return;
    const at = Math.max(Date.now(), Math.floor(whenMs));
    if (params.admissionDrain?.isQuiescing()) return;
    if (!force && claimTimer && claimTimerAt > 0 && claimTimerAt <= at) {
      return;
    }
    clearClaimTimer();
    claimTimerAt = at;
    claimTimer = armDeadlineTimer(at, () => {
      claimTimer = null;
      claimTimerAt = 0;
      void runTick(reason, forceCapacityRefill);
    });
  }

  function scheduleClaimSoon(reason: string) {
    scheduleClaimAt(Date.now(), reason);
  }

  function scheduleCapacityRefill(reason: string) {
    // Yield through the existing claim timer. A synchronous mock or a very
    // fast terminal executor must not create an unbounded microtask chain
    // that starves cancellation, assignment refreshes, or the next timer.
    scheduleClaimAt(Date.now(), reason, true, true);
  }

  function scheduleAssignmentsRefreshSoon(reason: string) {
    if (stopped) return;
    if (paused) return;
    void refreshAssignments(reason, 'changed').catch((error) => {
        logAutomationWarn('Failed to refresh automation assignments (scheduled)', error, {
          machineId: params.machineId,
          reason,
        });
    });
  }

  function getNextClaimAtMs(futureOnly = false): number | null {
    const rows = assignments.getAll();
    let next: number | null = null;
    for (const row of rows) {
      const candidate = row.nextClaimAt;
      if (typeof candidate !== 'number' || !Number.isFinite(candidate)) continue;
      if (futureOnly && candidate <= Date.now()) continue;
      if (next === null || candidate < next) {
        next = candidate;
      }
    }
    for (const [runId, candidate] of directRunClaimDeadlines) {
      // A live executor owns its current lease. Retain the snapshot so a
      // failed dispatch's lease remains scheduled after execution releases it.
      if (activeExecutions.has(runId)) continue;
      if (futureOnly && candidate <= Date.now()) continue;
      if (next === null || candidate < next) next = candidate;
    }
    for (const wake of requesterWakes.values()) {
      if (futureOnly && wake.nextClaimAt <= Date.now()) continue;
      if (next === null || wake.nextClaimAt < next) next = wake.nextClaimAt;
    }
    return next;
  }

  function countActiveStartRuns(): number {
    let ordinaryActiveRuns = 0;
    for (const active of activeExecutions.values()) {
      if (active.consumesStartCapacity) ordinaryActiveRuns += 1;
    }
    return ordinaryActiveRuns;
  }

  function hasExecutionCapacity(): boolean {
    return countActiveStartRuns() < maxActiveRunsPerMachine;
  }

  async function acquireMachineStartCapacity(runId: string, controller: AbortController, signal?: AbortSignal): Promise<void> {
    const logPhase = (status: 'started' | 'completed') => logger.infoFile('[WORKFLOW] Run phase', {
      event: 'workflow_run_phase', runId, phase: 'machine_start_capacity', status,
      activeRuns: countActiveStartRuns(), maxActiveRunsPerMachine, paused,
      draining: params.admissionDrain?.isQuiescing() ?? false, timestamp: new Date().toISOString(),
    });
    logPhase('started');
    while (true) {
      signal?.throwIfAborted();
      const active = activeExecutions.get(runId);
      if (!active || active.controller !== controller) throw new Error('automation_claim_not_current');
      if (active.consumesStartCapacity) { logPhase('completed'); return; }
      if (!paused && !params.admissionDrain?.isQuiescing() && hasExecutionCapacity()) {
        active.consumesStartCapacity = true;
        logPhase('completed');
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { capacityWaiters.delete(wake); signal?.removeEventListener('abort', abort); };
        const wake = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(signal?.reason ?? new Error('automation_claim_cancelled')); };
        capacityWaiters.add(wake);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }

  function rescheduleClaim(reason: string, force = false, futureOnly = false) {
    if (stopped) return;
    const now = Date.now();
    const blockedUntil = Math.max(claimRetryAfter, assignmentRetryAfter);
    const claimBlocked = blockedUntil > now;
    const nextRunAt = getNextClaimAtMs(futureOnly || claimReadFailed || assignmentReadFailed);
    const candidates = [
      assignmentRetryAfter > now ? assignmentRetryAfter : null,
      claimRetryAfter > now || claimBlocked ? blockedUntil : null,
      // A due assignment cannot bypass an authoritative server Retry-After.
      claimBlocked ? null : nextRunAt,
    ].filter((candidate): candidate is number => candidate !== null);
    if (candidates.length === 0) {
      clearClaimTimer();
      return;
    }
    scheduleClaimAt(Math.min(...candidates), `${reason}:scheduled`, force);
  }

  function requestAssignmentRecovery(error: unknown) {
    assignmentReadFailed = true;
    const retryAfterMs = nextAutomationRetryDelayMs({ error });
    if (retryAfterMs !== null) assignmentRetryAfter = Math.max(assignmentRetryAfter, Date.now() + retryAfterMs);
    publishActivity('observation');
    if (!claimInFlight) rescheduleClaim('assignment-recovery', true);
  }

  const stopWorker = (reason: 'manual') => {
    if (stopped) return;
    stopped = true;
    cancelAssignmentRead();
    workerCancellation.abort();
    managedTargetBackfillCancellation.abort();
    unsubscribeAdmission?.();
    sourceObservers.clear();
    requesterCustodyObservation?.dispose();
    for (const active of activeExecutions.values()) {
      active.controller.abort();
    }
    clearClaimTimer();
    logAutomationInfo('Automation worker stopped', {
      machineId: params.machineId,
      reason,
    });
  };

  const invalidateActiveExecution = (update: Update) => {
    for (const active of activeExecutions.values()) {
      invalidateActiveAutomationRun({
        update,
        active,
        machineId: params.machineId,
      });
    }
  };

  const recoverWorkflowCustody = (runId: string, scopeId?: string) => {
    void (async () => {
      const host = params.requesterWorkAttributionV1;
      const requester = scopeId && host && params.requesterHomeServerIdentityId ? await acquireWorkflowRequesterCredentials({ scopeId,
        happyHomeDir: configuration.happyHomeDir, serverId: host.serverId, machineId: params.machineId,
        installationId: host.installationId, serverHttpBaseUrl: resolveServerHttpBaseUrl(), signal: workerCancellation.signal,
        ...(params.requesterHomeServerIdentityId ? { homeServerIdentityId: params.requesterHomeServerIdentityId } : {}) }) : null;
      if (scopeId && !requester) {
        await claimClient.reportRequesterCustodyUnavailable({ machineId: params.machineId, runId });
        return;
      }
      try { await params.recoverWorkflowRuns?.(runId, requester ?? undefined, workerCancellation.signal); }
      finally { await requester?.release(); }
    })().catch((error) => {
      logAutomationWarn('Workflow custody recovery failed; pending custody retained', error, {
        machineId: params.machineId,
        runId,
      });
    });
  };

  function cancelAssignmentRead() {
    assignmentReadCancellation?.abort();
    assignmentReadCancellation = null;
    assignmentReadInFlight = null;
    assignmentRefreshPending = false;
  }

  const refreshAssignments = async (wakeReason: string, demand: 'join' | 'changed' | 'supersede' = 'join') => {
    if (stopped || paused) return;
    if (assignmentRetryAfter > Date.now()) {
      rescheduleClaim('assignment-read-retry-after');
      return;
    }
    if (demand === 'supersede') cancelAssignmentRead();
    if (assignmentReadInFlight) {
      if (demand === 'changed') assignmentRefreshPending = true;
    } else {
      const cancellation = new AbortController();
      assignmentReadCancellation = cancellation;
      assignmentReadInFlight = (async () => {
        const previousMaxActiveRunsPerMachine = maxActiveRunsPerMachine;
        try {
          do {
            assignmentRefreshPending = false;
            const response = await claimClient.fetchAssignments(params.machineId, cancellation.signal);
            if (cancellation.signal.aborted || stopped || paused) return;
            maxActiveRunsPerMachine = response.settings.maxActiveRunsPerMachine;
            wakeCapacityWaiters();
            assignments.replace(response.assignments);
            directRunClaimDeadlines.clear();
            // Omission never installs a fallback poll for an older server.
            for (const deadline of response.directRunClaimDeadlines ?? []) {
              directRunClaimDeadlines.set(deadline.runId, deadline.nextClaimAt);
            }
            sourceObservers.replace(response.runLifecycleSources ?? []);
            const recoveredAssignmentRead = assignmentReadFailed;
            assignmentReadFailed = false;
            assignmentRetryAfter = 0;
            if (recoveredAssignmentRead) publishActivity('observation');
            logAutomationInfo('Assignments refreshed', {
              machineId: params.machineId, count: response.assignments.length, wakeReason,
            });
          } while (assignmentRefreshPending);
          // The active claim loop consumes this snapshot and owns its next wake.
          if (claimInFlight) return;
          if (pendingQueuedWake) {
            scheduleClaimSoon('queued-wake-after-assignments-refresh');
          } else if (maxActiveRunsPerMachine > previousMaxActiveRunsPerMachine && assignments.getAll().length > 0) {
            scheduleCapacityRefill('assignment-settings-capacity-increased');
          } else {
            rescheduleClaim('assignments-refreshed', true);
          }
        } catch (error) {
          if (cancellation.signal.aborted) return;
          requestAssignmentRecovery(error);
          logAutomationWarn('Failed to refresh automation assignments', error, { machineId: params.machineId });
        } finally {
          if (assignmentReadCancellation === cancellation) {
            assignmentReadInFlight = null;
            assignmentReadCancellation = null;
            assignmentRefreshPending = false;
          }
        }
      })();
    }
    // Existing waiters follow a superseding read, never its stale predecessor.
    while (assignmentReadInFlight) await assignmentReadInFlight;
  };

  const runTick = async (reason: string, forceCapacityRefill = false, assignmentRefreshPrepared = false) => {
    if (stopped) return;
    if (paused) return;
    if (claimInFlight) return;

    let claimedRunStarted = false;
    let emptyClaim = false;
    let requester: Awaited<ReturnType<typeof acquireWorkflowRequesterCredentials>> = null;
    let executionOwnsRequester = false;
    const requesterWake = [...requesterWakes.values()].find(wake => wake.nextClaimAt <= Date.now());
    let releaseClaim = () => {};
    // Preparation belongs to the same single-flight operation as dispatch.
    claimInFlight = new Promise<void>(resolve => { releaseClaim = resolve; });
    try {
      publishActivity('observation');
      if (assignmentRetryAfter > Date.now()) {
        rescheduleClaim('assignment-retry-after');
        return;
      }
      if (!requesterWake && (assignmentReadFailed
        || (!assignmentRefreshPrepared && assignments.getAll().length === 0 && pendingQueuedWake))) {
        // Reconnect/resync refreshes once; an early queued hint can also precede
        // its assignment snapshot. The server remains the durable work authority.
        await refreshAssignments(reason);
        if (stopped || paused || assignmentReadFailed) return;
      }

      if (!requesterWake && !forceCapacityRefill && !pendingQueuedWake && !claimReadFailed) {
        const nextRunAt = getNextClaimAtMs();
        if (nextRunAt === null || nextRunAt > Date.now()) {
          rescheduleClaim('next-run-not-due');
          return;
        }
      }

      if (Date.now() < claimRetryAfter) {
        rescheduleClaim('retry-after');
        return;
      }
      pendingQueuedWake = false;
      if (stopped || paused || params.admissionDrain?.isQuiescing()) {
        pendingQueuedWake = true;
        return;
      }
      if (requesterWake && (!params.requesterWorkAttributionV1 || !params.requesterHomeServerIdentityId)) {
        requesterWakes.delete(requesterWake.scopeId);
        if (requesterWake.runId) await claimClient.reportRequesterCustodyUnavailable({ machineId: params.machineId, runId: requesterWake.runId });
        return;
      }
      if (requesterWake && params.requesterWorkAttributionV1) {
        const host = params.requesterWorkAttributionV1;
        requester = await acquireWorkflowRequesterCredentials({ scopeId: requesterWake.scopeId,
          happyHomeDir: configuration.happyHomeDir, serverId: host.serverId, machineId: params.machineId,
          installationId: host.installationId, serverHttpBaseUrl: resolveServerHttpBaseUrl(), signal: workerCancellation.signal,
          ...(params.requesterHomeServerIdentityId ? { homeServerIdentityId: params.requesterHomeServerIdentityId } : {}) });
        if (!requester) {
          requesterWakes.delete(requesterWake.scopeId);
          if (requesterWake.runId) await claimClient.reportRequesterCustodyUnavailable({ machineId: params.machineId, runId: requesterWake.runId });
          return;
        }
      }
      const selectedCredentials = requester?.credentials ?? params.credentials;
      const selectedClaimClient = requester ? createAutomationClaimClient({ token: selectedCredentials.token }) : claimClient;
      const claimResult = await selectedClaimClient.claimRun({
        machineId: params.machineId,
        leaseDurationMs: scheduler.leaseDurationMs,
        scope: requester ? 'workflow' : 'execution',
      });

      // A completed claim is authoritative progress for this loop, regardless
      // of whether the server had a Run ready for this machine.
      claimReadFailed = false;
      claimRetryAfter = 0;

      const claimed = toClaimableRunPayload(claimResult);
      if (!claimed) {
        emptyClaim = !requesterWake;
        if (requesterWake) {
          requesterWakes.delete(requesterWake.scopeId);
          return;
        }
        // The request consumed its due wake. Refresh the server's next fact
        // once; only a future deadline or a new push may reopen an empty claim.
        const nextRunAt = getNextClaimAtMs();
        if (nextRunAt !== null && nextRunAt <= Date.now()) await refreshAssignments('no-work-due-refresh');
        return;
      }

      logger.infoFile('[WORKFLOW] Run phase', { event: 'workflow_run_phase', runId: claimed.run.id,
        phase: 'claim', timestamp: new Date().toISOString() });

      // The Account-scoped claim may return another admitted occurrence. Its
      // own private scope must be available before this executor reads content.
      const claimedScopeId = claimed.run.triggerId ?? claimed.run.id;
      if (requester && requesterWake && params.requesterWorkAttributionV1 && claimedScopeId !== requesterWake.scopeId) {
        const host = params.requesterWorkAttributionV1;
        const claimedRequester = await acquireWorkflowRequesterCredentials({ scopeId: claimedScopeId,
          accountId: requester.attribution.accountId, happyHomeDir: configuration.happyHomeDir,
          serverId: host.serverId, machineId: params.machineId, installationId: host.installationId,
          serverHttpBaseUrl: resolveServerHttpBaseUrl(), signal: workerCancellation.signal,
          ...(params.requesterHomeServerIdentityId ? { homeServerIdentityId: params.requesterHomeServerIdentityId } : {}) });
        if (!claimedRequester) {
          await claimClient.reportRequesterCustodyUnavailable({ machineId: params.machineId, runId: claimed.run.id });
          return;
        }
        const previousRequester = requester;
        requester = claimedRequester;
        await previousRequester.release();
      }
      const executionCredentials = requester?.credentials ?? selectedCredentials;
      const executionClaimClient = requester ? createAutomationClaimClient({ token: executionCredentials.token }) : selectedClaimClient;

      // The acquired executor now owns this lease. Its old wake fact is consumed.
      directRunClaimDeadlines.delete(claimed.run.id);
      const executionController = new AbortController();
      activeExecutions.set(claimed.run.id, {
        runId: claimed.run.id,
        automationId: claimed.run.automationId,
        scopeSessionId: claimed.automation?.scopeSessionId,
        consumesStartCapacity: false,
        attempt: claimed.run.attempt,
        controller: executionController,
      });
      publishActivity();
      claimedRunStarted = true;
      executionOwnsRequester = true;
      const admittedRequester = requester;
      const releaseClaimedScope = admittedRequester?.release;
      const selectedActionExecutor = requester ? createCliActionExecutorFromCredentials({ credentials: executionCredentials,
        readCredentials: async () => executionCredentials, machineId: params.machineId,
        workflowRequesterCustody: createWorkflowRequesterCustody({ credentials: executionCredentials,
          attribution: requester.attribution, happyHomeDir: configuration.happyHomeDir,
          serverHttpBaseUrl: resolveServerHttpBaseUrl(), homeServerIdentityId: params.requesterHomeServerIdentityId }),
        isAutomationRunCurrent: caller => activeExecutions.get(caller.runId)?.automationId === caller.automationId,
        ...(params.machineAdmissionTransport ? { machineAdmissionTransport: params.machineAdmissionTransport } : {}) }) : actionExecutor;

      void (async () => {
        try {
          await executeClaimedRun({
            machineId: params.machineId,
            claimClient: executionClaimClient,
            actionExecutor: selectedActionExecutor,
            acquireMachineStartCapacity: (signal) => acquireMachineStartCapacity(claimed.run.id, executionController, signal),
            registerReviewHoldRefresh: (refresh) => {
              const active = activeExecutions.get(claimed.run.id);
              if (active?.controller !== executionController) return;
              active.refreshReviewHolds = () => { void refresh().catch((error) =>
                logAutomationWarn('Failed to refresh workflow review holds', error, { runId: claimed.run.id })); };
            },
            heartbeatMs: scheduler.heartbeatMs,
            leaseDurationMs: scheduler.leaseDurationMs,
            ...(params.coordinateWorkflowRun
              ? { coordinateWorkflowRun: (claim: Parameters<NonNullable<typeof params.coordinateWorkflowRun>>[0]) => params.coordinateWorkflowRun!({ ...claim,
                storageSignal: workerCancellation.signal,
                registerLiveWorkProducer: producer => {
                  const active = activeExecutions.get(claimed.run.id);
                  if (active?.controller !== executionController) return () => {};
                  active.coordinatorWork = producer;
                  active.unsubscribeCoordinatorWork = producer.subscribe(publishActivity);
                  publishActivity();
                  return () => {
                    active.unsubscribeCoordinatorWork?.();
                    active.unsubscribeCoordinatorWork = undefined;
                    active.coordinatorWork = undefined;
                    publishActivity();
                  };
                },
              }, admittedRequester ? { credentials: admittedRequester.credentials, attribution: admittedRequester.attribution } : undefined) }
              : {}),
            resolveAutomationAccountEncryption: async (signal) => await resolveAutomationWorkerAccountEncryption({
              token: executionCredentials.token,
              credentials: executionCredentials,
              signal,
            }),
            signal: executionController.signal,
            claimed,
          });

          // A released/parked Run owns no material work during the trailing
          // assignment refresh. The map remains the claim/capacity authority.
          const active = activeExecutions.get(claimed.run.id);
          if (active?.controller === executionController) {
            active.materialWorkReleased = true;
            active.consumesStartCapacity = false;
            wakeCapacityWaiters();
            publishActivity();
          }

          // Pull a fresh assignments snapshot so we have an updated nextRunAt after the run transitions/enqueue.
          await refreshAssignments('run-settled').catch((error) => {
            logAutomationWarn('Failed to refresh automation assignments after run', error, {
              machineId: params.machineId,
              runId: claimed.run.id,
              automationId: claimed.run.automationId,
            });
          });

        } catch (error) {
          const errorClass = classifyAutomationWorkerError(error);
          // A Run's terminal/retry facts are settled by its lifecycle owner.
          // Keep this diagnostic local to the Run; changing the shared claim
          // retry state here would let concurrently settling executions erase
          // or extend each other's claim backoff.
          logAutomationWarn('Automation worker execution failed', error, {
            machineId: params.machineId,
            errorClass,
            runId: claimed.run.id,
            automationId: claimed.run.automationId,
          });
        } finally {
          const active = activeExecutions.get(claimed.run.id);
          if (active?.controller === executionController) {
            active.unsubscribeCoordinatorWork?.();
            activeExecutions.delete(claimed.run.id);
            publishActivity();
            wakeCapacityWaiters();
            // A Cancel hint delivered to this claim interrupts its observation;
            // startup itself may still be running. Transfer retained custody to
            // recovery so its existing operation-completion wait stays armed.
            // This also covers cancellation learned by the coordinator's read.
            if (!stopped && (claimed.run.automationId === null || claimed.run.recipeKind === 'workflow-v2'
              || claimed.run.executionInputEnvelope !== null)) {
              if (admittedRequester) {
                // Preserve the admitted credential while recovery joins any
                // still-running Session start, including a disabled trigger.
                try { await params.recoverWorkflowRuns?.(claimed.run.id, admittedRequester, workerCancellation.signal); }
                finally { await releaseClaimedScope?.(); }
              } else recoverWorkflowCustody(claimed.run.id);
            }
          }
          await releaseClaimedScope?.();
          if (!stopped && !paused) {
            // This is the same bounded map's capacity continuation. The
            // server still chooses the next durable Run. A null claim backs
            // off only while an assignment remains due.
            scheduleCapacityRefill('run-settled-capacity-available');
          }
        }
      })();
    } catch (error) {
      const errorClass = classifyAutomationWorkerError(error);
      claimReadFailed = true;
      const retryAfterMs = nextAutomationRetryDelayMs({ error });
      claimRetryAfter = retryAfterMs === null ? 0 : Date.now() + retryAfterMs;
      logAutomationWarn('Automation worker tick failed', error, {
        machineId: params.machineId,
        errorClass,
        retryAfterMs,
        assignmentCount: assignments.getAll().length,
      });
    } finally {
      if (!executionOwnsRequester) await requester?.release();
      claimInFlight = null;
      releaseClaim();

      if (claimedRunStarted) {
        // Refill through the same map and claim timer after releasing request
        // admission. At ordinary capacity the server filters this next claim
        // to private Workflow recipes, whose accepted graph determines whether
        // admission needs a start slot; no second scheduler or cap is introduced.
        scheduleCapacityRefill('claimed-run-capacity-available');
        return;
      }
      if (pendingQueuedWake) {
        if (Math.max(claimRetryAfter, assignmentRetryAfter) > Date.now()) {
          rescheduleClaim('queued-wake-blocked');
        } else if (claimReadFailed || assignmentReadFailed) {
          rescheduleClaim('queued-wake-recovery');
        } else {
          scheduleClaimSoon('queued-wake-pending');
        }
        return;
      }
      rescheduleClaim('tick-complete', false, emptyClaim);
    }
  };

  const unsubscribeAdmission = params.admissionDrain?.subscribe(() => {
    wakeCapacityWaiters();
    if (params.admissionDrain?.isQuiescing()) { clearClaimTimer(); return; }
    if (pendingQueuedWake) scheduleClaimSoon('admission-reopened');
    else rescheduleClaim('admission-reopened', true);
  });

  const catchUp = async (): Promise<void> => {
    if (stopped) return;
    const host = params.requesterWorkAttributionV1;
    if (host) {
      const scopes = await listWorkflowRequesterCredentialScopes({ happyHomeDir: configuration.happyHomeDir,
        serverId: host.serverId, machineId: params.machineId, installationId: host.installationId });
      if (scopes.status === 'unavailable') throw new Error(scopes.reason);
      for (const scope of scopes.bindings) if (scope.attribution.accountId !== host.accountId) {
        await reconcileWorkflowRequesterCredentialScope({ happyHomeDir: configuration.happyHomeDir,
          serverId: host.serverId, machineId: params.machineId, installationId: host.installationId,
          scopeId: scope.sessionId, serverHttpBaseUrl: resolveServerHttpBaseUrl(), signal: workerCancellation.signal,
          ...(params.requesterHomeServerIdentityId ? { homeServerIdentityId: params.requesterHomeServerIdentityId } : {}) });
        requesterWakes.set(scope.sessionId, { scopeId: scope.sessionId, nextClaimAt: Date.now() });
      }
    }
    pendingQueuedWake = true;
    // A prior empty read is superseded by a real recovery edge. Server retry
    // deadlines and claim fencing remain authoritative.
    await refreshAssignments('work-catch-up', 'supersede');
    if (assignmentReadFailed || assignmentRetryAfter > Date.now()) return;
    await runTick('work-catch-up', false, true);
  };

  // This retained-row migration belongs to this admitted startup, never to
  // assignment refresh, socket catch-up or the worker's claim/retry loop.
  const assertBackfillAccountCurrent = async () => {
    managedTargetBackfillCancellation.signal.throwIfAborted();
    const current = await readStoredCredentials();
    managedTargetBackfillCancellation.signal.throwIfAborted();
    if (!sameStoredCredentials(params.credentials, current)) {
      managedTargetBackfillCancellation.abort();
      managedTargetBackfillCancellation.signal.throwIfAborted();
    }
  };
  void backfillAutomationManagedTargetsV1({
    signal: managedTargetBackfillCancellation.signal,
    isCurrent: () => !stopped,
    randomBytes,
    resolveEncryption: async () => {
      await assertBackfillAccountCurrent();
      const current = await resolveAutomationWorkerAccountEncryption({ token: params.token,
        credentials: params.credentials, signal: managedTargetBackfillCancellation.signal });
      await assertBackfillAccountCurrent();
      if (current.kind !== 'available') throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
      return current;
    },
    automations: {
      listDetails: async input => { await assertBackfillAccountCurrent(); return await listAutomationDefinitionDetails({ ...input, token: params.token,
        signal: managedTargetBackfillCancellation.signal }); },
      patch: async (automationId, input, beforeWrite) => {
        await beforeWrite?.();
        await assertBackfillAccountCurrent();
        return await updateAutomationDefinition({ token: params.token, automationId, input,
          signal: managedTargetBackfillCancellation.signal });
      },
    },
  }).catch(error => {
    if (!managedTargetBackfillCancellation.signal.aborted) logAutomationWarn('Automation managed target startup backfill unavailable', error,
      { machineId: params.machineId });
  });

  // A failed authoritative read arms recovery through the incumbent claim timer;
  // a successful empty snapshot stays idle until push or connection catch-up.
  observeRequesterCustody();
  void (params.requesterWorkAttributionV1 ? catchUp() : refreshAssignments('worker-start')).catch((error) => {
    logAutomationWarn('Failed to refresh automation assignments on worker start', error, {
      machineId: params.machineId,
    });
  });

  logAutomationInfo('Automation worker started', {
    machineId: params.machineId,
    leaseDurationMs: scheduler.leaseDurationMs,
    heartbeatMs: scheduler.heartbeatMs,
  });

  return {
    liveWorkProducer,
    stop: () => stopWorker('manual'),
    refreshAssignments: async () => {
      await refreshAssignments('manual-refresh');
    },
    catchUp,
    pause: () => {
      if (stopped || paused) return;
      paused = true;
      cancelAssignmentRead();
      sourceObservers.clear();
      requesterCustodyObservation?.dispose();
      requesterCustodyObservation = undefined;
      clearClaimTimer();
    },
    resume: () => {
      if (stopped || !paused) return;
      paused = false;
      observeRequesterCustody();
      wakeCapacityWaiters();
      void refreshAssignments('resumed', 'supersede');
      rescheduleClaim('resumed');
    },
    handleServerUpdate: (update: Update) => {
      if (stopped) return;
      const body = update?.body;
      if (!body || typeof body !== 'object') return;
      if (body.t === 'automation-upsert' || body.t === 'automation-delete') {
        scheduleAssignmentsRefreshSoon('socket-run-source-changed');
      }

      if (body.t === 'automation-assignment-updated' && body.machineId === params.machineId) {
        scheduleAssignmentsRefreshSoon('socket-assignment-updated');
        return;
      }

      invalidateActiveExecution(update);
      if (body.t === 'automation-run-updated' && body.targetMachineId === params.machineId
        && isTerminalAutomationRunStateV3(body.state) && params.requesterWorkAttributionV1) {
        if (body.automationId === null) requesterWakes.delete(body.runId);
        const host = params.requesterWorkAttributionV1;
        const scope = body.requesterScope;
        const scopeId = scope && typeof scope === 'object' && 'id' in scope && typeof scope.id === 'string' ? scope.id : body.runId;
        const retire = body.automationId === null ? retireWorkflowRequesterCredentials : settleWorkflowRequesterCredentialRetirement;
        void retire({ scopeId, happyHomeDir: configuration.happyHomeDir, serverHttpBaseUrl: resolveServerHttpBaseUrl(),
          serverId: host.serverId, machineId: params.machineId, installationId: host.installationId, signal: workerCancellation.signal }).catch(error =>
          logAutomationWarn('Workflow requester custody retirement failed', error, { runId: body.runId }));
      }

      if (body.t === 'automation-run-updated' && body.targetMachineId === params.machineId
        && isTerminalAutomationRunStateV3(body.state)
        && !activeExecutions.has(body.runId)) {
        recoverWorkflowCustody(body.runId, body.requesterScope?.kind === 'workflow_trigger' ? body.requesterScope.id : undefined);
        return;
      }

      if (
        body.t === 'automation-run-updated'
        && body.targetMachineId === params.machineId
        && body.workflowControl === 'cancel_requested'
        && !activeExecutions.has(body.runId)
      ) {
        const scope = body.requesterScope;
        recoverWorkflowCustody(body.runId, scope && typeof scope === 'object' && 'id' in scope && typeof scope.id === 'string' ? scope.id : undefined);
        return;
      }

      if (body.t === 'automation-run-updated' && body.state === 'queued') {
        if (body.targetMachineId === params.machineId) {
          logger.infoFile('[WORKFLOW] Run phase', { event: 'workflow_run_phase', runId: body.runId,
            phase: 'daemon_receipt', timestamp: new Date().toISOString() });
        }
        const scope = body.requesterScope;
        if (scope && typeof scope === 'object' && 'kind' in scope && scope.kind === 'workflow_trigger'
          && 'id' in scope && typeof scope.id === 'string' && body.targetMachineId === params.machineId) {
          const scopeId = scope.id;
          requesterWakes.set(scopeId, { scopeId, runId: body.runId, nextClaimAt: Date.now() });
        }
        if (assignmentReadInFlight) assignmentRefreshPending = true;
        pendingQueuedWake = true;
        scheduleClaimSoon('socket-run-queued');
      }
    },
  };
}
