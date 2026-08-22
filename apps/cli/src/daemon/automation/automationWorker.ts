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
import { classifyAutomationWorkerError, nextAutomationRetryDelayMs } from './automationBackoffPolicy';
import {
  createAutomationClaimClient,
} from './automationClaimClient';
import { getAutomationWorkerFeatureDecision } from './automationFeatureGate';
import { executeClaimedRun, type ClaimableRunPayload } from './automationRunExecutor';
import { resolveAutomationPollingConfig } from './automationScheduler';
import type { AutomationTemplateEncryption } from './automationTemplateExecution';
import { logAutomationInfo, logAutomationWarn } from './automationTelemetry';
import type {
  AutomationClaimedRunPayload,
  AutomationClaimRunResponse,
} from './automationTypes';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import type { Update } from '@/api/types';
import type { StoredCredentials } from '@/persistence';
import type {
  SessionInputAdmissionResultV1,
  SessionPendingEnqueueByMachineRequestV1,
  SessionServerStartDispatchResultV1,
  SessionServerStartIngressRequestV1,
} from '@happier-dev/protocol';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { invalidateActiveAutomationRun } from './automationRunInvalidation';

const ASSIGNMENT_RECONCILIATION_DELAY_MS = 45_000;
const ASSIGNMENT_RECONCILIATION_JITTER_MS = 15_000;

export type AutomationWorkerHandle = Readonly<{
  stop: () => void;
  refreshAssignments: () => Promise<void>;
  handleServerUpdate: (update: Update) => void;
  pause: () => void;
  resume: () => void;
}>;

function toClaimableRunPayload(claimResult: AutomationClaimRunResponse): ClaimableRunPayload | null {
  if (claimResult.run === null || claimResult.automation === null) {
    return null;
  }
  return claimResult as AutomationClaimedRunPayload;
}

export function startAutomationWorker(params: {
  token: string;
  credentials?: StoredCredentials;
  machineId: string;
  encryption?: AutomationTemplateEncryption;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  machineAdmissionTransport?: (
    request: SessionPendingEnqueueByMachineRequestV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<SessionInputAdmissionResultV1>;
  /** The connected daemon's Session-owned Automation start ingress. */
  dispatchSessionServerStart?: (
    request: SessionServerStartIngressRequestV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<SessionServerStartDispatchResultV1>;
  budgetRegistry?: ExecutionBudgetRegistry;
  env?: NodeJS.ProcessEnv;
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
  const actionExecutor = params.credentials
    ? createCliActionExecutorFromCredentials({
        credentials: params.credentials,
        ...(params.machineAdmissionTransport
          ? { machineAdmissionTransport: params.machineAdmissionTransport }
          : {}),
      })
    : null;
  const assignments = createAutomationAssignmentCache();
  const budgetTokenId = `automation_worker:${params.machineId}`;

  let stopped = false;
  let paused = false;
  let consecutiveFailures = 0;
  let retryAfter = 0;
  let noWorkCooldownUntil = 0;
  let pendingQueuedWake = false;
  let nextAssignmentReconciliationAt = 0;
  let latestAssignmentRefreshRequest = 0;

  let claimTimer: NodeJS.Timeout | null = null;
  let claimTimerAt = 0;
  let claimInFlight = false;
  let refreshSoonTimer: NodeJS.Timeout | null = null;
  // This worker executes at most one claimed Run at a time. The controller is
  // invocation-local currentness, not a second Automation cancellation owner.
  let activeExecution: {
    runId: string;
    attempt: number;
    controller: AbortController;
  } | null = null;

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

  function scheduleClaimAt(whenMs: number, reason: string, force = false) {
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
      void runTick(reason);
    }, Math.max(0, at - Date.now()));
  }

  function scheduleClaimSoon(reason: string) {
    scheduleClaimAt(Date.now(), reason);
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

  function rescheduleClaim(reason: string, force = false) {
    if (stopped) return;
    const rows = assignments.getAll();
    const now = Date.now();
    const blockedUntil = Math.max(retryAfter, noWorkCooldownUntil);
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

  const stopWorker = (reason: 'manual' | 'unsupported-endpoint') => {
    if (stopped) return;
    stopped = true;
    activeExecution?.controller.abort();
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
    invalidateActiveAutomationRun({
      update,
      active: activeExecution,
      machineId: params.machineId,
    });
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
      assignments.replace(response.assignments);
      scheduleNextAssignmentReconciliation();
      logAutomationInfo('Assignments refreshed', {
        machineId: params.machineId,
        count: response.assignments.length,
      });
      if (pendingQueuedWake) {
        if (response.assignments.length > 0) {
          scheduleClaimSoon('queued-wake-after-assignments-refresh');
          return;
        }
        pendingQueuedWake = false;
      }
      rescheduleClaim('assignments-refreshed', true);
    } catch (error) {
      if (request !== latestAssignmentRefreshRequest) return;
      if (claimClient.isMissingEndpointError(error, [
        '/v3/automations/worker/assignments',
        '/v2/automations/daemon/assignments',
      ])) {
        // Backwards compatibility: older servers/daemons won't have the automation routes. Treat this as
        // a feature negotiation result, not a retryable operational failure.
        stopWorker('unsupported-endpoint');
        return;
      }
      logAutomationWarn('Failed to refresh automation assignments', error, {
        machineId: params.machineId,
      });
    }
  };

  const runTick = async (_reason: string) => {
    if (stopped) return;
    if (paused) return;
    if (claimInFlight) return;

    if (nextAssignmentReconciliationAt > 0 && Date.now() >= nextAssignmentReconciliationAt) {
      // Keep a bounded retry scheduled if the authoritative read fails. A successful
      // read immediately replaces this deadline with a fresh reconciliation window.
      scheduleNextAssignmentReconciliation();
      await refreshAssignments();
      if (stopped || paused) return;
    }

    if (assignments.getAll().length === 0 && pendingQueuedWake) {
      // A queued-run hint can arrive before the assignment cache catches up. Read the
      // canonical assignment owner before deciding that this daemon has no work.
      await refreshAssignments();
      if (stopped || paused) return;
    }

    const assignmentCount = assignments.getAll().length;
    if (assignmentCount === 0) {
      rescheduleClaim('empty-assignments');
      return;
    }

    if (!pendingQueuedWake) {
      const nextRunAt = getNextAssignedRunAtMs();
      if (nextRunAt !== null && nextRunAt > Date.now()) {
        rescheduleClaim('next-run-not-due');
        return;
      }
    }

    if (Date.now() < retryAfter) {
      rescheduleClaim('retry-after');
      return;
    }
    if (Date.now() < noWorkCooldownUntil) {
      rescheduleClaim('no-work-cooldown');
      return;
    }

    const budgetRegistry = params.budgetRegistry;
    // Automation runs should respect the shared daemon one-shot budget so we don't
    // starve other daemon work (and vice-versa).
    if (budgetRegistry && !budgetRegistry.tryAcquireOneShotTask(budgetTokenId, 'automation')) {
      // Try again on the next schedule tick.
      rescheduleClaim('budget-blocked');
      return;
    }
    try {
      claimInFlight = true;
      pendingQueuedWake = false;
      const claimResult = await claimClient.claimRun({
        machineId: params.machineId,
        leaseDurationMs: scheduler.leaseDurationMs,
      });

      const claimed = toClaimableRunPayload(claimResult);
      if (!claimed) {
        consecutiveFailures = 0;
        retryAfter = 0;
        const nextRunAt = getNextAssignedRunAtMs();
        if (nextRunAt !== null && nextRunAt <= Date.now()) {
          // Another machine likely claimed (or our clock is ahead). Back off to avoid a thundering herd.
          noWorkCooldownUntil = Date.now() + nullClaimBackoffMs;
          scheduleAssignmentsRefreshSoon('no-work-due-refresh');
        } else {
          noWorkCooldownUntil = 0;
        }
        return;
      }

      const executionController = new AbortController();
      activeExecution = {
        runId: claimed.run.id,
        attempt: claimed.run.attempt,
        controller: executionController,
      };
      try {
        await executeClaimedRun({
          token: params.token,
          ...(params.credentials ? { credentials: params.credentials } : {}),
          machineId: params.machineId,
          claimClient,
          spawnSession: params.spawnSession,
          heartbeatMs: scheduler.heartbeatMs,
          leaseDurationMs: scheduler.leaseDurationMs,
          encryption: params.encryption,
          ...(params.machineAdmissionTransport
            ? { machineAdmissionTransport: params.machineAdmissionTransport }
            : {}),
          ...(params.dispatchSessionServerStart
            ? { dispatchSessionServerStart: params.dispatchSessionServerStart }
            : {}),
          resolveAutomationAccountEncryption: async (signal) => await resolveValidatedAutomationAccountEncryptionV1({
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
          }),
          ...(actionExecutor ? { executeAction: actionExecutor.execute } : {}),
          signal: executionController.signal,
          claimed,
        });
      } finally {
        if (activeExecution?.controller === executionController) {
          activeExecution = null;
        }
      }

      // Pull a fresh assignments snapshot so we have an updated nextRunAt after the run transitions/enqueue.
      await refreshAssignments().catch((error) => {
        logAutomationWarn('Failed to refresh automation assignments after run', error, {
          machineId: params.machineId,
          runId: claimed.run.id,
          automationId: claimed.automation.id,
        });
      });

      consecutiveFailures = 0;
      retryAfter = 0;
      noWorkCooldownUntil = 0;
    } catch (error) {
      if (claimClient.isMissingEndpointError(error, [
        '/v3/automations/runs/claim',
        '/v2/automations/runs/claim',
      ])) {
        stopWorker('unsupported-endpoint');
        return;
      }
      const errorClass = classifyAutomationWorkerError(error);
      if (errorClass === 'transient') {
        consecutiveFailures += 1;
      } else {
        consecutiveFailures = 0;
      }
      const backoffMs = nextAutomationRetryDelayMs({
        failureCount: consecutiveFailures,
        error,
      });
      retryAfter = Date.now() + backoffMs;
      logAutomationWarn('Automation worker tick failed', error, {
        machineId: params.machineId,
        errorClass,
        consecutiveFailures,
        backoffMs,
        assignmentCount: assignments.getAll().length,
      });
    } finally {
      claimInFlight = false;
      if (budgetRegistry) {
        budgetRegistry.releaseOneShotTask(budgetTokenId);
      }

      if (pendingQueuedWake && assignments.getAll().length > 0) {
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
      clearClaimTimer();
      if (refreshSoonTimer) {
        clearTimeout(refreshSoonTimer);
        refreshSoonTimer = null;
      }
    },
    resume: () => {
      if (stopped || !paused) return;
      paused = false;
      void refreshAssignments();
      rescheduleClaim('resumed');
    },
    handleServerUpdate: (update: Update) => {
      if (stopped) return;
      const body = update?.body;
      if (!body || typeof body !== 'object') return;

      if (body.t === 'automation-assignment-updated' && body.machineId === params.machineId) {
        scheduleAssignmentsRefreshSoon('socket-assignment-updated');
        return;
      }

      invalidateActiveExecution(update);

      if (body.t === 'automation-run-updated' && body.state === 'queued') {
        pendingQueuedWake = true;
        if (assignments.getAll().length === 0) {
          void refreshAssignments().catch((error) => {
            logAutomationWarn('Failed to refresh automation assignments after queued wake', error, {
              machineId: params.machineId,
            });
          });
          return;
        }
        scheduleClaimSoon('socket-run-queued');
      }
    },
  };
}
