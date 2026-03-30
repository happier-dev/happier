import type {
  SpawnSessionOptions,
  SpawnSessionResult,
} from '@/rpc/handlers/registerSessionHandlers';

import { createAutomationAssignmentCache } from './automationAssignmentCache';
import { classifyAutomationWorkerError, nextAutomationRetryDelayMs } from './automationBackoffPolicy';
import { createAutomationClaimClient } from './automationClaimClient';
import { getAutomationWorkerFeatureDecision } from './automationFeatureGate';
import { executeClaimedRun, type ClaimableRunPayload } from './automationRunExecutor';
import { resolveAutomationPollingConfig } from './automationScheduler';
import type { AutomationTemplateEncryption } from './automationTemplateExecution';
import { logAutomationInfo, logAutomationWarn } from './automationTelemetry';
import type { AutomationClaimRunResponse } from './automationTypes';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { startSingleFlightIntervalLoop, type SingleFlightIntervalLoopHandle } from '@/daemon/lifecycle/singleFlightIntervalLoop';
import type { Update } from '@/api/types';

export type AutomationWorkerHandle = Readonly<{
  stop: () => void;
  refreshAssignments: () => Promise<void>;
  handleServerUpdate: (update: Update) => void;
  pause: () => void;
  resume: () => void;
}>;

function toClaimableRunPayload(claimResult: AutomationClaimRunResponse): ClaimableRunPayload | null {
  if (!claimResult.run || !claimResult.automation) {
    return null;
  }
  return {
    run: claimResult.run,
    automation: claimResult.automation,
  };
}

function getStatusCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const response = (error as { response?: { status?: unknown } }).response;
  const status = response?.status;
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}

function getErrorUrl(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const url = (error as { config?: { url?: unknown } }).config?.url;
  return typeof url === 'string' && url.trim().length > 0 ? url.trim() : null;
}

function isMissingAutomationEndpointError(error: unknown, expectedPathname: string): boolean {
  const status = getStatusCode(error);
  if (status !== 404 && status !== 405 && status !== 501) {
    return false;
  }

  const url = getErrorUrl(error);
  if (!url) return false;
  try {
    return new URL(url).pathname === expectedPathname;
  } catch {
    return false;
  }
}

export function startAutomationWorker(params: {
  token: string;
  machineId: string;
  encryption: AutomationTemplateEncryption;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
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
  const assignments = createAutomationAssignmentCache();
  const budgetTokenId = `automation_worker:${params.machineId}`;

  let stopped = false;
  let paused = false;
  let consecutiveFailures = 0;
  let retryAfter = 0;
  let noWorkCooldownUntil = 0;
  let pendingQueuedWake = false;

  let assignmentsLoop: SingleFlightIntervalLoopHandle | null = null;
  let claimTimer: NodeJS.Timeout | null = null;
  let claimTimerAt = 0;
  let claimInFlight = false;
  let refreshSoonTimer: NodeJS.Timeout | null = null;

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

  function scheduleClaimAt(whenMs: number, reason: string) {
    if (stopped) return;
    if (paused) return;
    const at = Math.max(Date.now(), Math.floor(whenMs));
    if (claimTimer && claimTimerAt > 0 && claimTimerAt <= at) {
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
      const candidate = row.automation.nextRunAt;
      if (typeof candidate !== 'number' || !Number.isFinite(candidate)) continue;
      if (next === null || candidate < next) {
        next = candidate;
      }
    }
    return next;
  }

  function rescheduleClaim(reason: string) {
    if (stopped) return;
    const rows = assignments.getAll();
    if (rows.length === 0) {
      clearClaimTimer();
      return;
    }

    const now = Date.now();
    const blockedUntil = Math.max(retryAfter, noWorkCooldownUntil);
    if (blockedUntil > now) {
      scheduleClaimAt(blockedUntil, `${reason}:blocked`);
      return;
    }

    const nextRunAt = getNextAssignedRunAtMs();
    if (nextRunAt === null) {
      // If the server isn't providing a nextRunAt (invalid schedule, etc), avoid tight polling but keep a
      // periodic safety check for missed socket hints / reconnect gaps.
      scheduleClaimAt(now + Math.max(scheduler.leaseDurationMs, scheduler.assignmentsRefreshMs), `${reason}:safety`);
      return;
    }

    if (nextRunAt <= now) {
      scheduleClaimSoon(`${reason}:due`);
      return;
    }

    scheduleClaimAt(nextRunAt, `${reason}:scheduled`);
  }

  const stopWorker = (reason: 'manual' | 'unsupported-endpoint') => {
    if (stopped) return;
    stopped = true;
    assignmentsLoop?.stop();
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

  const refreshAssignments = async () => {
    if (stopped) return;
    if (paused) return;
    try {
      const response = await claimClient.fetchAssignments(params.machineId);
      assignments.replace(response.assignments);
      logAutomationInfo('Assignments refreshed', {
        machineId: params.machineId,
        count: response.assignments.length,
      });
      if (pendingQueuedWake && response.assignments.length > 0) {
        scheduleClaimSoon('queued-wake-after-assignments-refresh');
        return;
      }
      rescheduleClaim('assignments-refreshed');
    } catch (error) {
      if (isMissingAutomationEndpointError(error, '/v2/automations/daemon/assignments')) {
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
    const assignmentCount = assignments.getAll().length;
    if (assignmentCount === 0) {
      clearClaimTimer();
      return;
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
    // Automation runs should respect the shared daemon ephemeral-task budget so we don't
    // starve other daemon work (and vice-versa).
    if (budgetRegistry && !budgetRegistry.tryAcquireEphemeralTask(budgetTokenId, 'ephemeral_task')) {
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

      await executeClaimedRun({
        token: params.token,
        machineId: params.machineId,
        claimClient,
        spawnSession: params.spawnSession,
        heartbeatMs: scheduler.heartbeatMs,
        leaseDurationMs: scheduler.leaseDurationMs,
        encryption: params.encryption,
        claimed,
      });

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
      if (isMissingAutomationEndpointError(error, '/v2/automations/runs/claim')) {
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
        budgetRegistry.releaseEphemeralTask(budgetTokenId);
      }

      if (pendingQueuedWake && assignments.getAll().length > 0) {
        scheduleClaimSoon('queued-wake-pending');
        return;
      }
      rescheduleClaim('tick-complete');
    }
  };

  assignmentsLoop = startSingleFlightIntervalLoop({
    intervalMs: scheduler.assignmentsRefreshMs,
    task: refreshAssignments,
  });

  assignmentsLoop.trigger();

  logAutomationInfo('Automation worker started', {
    machineId: params.machineId,
    assignmentsRefreshMs: scheduler.assignmentsRefreshMs,
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
      assignmentsLoop?.pause();
    },
    resume: () => {
      if (stopped || !paused) return;
      paused = false;
      assignmentsLoop?.resume();
    },
    handleServerUpdate: (update: Update) => {
      if (stopped) return;
      const body: any = update?.body as any;
      if (!body || typeof body !== 'object') return;

      if (body.t === 'automation-assignment-updated' && body.machineId === params.machineId) {
        scheduleAssignmentsRefreshSoon('socket-assignment-updated');
        return;
      }

      if (body.t === 'automation-run-updated' && body.state === 'queued') {
        pendingQueuedWake = true;
        scheduleClaimSoon('socket-run-queued');
      }
    },
  };
}
