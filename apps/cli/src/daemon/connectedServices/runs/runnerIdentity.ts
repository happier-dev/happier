import { isDeepStrictEqual } from 'node:util';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { TrackedSession } from '@/daemon/types';
import { readRetainedExecutionRunRecord } from '@/daemon/executionRunRegistry';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { processGenerationMatches, readProcessIdentityByPid } from '@/daemon/processIdentity';
import { findTrackedSessionByRunnerPid, resolveTrackedSessionRunnerIdentity } from '@/daemon/sessions/sessionReportCorrelation';
import { normalizeOptionalString } from '../sessionAuthSwitch/targets';
import type { CreateExecutionRunConnectedServicesBridgeDeps } from './executionRunMaterialization';

/** One identity owner for Session runners and in-daemon detached Runs. */
export function createExecutionRunConnectedServicesRunnerIdentityCapture(params: Readonly<{
  machineId: string;
  serverId?: string;
  externalActionAccountId?: string;
  pidToTrackedSession: Map<number, TrackedSession>;
  getApiMachineForSessions(): ApiMachineClient | null;
  isCurrent(): boolean;
}>): CreateExecutionRunConnectedServicesBridgeDeps['captureRunnerIdentity'] {
  return async ({ runnerPid, expectedParentSessionId, runId, controllerOccurrenceId }) => {
    if (runnerPid === process.pid && expectedParentSessionId === undefined && runId !== undefined) {
      const record = await readRetainedExecutionRunRecord(runId).catch(() => null);
      const processIdentity = await readProcessIdentityByPid(process.pid);
      const attribution = record?.requesterWorkAttributionV1;
      if (record?.state.runId === runId && record.state.sessionId === null
        && record.ownerPid === process.pid && record.ownerProcessStartTimeMs !== undefined
        && processIdentity?.processStartTimeMs !== undefined
        && processGenerationMatches(record.ownerProcessStartTimeMs, processIdentity.processStartTimeMs)) {
        const requester = attribution && attribution.accountId !== params.externalActionAccountId
          ? params.getApiMachineForSessions()?.captureExecutionRunWorkflowRequester(runId) : null;
        // A Workflow borrows its already admitted requester. Attribution alone
        // cannot turn another Account's ordinary detached Run into guest custody.
        if (attribution && (attribution.serverId !== params.serverId || attribution.machineId !== params.machineId
          || (attribution.accountId !== params.externalActionAccountId && (!requester
            || record.state.originWorkflowRunId !== requester.workflowRunId
            || attribution.installationId !== readInstallationIdentityIfExistsSync()?.installationId
            || !isDeepStrictEqual(attribution, requester.bootstrap.attribution)
            || !requester.isCurrent() || !await requester.bootstrap.isCurrent())))) return null;
        const resume = record.state.status !== 'running' && controllerOccurrenceId
          ? params.getApiMachineForSessions()?.captureExecutionRunResumeMaterialization(runId, controllerOccurrenceId) : null;
        if (record.state.status !== 'running' && !resume?.isCurrent()) return null;
        return Object.freeze({ identity: params, parentSessionId: null,
          ...(requester ? { requesterSessionBootstrap: requester.bootstrap } : {}),
          isCurrent: () => params.isCurrent() && (!requester || requester.isCurrent()) && (!resume || resume.isCurrent()) });
      }
    }
    const resolveTracked = () => params.pidToTrackedSession.get(runnerPid)
      ?? findTrackedSessionByRunnerPid(params.pidToTrackedSession, runnerPid);
    const tracked = resolveTracked();
    if (!tracked) return null;
    const parentSessionId = normalizeOptionalString(tracked.happySessionId);
    if (!parentSessionId || (expectedParentSessionId !== undefined && parentSessionId !== expectedParentSessionId)) return null;
    const runnerIdentity = resolveTrackedSessionRunnerIdentity(tracked);
    const runnerStartTimeMs = runnerIdentity?.processStartTimeMs;
    if (runId !== undefined) {
      const record = await readRetainedExecutionRunRecord(runId).catch(() => null);
      if (!record || record.state.runId !== runId || record.state.sessionId !== parentSessionId
        || !runnerIdentity || runnerIdentity.pid !== runnerPid) return null;
    }
    return Object.freeze({ identity: tracked, parentSessionId,
      isCurrent: () => {
        const currentRunner = resolveTrackedSessionRunnerIdentity(tracked);
        return resolveTracked() === tracked && tracked.happySessionId === parentSessionId
          && (runId === undefined || (currentRunner?.pid === runnerPid && runnerStartTimeMs !== undefined
            && processGenerationMatches(currentRunner.processStartTimeMs, runnerStartTimeMs)));
      } });
  };
}
