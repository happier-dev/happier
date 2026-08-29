import { SessionHandoffAbortRequestSchema, type SessionHandoffStatus } from '@happier-dev/protocol';

import {
  createSessionHandoffPrepareTargetJobStore,
  type SessionHandoffPrepareTargetJobRecord,
  type SessionHandoffPrepareTargetJobRecordInput,
} from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { createSessionHandoffSourceExportStore } from '../../../session/handoff/state/sessionHandoffSourceExportStore';
import { buildSessionHandoffAgentBundleTransferId } from '../../../session/handoff/agentBundle/transferPublication';

import type { SessionHandoffDirectPeerTransferHandle } from './prepareTransport';

type SessionHandoffPrepareTargetJobStore = ReturnType<typeof createSessionHandoffPrepareTargetJobStore>;
type SessionHandoffSourceExportStore = ReturnType<typeof createSessionHandoffSourceExportStore>;

export type RegisterSessionHandoffAbortRpcHandlerInput = Readonly<{
  prepareJobStore: SessionHandoffPrepareTargetJobStore;
  sourceExportStore: SessionHandoffSourceExportStore;
  directPeerTransfer: SessionHandoffDirectPeerTransferHandle | undefined;
  readPersistedPrepareJob: (params: Readonly<{
    handoffId: string;
    jobStore: SessionHandoffPrepareTargetJobStore;
  }>) => Promise<SessionHandoffPrepareTargetJobRecord | null>;
  buildPrepareJobRecord: (input: Readonly<{
    jobId: string;
    handoffId: string;
    status: SessionHandoffStatus;
    createdAtMs: number;
    updatedAtMs?: number;
    cancelRequestedAtMs?: number;
    abortedAtMs?: number;
    completedAtMs?: number;
    failedAtMs?: number;
    lastErrorMessage?: string;
    lastErrorCode?: string;
  }>) => SessionHandoffPrepareTargetJobRecordInput;
  buildStartPendingStatus: (input: Readonly<{
    handoffId: string;
    sourceStopState: 'stopped' | 'already_inactive';
  }>) => SessionHandoffStatus;
  buildSourceExportOnlyPrepareJobId: (handoffId: string) => string;
  invalidateDirectPeerRouteCacheForHandoffMachines: (machineIds: readonly (string | undefined)[]) => void;
  invalidRequest: () => Readonly<{
    ok: false;
    errorCode: 'invalid_request';
  }>;
}>;

export function createSessionHandoffAbortActionHandler(
  params: RegisterSessionHandoffAbortRpcHandlerInput,
): (raw: unknown) => Promise<unknown> {
  const {
    prepareJobStore,
    sourceExportStore,
    directPeerTransfer,
    readPersistedPrepareJob,
    buildPrepareJobRecord,
    buildStartPendingStatus,
    buildSourceExportOnlyPrepareJobId,
    invalidateDirectPeerRouteCacheForHandoffMachines,
    invalidRequest,
  } = params;

  return async (raw: unknown) => {
    const parsed = SessionHandoffAbortRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();

    const persistedJob = await readPersistedPrepareJob({
      handoffId: parsed.data.handoffId,
      jobStore: prepareJobStore,
    });
    const persistedSourceExport = await sourceExportStore.load(parsed.data.handoffId);
    if (!persistedJob && !persistedSourceExport) return { ok: false, errorCode: 'not_found' } as const;

    if (persistedJob) {
      const abortedAtMs = Date.now();
      const status: SessionHandoffStatus = {
        ...persistedJob.status,
        status: 'aborted',
      };
      await prepareJobStore.write(buildPrepareJobRecord({
        jobId: persistedJob.jobId,
        handoffId: parsed.data.handoffId,
        createdAtMs: persistedJob.createdAtMs,
        updatedAtMs: abortedAtMs,
        cancelRequestedAtMs: persistedJob.cancelRequestedAtMs ?? abortedAtMs,
        abortedAtMs,
        ...(persistedJob.failedAtMs ? { failedAtMs: persistedJob.failedAtMs } : {}),
        ...(persistedJob.lastErrorMessage ? { lastErrorMessage: persistedJob.lastErrorMessage } : {}),
        ...(persistedJob.lastErrorCode ? { lastErrorCode: persistedJob.lastErrorCode } : {}),
        status,
        ...(persistedJob.prepareTargetResult ? {
          prepareTargetResult: {
            ...persistedJob.prepareTargetResult,
            status,
          },
        } : {}),
      }));
    }

    const baseStatus =
      persistedJob?.status ?? buildStartPendingStatus({ handoffId: parsed.data.handoffId, sourceStopState: 'already_inactive' });
    const status: SessionHandoffStatus = {
      ...baseStatus,
      status: 'aborted',
      phase: baseStatus.phase,
    };
    if (!persistedJob && persistedSourceExport) {
      const abortedAtMs = Date.now();
      const jobId = buildSourceExportOnlyPrepareJobId(parsed.data.handoffId);
      const durableStatus: SessionHandoffStatus = { ...status, jobId };
      await prepareJobStore.write(buildPrepareJobRecord({
        jobId,
        handoffId: parsed.data.handoffId,
        createdAtMs: persistedSourceExport.exportedAtMs,
        updatedAtMs: abortedAtMs,
        cancelRequestedAtMs: abortedAtMs,
        abortedAtMs,
        status: durableStatus,
      }));
      status.jobId = jobId;
    }
    invalidateDirectPeerRouteCacheForHandoffMachines([
      persistedJob?.prepareTargetRequest?.sourceMachineId,
      persistedJob?.prepareTargetRequest?.targetMachineId,
      persistedSourceExport?.sourceMachineId,
      persistedSourceExport?.targetMachineId,
    ]);
    directPeerTransfer?.clearPublishedTransfer(buildSessionHandoffAgentBundleTransferId(parsed.data.handoffId));
    return { handoffId: parsed.data.handoffId, status };
  };
}
