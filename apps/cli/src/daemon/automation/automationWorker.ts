import type {
  SpawnSessionOptions,
  SpawnSessionResult,
} from '@/session/shared/spawnSessionContract';

import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import {
  createAutomationAccountEncryptionMaterialSnapshotV1,
  resolveValidatedAutomationAccountEncryptionV1,
} from '@/plugins/runtime/automations/automationAccountCurrentness';
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
import type {
  AutomationClaimedRunPayload,
  AutomationClaimRunResponse,
} from './automationTypes';
import type { Update } from '@/api/types';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import type {
  SessionServerStartDispatchResultV1,
  SessionServerStartIngressRequestV1,
} from '@happier-dev/protocol';
import { DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE } from '@happier-dev/protocol/automations/automationApiV3';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { invalidateActiveAutomationRun } from './automationRunInvalidation';
import type { sendSessionMessage } from '@/session/services/sendSessionMessage';
import type { createProductionWorkflowRunCoordinator } from '@/daemon/workflows/production';

type AutomationMachineAdmissionTransport = NonNullable<
  Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport']
>;

const ASSIGNMENT_RECONCILIATION_DELAY_MS = 45_000;
const ASSIGNMENT_RECONCILIATION_JITTER_MS = 15_000;
export type AutomationWorkerHandle = Readonly<{
  stop: () => void;
  refreshAssignments: () => Promise<void>;
  handleServerUpdate: (update: Update) => void;
  pause: () => void;
  resume: () => void;
}>;

/** One daemon Account-currentness/material owner shared by Automation execution and Workflow preflight. */
export async function resolveAutomationWorkerAccountEncryption(params: Readonly<{
  token: string;
  credentials?: StoredCredentials;
  signal?: AbortSignal;
}>) {
  const controller = params.signal ? null : new AbortController();
  const signal = params.signal ?? controller!.signal;
  return await resolveValidatedAutomationAccountEncryptionV1({
    signal,
    resolveAccountEncryptionCurrentness: async (currentnessSignal) =>
      await fetchAccountEncryptionCurrentness({
        token: params.token,
        ...(currentnessSignal ? { signal: currentnessSignal } : {}),
      }),
    resolveAccountEncryptionMaterial: async () => (
      params.credentials
        ? createAutomationAccountEncryptionMaterialSnapshotV1(params.credentials)
        : null
    ),
  });
}

function toClaimableRunPayload(claimResult: AutomationClaimRunResponse): ClaimableRunPayload | null {
  if (claimResult.run === null) {
    return null;
  }
  return claimResult as AutomationClaimedRunPayload;
}

export function startAutomationWorker(params: {
  token: string;
  credentials?: StoredCredentials;
  machineId: string;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  machineAdmissionTransport?: AutomationMachineAdmissionTransport;
  /** The connected daemon's Session-owned Automation start ingress. */
  dispatchSessionServerStart?: (
    request: SessionServerStartIngressRequestV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<SessionServerStartDispatchResultV1>;
  env?: NodeJS.ProcessEnv;
  coordinateWorkflowRun?: ReturnType<typeof createProductionWorkflowRunCoordinator>;
  /** Existing lifecycle-indexed custody reader, woken by an exact persisted control invalidation. */
  recoverWorkflowRuns?: () => Promise<void>;
}): AutomationWorkerHandle {
  const env = params.env ?? process.env;
  const workerDecision = getAutomationWorkerFeatureDecision(env);
  if (workerDecision.state !== 'enabled') {
    logAutomationInfo('Automation worker disabled', {
      machineId: params.machineId,
      blockedBy: workerDecision.blockedBy,
      blockerCode: workerDecision.blockerCode,
    });
    return {
      stop: () => {
        logAutomationInfo('Automation worker stop called while disabled', {
          machineId: params.machineId,
          blockedBy: workerDecision.blockedBy,
          blockerCode: workerDecision.blockerCode,
        });
      },
      refreshAssignments: async () => {},
      handleServerUpdate: () => {},
      pause: () => {},
      resume: () => {},
    };
  }

  const scheduler = resolveAutomationPollingConfig(env);
  const claimClient = createAutomationClaimClient({ token: params.token });
  const assignments = createAutomationAssignmentCache();

  let stopped = false;
  let paused = false;
  // These values govern only the one claim request loop. A per-Run executor
  // failure is already reflected in that Run's server-owned lifecycle and
  // must not race another claim's retry state.
  let claimConsecutiveFailures = 0;
  let claimRetryAfter = 0;
  let noWorkCooldownUntil = 0;
  let noWorkCooldownScope: 'workflow' | undefined;
  let pendingQueuedWake = false;
  let nextAssignmentReconciliationAt = 0;
  let latestAssignmentRefreshRequest = 0;

  let claimTimer: NodeJS.Timeout | null = null;
  let claimTimerAt = 0;
  let claimInFlight = false;
  let refreshSoonTimer: NodeJS.Timeout | null = null;
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
  }>();
  const capacityWaiters = new Set<() => void>();
  const wakeCapacityWaiters = () => { for (const wake of capacityWaiters) wake(); };
  const actionExecutor = params.credentials
    ? createCliActionExecutorFromCredentials({
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
    })
    : null;
  let maxActiveRunsPerMachine = DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE;
  const sourceObservers = createAutomationRunLifecycleObservers({
    wait: async (source, signal) => {
      if (!actionExecutor) throw new Error('not_authenticated');
      const result = await actionExecutor.execute('execution.run.wait', {
        runId: source.runId, sessionId: source.sessionId ?? null,
      }, { surface: 'cli', executionRunTargetMachineId: source.machineId, signal });
      if (!result.ok) throw Object.assign(new Error(result.errorCode), { code: result.errorCode });
      return result.result;
    },
    report: (occurrence, signal) => claimClient.reportRunLifecycle(params.machineId, occurrence, signal),
    onError: (error, source) => logAutomationWarn('Run notification source observation failed; retained source remains armed', error,
      { machineId: source.machineId, runId: source.runId }),
  });

  const nullClaimBackoffMs = Math.min(
    60_000,
    Math.max(5_000, Math.floor(scheduler.leaseDurationMs / 2)),
  );

  function clearClaimTimer() {
    if (claimTimer) {
      clearTimeout(claimTimer);
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
    if (!force && claimTimer && claimTimerAt > 0 && claimTimerAt <= at) {
      return;
    }
    clearClaimTimer();
    claimTimerAt = at;
    claimTimer = setTimeout(() => {
      claimTimer = null;
      claimTimerAt = 0;
      void runTick(reason, forceCapacityRefill);
    }, Math.max(0, at - Date.now()));
  }

  function scheduleClaimSoon(reason: string) {
    scheduleClaimAt(Date.now(), reason);
  }

  function scheduleCapacityRefill(reason: string) {
    // A Workflow-only null claim says nothing about ordinary queued work. When
    // an ordinary slot opens, refill it through the incumbent claim loop.
    if (hasExecutionCapacity() && noWorkCooldownScope === 'workflow') {
      noWorkCooldownUntil = 0;
      noWorkCooldownScope = undefined;
    }
    // Yield through the existing claim timer. A synchronous mock or a very
    // fast terminal executor must not create an unbounded microtask chain
    // that starves cancellation, assignment refreshes, or the next timer.
    scheduleClaimAt(Date.now(), reason, true, true);
  }

  function scheduleAssignmentsRefreshSoon(reason: string) {
    if (stopped) return;
    if (paused) return;
    if (refreshSoonTimer) return;
    refreshSoonTimer = setTimeout(() => {
      refreshSoonTimer = null;
      void refreshAssignments().catch((error) => {
        logAutomationWarn('Failed to refresh automation assignments (scheduled)', error, {
          machineId: params.machineId,
          reason,
        });
      });
    }, 250);
  }

  function getNextAssignedRunAtMs(): number | null {
    const rows = assignments.getAll();
    let next: number | null = null;
    for (const row of rows) {
      const candidate = row.nextClaimAt;
      if (typeof candidate !== 'number' || !Number.isFinite(candidate)) continue;
      if (next === null || candidate < next) {
        next = candidate;
      }
    }
    return next;
  }

  function scheduleNextAssignmentReconciliation(): void {
    const jitterMs = Math.floor(Math.random() * (ASSIGNMENT_RECONCILIATION_JITTER_MS + 1));
    nextAssignmentReconciliationAt = Date.now() + ASSIGNMENT_RECONCILIATION_DELAY_MS + jitterMs;
  }

  function hasExecutionCapacity(): boolean {
    let ordinaryActiveRuns = 0;
    for (const active of activeExecutions.values()) {
      if (active.consumesStartCapacity) ordinaryActiveRuns += 1;
    }
    return ordinaryActiveRuns < maxActiveRunsPerMachine;
  }

  async function acquireMachineStartCapacity(runId: string, controller: AbortController, signal?: AbortSignal): Promise<void> {
    while (true) {
      signal?.throwIfAborted();
      const active = activeExecutions.get(runId);
      if (!active || active.controller !== controller) throw new Error('automation_claim_not_current');
      if (active.consumesStartCapacity) return;
      if (!paused && hasExecutionCapacity()) {
        active.consumesStartCapacity = true;
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

  function rescheduleClaim(reason: string, force = false) {
    if (stopped) return;
    const rows = assignments.getAll();
    const now = Date.now();
    const blockedUntil = Math.max(claimRetryAfter, noWorkCooldownUntil);
    const claimBlocked = blockedUntil > now;
    const nextRunAt = rows.length === 0 ? null : getNextAssignedRunAtMs();
    const candidates = [
      nextAssignmentReconciliationAt > 0 ? nextAssignmentReconciliationAt : null,
      claimBlocked ? blockedUntil : null,
      // A previously due assignment is not a reason to bypass a claim retry/no-work
      // cooldown. The reconciliation deadline above remains independently eligible.
      claimBlocked ? null : nextRunAt,
    ].filter((candidate): candidate is number => candidate !== null);
    if (candidates.length === 0) {
      clearClaimTimer();
      return;
    }
    scheduleClaimAt(Math.min(...candidates), `${reason}:scheduled`, force);
  }

  const stopWorker = (reason: 'manual') => {
    if (stopped) return;
    stopped = true;
    sourceObservers.clear();
    for (const active of activeExecutions.values()) {
      active.controller.abort();
    }
    clearClaimTimer();
    if (refreshSoonTimer) {
      clearTimeout(refreshSoonTimer);
      refreshSoonTimer = null;
    }
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

  const refreshAssignments = async () => {
    if (stopped) return;
    if (paused) return;
    const request = ++latestAssignmentRefreshRequest;
    try {
      const response = await claimClient.fetchAssignments(params.machineId);
      // Refreshes can overlap across startup, reconnect, resume, socket hints, and
      // reconciliation. Only the newest request may replace the canonical cache or
      // its wake timer; otherwise a late older snapshot can erase newer work.
      if (request !== latestAssignmentRefreshRequest) return;
      const previousMaxActiveRunsPerMachine = maxActiveRunsPerMachine;
      // The current server is the execution-capacity settings authority.
      maxActiveRunsPerMachine = response.settings.maxActiveRunsPerMachine;
      wakeCapacityWaiters();
      assignments.replace(response.assignments);
      sourceObservers.replace(response.runLifecycleSources ?? []);
      scheduleNextAssignmentReconciliation();
      logAutomationInfo('Assignments refreshed', {
        machineId: params.machineId,
        count: response.assignments.length,
      });
      if (pendingQueuedWake) {
        scheduleClaimSoon('queued-wake-after-assignments-refresh');
        return;
      }
      if (
        maxActiveRunsPerMachine > previousMaxActiveRunsPerMachine
        && response.assignments.length > 0
      ) {
        scheduleCapacityRefill('assignment-settings-capacity-increased');
        return;
      }
      rescheduleClaim('assignments-refreshed', true);
    } catch (error) {
      if (request !== latestAssignmentRefreshRequest) return;
      logAutomationWarn('Failed to refresh automation assignments', error, {
        machineId: params.machineId,
      });
    }
  };

  const runTick = async (_reason: string, forceCapacityRefill = false) => {
    if (stopped) return;
    if (paused) return;
    if (claimInFlight) return;

    let reconciledAssignments = false;
    if (nextAssignmentReconciliationAt > 0 && Date.now() >= nextAssignmentReconciliationAt) {
      // Keep a bounded retry scheduled if the authoritative read fails. A successful
      // read immediately replaces this deadline with a fresh reconciliation window.
      scheduleNextAssignmentReconciliation();
      await refreshAssignments();
      if (stopped || paused) return;
      reconciledAssignments = true;
    }

    if (!reconciledAssignments && assignments.getAll().length === 0 && pendingQueuedWake) {
      // A queued-run hint can arrive before the assignment cache catches up.
      // Refresh that cache, then let the server's claim owner decide whether a
      // direct or Automation-origin Run is ready for this machine.
      await refreshAssignments();
      if (stopped || paused) return;
    }

    if (!reconciledAssignments && !forceCapacityRefill && !pendingQueuedWake) {
      const nextRunAt = getNextAssignedRunAtMs();
      if (nextRunAt !== null && nextRunAt > Date.now()) {
        rescheduleClaim('next-run-not-due');
        return;
      }
    }

    if (Date.now() < claimRetryAfter) {
      rescheduleClaim('retry-after');
      return;
    }
    if (Date.now() < noWorkCooldownUntil) {
      rescheduleClaim('no-work-cooldown');
      return;
    }

    // Assignment preparation may have yielded to another queued wake. Take
    // the incumbent claim slot only after rechecking that asynchronous gap.
    if (claimInFlight) return;
    let claimedRunStarted = false;
    try {
      claimInFlight = true;
      pendingQueuedWake = false;
      const scope = hasExecutionCapacity() ? undefined : 'workflow';
      const claimResult = await claimClient.claimRun({
        machineId: params.machineId,
        leaseDurationMs: scheduler.leaseDurationMs,
        ...(scope ? { scope } : {}),
      });

      // A completed claim is authoritative progress for this loop, regardless
      // of whether the server had a Run ready for this machine.
      claimConsecutiveFailures = 0;
      claimRetryAfter = 0;

      const claimed = toClaimableRunPayload(claimResult);
      if (!claimed) {
        const nextRunAt = getNextAssignedRunAtMs();
        if (nextRunAt !== null && (forceCapacityRefill || nextRunAt <= Date.now())) {
          // Another machine likely claimed (or our clock is ahead). Back off to avoid a thundering herd.
          noWorkCooldownUntil = Date.now() + nullClaimBackoffMs;
          noWorkCooldownScope = scope;
          scheduleAssignmentsRefreshSoon('no-work-due-refresh');
        } else {
          noWorkCooldownUntil = 0;
        }
        return;
      }

      const executionController = new AbortController();
      activeExecutions.set(claimed.run.id, {
        runId: claimed.run.id,
        automationId: claimed.run.automationId,
        scopeSessionId: claimed.automation?.scopeSessionId,
        consumesStartCapacity: claimed.run.automationId !== null && claimed.run.recipeKind !== 'workflow-v2',
        attempt: claimed.run.attempt,
        controller: executionController,
      });
      claimedRunStarted = true;

      void (async () => {
        try {
          await executeClaimedRun({
            token: params.token,
            ...(params.credentials ? { credentials: params.credentials } : {}),
            machineId: params.machineId,
            claimClient,
            acquireMachineStartCapacity: (signal) => acquireMachineStartCapacity(claimed.run.id, executionController, signal),
            registerReviewHoldRefresh: (refresh) => {
              const active = activeExecutions.get(claimed.run.id);
              if (active?.controller !== executionController) return;
              active.refreshReviewHolds = () => { void refresh().catch((error) =>
                logAutomationWarn('Failed to refresh workflow review holds', error, { runId: claimed.run.id })); };
            },
            spawnSession: params.spawnSession,
            heartbeatMs: scheduler.heartbeatMs,
            leaseDurationMs: scheduler.leaseDurationMs,
            ...(params.machineAdmissionTransport
              ? { machineAdmissionTransport: params.machineAdmissionTransport }
              : {}),
            ...(params.dispatchSessionServerStart
              ? { dispatchSessionServerStart: params.dispatchSessionServerStart }
              : {}),
            ...(params.coordinateWorkflowRun
              ? { coordinateWorkflowRun: params.coordinateWorkflowRun }
              : {}),
            resolveAutomationAccountEncryption: async (signal) => await resolveAutomationWorkerAccountEncryption({
              token: params.token,
              ...(params.credentials ? { credentials: params.credentials } : {}),
              signal,
            }),
            ...(actionExecutor ? { executeAction: actionExecutor.execute } : {}),
            signal: executionController.signal,
            claimed,
          });

          // Pull a fresh assignments snapshot so we have an updated nextRunAt after the run transitions/enqueue.
          await refreshAssignments().catch((error) => {
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
            activeExecutions.delete(claimed.run.id);
            wakeCapacityWaiters();
          }
          if (!stopped && !paused) {
            // This is the same bounded map's capacity continuation. The
            // server still chooses the next durable Run, and a null claim
            // installs the normal no-work cooldown before another refill.
            scheduleCapacityRefill('run-settled-capacity-available');
          }
        }
      })();
    } catch (error) {
      const errorClass = classifyAutomationWorkerError(error);
      if (errorClass === 'transient') {
        claimConsecutiveFailures += 1;
      } else {
        claimConsecutiveFailures = 0;
      }
      const backoffMs = nextAutomationRetryDelayMs({
        failureCount: claimConsecutiveFailures,
        error,
      });
      claimRetryAfter = Date.now() + backoffMs;
      logAutomationWarn('Automation worker tick failed', error, {
        machineId: params.machineId,
        errorClass,
        consecutiveFailures: claimConsecutiveFailures,
        backoffMs,
        assignmentCount: assignments.getAll().length,
      });
    } finally {
      claimInFlight = false;

      if (claimedRunStarted) {
        // Refill through the same map and claim timer after releasing request
        // admission. At ordinary capacity the server filters this next claim
        // to private Workflow recipes, whose accepted graph determines whether
        // admission needs a start slot; no second scheduler or cap is introduced.
        scheduleCapacityRefill('claimed-run-capacity-available');
        return;
      }
      if (pendingQueuedWake) {
        scheduleClaimSoon('queued-wake-pending');
        return;
      }
      rescheduleClaim('tick-complete');
    }
  };

  // Seed the first bounded reconciliation before the initial read so a transient
  // startup failure cannot leave an empty cache without another authoritative read.
  scheduleNextAssignmentReconciliation();
  rescheduleClaim('worker-start');
  void refreshAssignments().catch((error) => {
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
    stop: () => stopWorker('manual'),
    refreshAssignments: async () => {
      await refreshAssignments();
    },
    pause: () => {
      if (stopped || paused) return;
      paused = true;
      sourceObservers.clear();
      clearClaimTimer();
      if (refreshSoonTimer) {
        clearTimeout(refreshSoonTimer);
        refreshSoonTimer = null;
      }
    },
    resume: () => {
      if (stopped || !paused) return;
      paused = false;
      wakeCapacityWaiters();
      void refreshAssignments();
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

      if (
        body.t === 'automation-run-updated'
        && body.targetMachineId === params.machineId
        && body.workflowControl === 'cancel_requested'
        && !activeExecutions.has(body.runId)
      ) {
        void params.recoverWorkflowRuns?.().catch((error) => {
          logAutomationWarn('Workflow cancellation custody recovery failed; pending custody retained', error, {
            machineId: params.machineId,
            runId: body.runId,
          });
        });
        return;
      }

      if (body.t === 'automation-run-updated' && body.state === 'queued') {
        pendingQueuedWake = true;
        scheduleClaimSoon('socket-run-queued');
      }
    },
  };
}
