import { SessionHandoffCommitRequestSchema } from '@happier-dev/protocol/sessions/control/handoff/handoffSchemas';
import type { SessionHandoffPrepareTargetRequest, SessionHandoffPrepareTargetResultGetSuccessResponse, SessionHandoffStatus } from '@happier-dev/protocol';

import {
  createSessionHandoffPrepareTargetJobStore,
  type SessionHandoffPrepareTargetJobRecord,
  type SessionHandoffPrepareTargetJobRecordInput,
} from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { createSessionHandoffSourceExportStore } from '../../../session/handoff/state/sessionHandoffSourceExportStore';
import { buildSessionHandoffAgentBundleTransferId, buildSessionHandoffWorkspaceSeedTransferId } from '../../../session/handoff/agentBundle/transferPublication';
import { createManagedSessionDirectories } from '../../../session/creation/managedSessionDirectories';

import type { SessionHandoffDirectPeerTransferHandle } from './prepareTransport';
import { hasUnsupportedWorkspaceAction, workspaceSyncUpdateRequired } from './workspaceSyncGuard';

type SessionHandoffPrepareTargetJobStore = ReturnType<typeof createSessionHandoffPrepareTargetJobStore>;
type SessionHandoffSourceExportStore = ReturnType<typeof createSessionHandoffSourceExportStore>;

export type RegisterSessionHandoffCommitRpcHandlerInput = Readonly<{
  activeServerDir?: string;
  prepareJobStore: SessionHandoffPrepareTargetJobStore;
  sourceExportStore: SessionHandoffSourceExportStore;
  directPeerTransfer: SessionHandoffDirectPeerTransferHandle | undefined;
  stopSessionForHandoff?: (sessionId: string) => Promise<'stopped' | 'already_inactive' | 'failed'>;
  readPersistedPrepareJob: (params: Readonly<{
    handoffId: string;
    jobStore: SessionHandoffPrepareTargetJobStore;
  }>) => Promise<SessionHandoffPrepareTargetJobRecord | null>;
  buildPrepareJobRecord: (input: Readonly<{
    jobId: string;
    handoffId: string;
    status: SessionHandoffStatus;
    prepareTargetRequest?: SessionHandoffPrepareTargetRequest;
    prepareTargetResult?: SessionHandoffPrepareTargetResultGetSuccessResponse;
    createdAtMs: number;
    updatedAtMs?: number;
    cancelRequestedAtMs?: number;
    abortedAtMs?: number;
    completedAtMs?: number;
    failedAtMs?: number;
    lastErrorMessage?: string;
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

export function createSessionHandoffCommitActionHandler(
  params: RegisterSessionHandoffCommitRpcHandlerInput,
): (raw: unknown) => Promise<unknown> {
  const {
    prepareJobStore,
    sourceExportStore,
    directPeerTransfer,
    stopSessionForHandoff,
    readPersistedPrepareJob,
    buildPrepareJobRecord,
    buildStartPendingStatus,
    buildSourceExportOnlyPrepareJobId,
    invalidateDirectPeerRouteCacheForHandoffMachines,
    invalidRequest,
  } = params;

  return async (raw: unknown) => {
    if (hasUnsupportedWorkspaceAction(raw)) return workspaceSyncUpdateRequired();
    const parsed = SessionHandoffCommitRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();

    const mode = parsed.data.mode ?? 'target';
    const persistedJob = await readPersistedPrepareJob({
      handoffId: parsed.data.handoffId,
      jobStore: prepareJobStore,
    });
    const persistedSourceExport = await sourceExportStore.load(parsed.data.handoffId);
    const currentStatus = persistedJob?.status;
    const sameMachine = persistedSourceExport?.sourceMachineId !== undefined
      && persistedSourceExport.sourceMachineId === persistedSourceExport.targetMachineId;
    if (mode === 'source_cleanup' && sameMachine && currentStatus?.status !== 'completed') {
      return { ok: false, errorCode: 'not_ready', error: 'Local target must be committed before source cleanup' } as const;
    }
    if (
      mode === 'target'
      && currentStatus
      && currentStatus.status !== 'ready_for_cutover'
      && currentStatus.status !== 'completed'
    ) {
      // Fail closed: commit is not safe while the target is still being prepared because the daemon
      // would dispose transfer payload sources while the prepare job is still running.
      return {
        ok: false,
        errorCode: 'not_ready',
        error: 'Handoff target is not ready for cutover',
        handoffId: parsed.data.handoffId,
        status: currentStatus,
      } as const;
    }

    if (mode === 'source_cleanup') {
      // Start already stopped the source locally; this id now belongs to the target runner.
      if (!sameMachine && persistedSourceExport?.sessionId && stopSessionForHandoff) {
        try {
          const stopResult = await stopSessionForHandoff(persistedSourceExport.sessionId);
          if (stopResult === 'failed') {
            return {
              ok: false,
              errorCode: 'source_stop_failed',
              error: 'Failed to stop the active source session during handoff cleanup',
              handoffId: parsed.data.handoffId,
              ...(currentStatus ? { status: currentStatus } : {}),
            } as const;
          }
        } catch (error) {
          return {
            ok: false,
            errorCode: 'source_stop_failed',
            error: error instanceof Error ? error.message : 'Failed to stop the active source session during handoff cleanup',
            handoffId: parsed.data.handoffId,
            ...(currentStatus ? { status: currentStatus } : {}),
          } as const;
        }
      }

    }

    if (!persistedJob && !persistedSourceExport) {
      return { ok: false, errorCode: 'not_found' } as const;
    }

    const status: SessionHandoffStatus = {
      ...(currentStatus ?? buildStartPendingStatus({ handoffId: parsed.data.handoffId, sourceStopState: 'already_inactive' })),
      status: 'completed',
      phase: 'finalizing',
    };
    const targetRequest = persistedJob?.prepareTargetRequest;
    if (mode === 'target' && targetRequest?.targetDirectory?.kind === 'managed'
      && targetRequest.operationId && targetRequest.sessionId) {
      await createManagedSessionDirectories({ activeServerDir: params.activeServerDir }).commitHandoff({
        operationId: targetRequest.operationId, sessionId: targetRequest.sessionId,
      });
    }
    if (persistedJob) {
      await prepareJobStore.write(buildPrepareJobRecord({
        jobId: persistedJob.jobId,
        handoffId: parsed.data.handoffId,
        createdAtMs: persistedJob.createdAtMs,
        updatedAtMs: Date.now(),
        completedAtMs: Date.now(),
        status,
        ...(persistedJob.prepareTargetRequest ? { prepareTargetRequest: persistedJob.prepareTargetRequest } : {}),
        ...(persistedJob.prepareTargetResult ? {
          prepareTargetResult: {
            ...persistedJob.prepareTargetResult,
            status,
          },
        } : {}),
      }));
    } else if (persistedSourceExport) {
      const completedAtMs = Date.now();
      const jobId = buildSourceExportOnlyPrepareJobId(parsed.data.handoffId);
      const durableStatus: SessionHandoffStatus = { ...status, jobId };
      await prepareJobStore.write(buildPrepareJobRecord({
        jobId,
        handoffId: parsed.data.handoffId,
        createdAtMs: persistedSourceExport.exportedAtMs,
        updatedAtMs: completedAtMs,
        completedAtMs,
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
    directPeerTransfer?.clearPublishedTransfer(buildSessionHandoffWorkspaceSeedTransferId(parsed.data.handoffId));
    await sourceExportStore.releaseTransferFiles(parsed.data.handoffId);
    return { handoffId: parsed.data.handoffId, status };
  };
}
