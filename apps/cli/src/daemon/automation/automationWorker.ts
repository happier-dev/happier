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

export type AutomationWorkerHandle = Readonly<{
  stop: () => void;
  refreshAssignments: () => Promise<void>;
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
    };
  }

  const scheduler = resolveAutomationPollingConfig(env);
  const claimClient = createAutomationClaimClient({ token: params.token });
  const assignments = createAutomationAssignmentCache();
  const budgetTokenId = `automation_worker:${params.machineId}`;

  let stopped = false;
  let consecutiveFailures = 0;
  let retryAfter = 0;

  let claimLoop: SingleFlightIntervalLoopHandle | null = null;
  let assignmentsLoop: SingleFlightIntervalLoopHandle | null = null;

  const stopWorker = (reason: 'manual' | 'unsupported-endpoint') => {
    if (stopped) return;
    stopped = true;
    claimLoop?.stop();
    assignmentsLoop?.stop();
    logAutomationInfo('Automation worker stopped', {
      machineId: params.machineId,
      reason,
    });
  };

  const refreshAssignments = async () => {
    if (stopped) return;
    try {
      const response = await claimClient.fetchAssignments(params.machineId);
      assignments.replace(response.assignments);
      logAutomationInfo('Assignments refreshed', {
        machineId: params.machineId,
        count: response.assignments.length,
      });
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

  const runTick = async () => {
    if (stopped) return;
    if (Date.now() < retryAfter) return;

    const budgetRegistry = params.budgetRegistry;
    // Automation runs should respect the shared daemon ephemeral-task budget so we don't
    // starve other daemon work (and vice-versa).
    if (budgetRegistry && !budgetRegistry.tryAcquireEphemeralTask(budgetTokenId, 'ephemeral_task')) {
      return;
    }
    try {
      const claimResult = await claimClient.claimRun({
        machineId: params.machineId,
        leaseDurationMs: scheduler.leaseDurationMs,
      });

      const claimed = toClaimableRunPayload(claimResult);
      if (!claimed) {
        consecutiveFailures = 0;
        retryAfter = 0;
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

      consecutiveFailures = 0;
      retryAfter = 0;
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
      if (budgetRegistry) {
        budgetRegistry.releaseEphemeralTask(budgetTokenId);
      }
    }
  };

  claimLoop = startSingleFlightIntervalLoop({
    intervalMs: scheduler.claimPollMs,
    task: runTick,
  });
  assignmentsLoop = startSingleFlightIntervalLoop({
    intervalMs: scheduler.assignmentsRefreshMs,
    task: refreshAssignments,
  });

  assignmentsLoop.trigger();
  claimLoop.trigger();

  logAutomationInfo('Automation worker started', {
    machineId: params.machineId,
    claimPollMs: scheduler.claimPollMs,
    assignmentsRefreshMs: scheduler.assignmentsRefreshMs,
    leaseDurationMs: scheduler.leaseDurationMs,
    heartbeatMs: scheduler.heartbeatMs,
  });

  return {
    stop: () => stopWorker('manual'),
    refreshAssignments: async () => {
      await refreshAssignments();
    },
  };
}
