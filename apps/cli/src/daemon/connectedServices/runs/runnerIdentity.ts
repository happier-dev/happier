import { isDeepStrictEqual } from 'node:util';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { TrackedSession } from '@/daemon/types';
import { readRetainedExecutionRunRecord } from '@/daemon/executionRunRegistry';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { processGenerationMatches, readProcessIdentityByPid } from '@/daemon/processIdentity';
import { findTrackedSessionByRunnerPid, resolveTrackedSessionRunnerIdentity } from '@/daemon/sessions/sessionReportCorrelation';
import { normalizeOptionalString } from '../sessionAuthSwitch/targets';
import type { CreateExecutionRunConnectedServicesBridgeDeps } from './executionRunMaterialization';
import { trackedSessionOnProcess, type TrackedSessionMap } from '@/daemon/sessions/sessionTrackingKey';

/** One identity owner for Session runners and in-daemon detached Runs. */
export function createExecutionRunConnectedServicesRunnerIdentityCapture(params: Readonly<{
  machineId: string;
  serverId?: string;
  externalActionAccountId?: string;
  trackedSessionsByKey: TrackedSessionMap;
  getApiMachineForSessions(): ApiMachineClient | null;
  isCurrent(): boolean;
}>): CreateExecutionRunConnectedServicesBridgeDeps['captureRunnerIdentity'] {
  return async ({ runnerPid, expectedParentSessionId, runId, controllerOccurrenceId }) => {
    if (runnerPid === process.pid && expectedParentSessionId === undefined && runId !== undefined) {
      const record = await readRetainedExecutionRunRecord(runId).catch(() => null);
      const attribution = record?.requesterWorkAttributionV1;
      if (record?.state.runId === runId && record.state.sessionId === null) {
        const resume = record.state.status !== 'running' && controllerOccurrenceId
          ? params.getApiMachineForSessions()?.captureExecutionRunResumeMaterialization(runId, controllerOccurrenceId) : null;
        if (record.state.status === 'running') {
          const processIdentity = await readProcessIdentityByPid(process.pid);
          if (record.ownerPid !== process.pid || record.ownerProcessStartTimeMs === undefined
            || processIdentity?.processStartTimeMs === undefined
            || !processGenerationMatches(record.ownerProcessStartTimeMs, processIdentity.processStartTimeMs)) return null;
        } else if (!resume?.isCurrent()) return null;
        // A retained conversation can outlive its original daemon. Its exact
        // admitted resume controller owns current custody on the replacement host.
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
        return Object.freeze({ identity: params, parentSessionId: null,
          ...(requester ? { requesterSessionBootstrap: requester.bootstrap } : {}),
          isCurrent: () => params.isCurrent() && (!requester || requester.isCurrent()) && (!resume || resume.isCurrent()) });
      }
    }
    // A Run belongs to the Session that started it: its retained record (or the caller) names that
    // Session. One process may host several Sessions, so its pid alone never picks the Session.
    const record = runId === undefined ? null : await readRetainedExecutionRunRecord(runId).catch(() => null);
    if (runId !== undefined && (!record || record.state.runId !== runId)) return null;
    const runSessionId = record ? normalizeOptionalString(record.state.sessionId) : expectedParentSessionId;
    if (record && (!runSessionId || (expectedParentSessionId !== undefined && runSessionId !== expectedParentSessionId))) return null;
    const resolveTracked = () => trackedSessionOnProcess(params.trackedSessionsByKey, runnerPid, runSessionId)
      ?? (runSessionId === undefined ? findTrackedSessionByRunnerPid(params.trackedSessionsByKey, runnerPid) : undefined);
    const tracked = resolveTracked();
    if (!tracked) return null;
    const parentSessionId = normalizeOptionalString(tracked.happySessionId);
    if (!parentSessionId || (runSessionId !== undefined && parentSessionId !== runSessionId)) return null;
    const runnerIdentity = resolveTrackedSessionRunnerIdentity(tracked);
    const runnerStartTimeMs = runnerIdentity?.processStartTimeMs;
    if (runId !== undefined && (!runnerIdentity || runnerIdentity.pid !== runnerPid)) return null;
    return Object.freeze({ identity: tracked, parentSessionId,
      isCurrent: () => {
        const currentRunner = resolveTrackedSessionRunnerIdentity(tracked);
        return resolveTracked() === tracked && tracked.happySessionId === parentSessionId
          && (runId === undefined || (currentRunner?.pid === runnerPid && runnerStartTimeMs !== undefined
            && processGenerationMatches(currentRunner.processStartTimeMs, runnerStartTimeMs)));
      } });
  };
}
