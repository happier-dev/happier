import {
  SessionHandoffCommitRequestSchema,
  type SessionHandoffPrepareTargetRequest,
  type SessionHandoffPrepareTargetResultGetSuccessResponse,
  type SessionHandoffStatus,
} from '@happier-dev/protocol';

import {
  createSessionHandoffPrepareTargetJobStore,
  type SessionHandoffPrepareTargetJobRecord,
  type SessionHandoffPrepareTargetJobRecordInput,
} from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { createSessionHandoffSourceExportStore } from '../../../session/handoff/state/sessionHandoffSourceExportStore';
import { buildSessionHandoffAgentBundleTransferId } from '../../../session/handoff/agentBundle/transferPublication';
import { createSessionHandoffWorkspaceReplicationAdapter } from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/adapter';
import { buildSessionHandoffWorkspaceManifestTransferId } from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/serverRouted';
import { readWorkspaceReplicationManifestFromFile } from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/manifestFile';

import type { SessionHandoffDirectPeerTransferHandle } from './prepareTransport';

type SessionHandoffPrepareTargetJobStore = ReturnType<typeof createSessionHandoffPrepareTargetJobStore>;
type SessionHandoffSourceExportStore = ReturnType<typeof createSessionHandoffSourceExportStore>;
type SessionHandoffWorkspaceReplicationAdapter = ReturnType<typeof createSessionHandoffWorkspaceReplicationAdapter>;

export type RegisterSessionHandoffCommitRpcHandlerInput = Readonly<{
  activeServerDir: string;
  prepareJobStore: SessionHandoffPrepareTargetJobStore;
  sourceExportStore: SessionHandoffSourceExportStore;
  workspaceReplicationAdapter: SessionHandoffWorkspaceReplicationAdapter;
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
    workspaceReplicationJobId?: string;
  }>) => SessionHandoffPrepareTargetJobRecordInput;
  buildStartPendingStatus: (input: Readonly<{
    handoffId: string;
    sourceStopState: 'stopped' | 'already_inactive';
  }>) => SessionHandoffStatus;
  buildSourceExportOnlyPrepareJobId: (handoffId: string) => string;
  invalidateDirectPeerRouteCacheForHandoffMachines: (machineIds: readonly (string | undefined)[]) => void;
  disposeEphemeralServerRoutedPayloadSourcesForHandoff: (handoffId: string) => Promise<void>;
  invalidRequest: () => Readonly<{
    ok: false;
    errorCode: 'invalid_request';
  }>;
}>;

function normalizeReverseRootPath(raw: unknown): string | null {
  const candidate = typeof raw === 'string' ? raw.trim() : '';
  if (!candidate.startsWith('/')) return null;
  if (candidate.includes('\0')) return null;
  const segments = candidate.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === '..')) return null;
  return `/${segments.join('/')}`;
}

export function createSessionHandoffCommitActionHandler(
  params: RegisterSessionHandoffCommitRpcHandlerInput,
): (raw: unknown) => Promise<unknown> {
  const {
    activeServerDir,
    prepareJobStore,
    sourceExportStore,
    workspaceReplicationAdapter,
    directPeerTransfer,
    stopSessionForHandoff,
    readPersistedPrepareJob,
    buildPrepareJobRecord,
    buildStartPendingStatus,
    buildSourceExportOnlyPrepareJobId,
    invalidateDirectPeerRouteCacheForHandoffMachines,
    disposeEphemeralServerRoutedPayloadSourcesForHandoff,
    invalidRequest,
  } = params;

  return async (raw: unknown) => {
    const parsed = SessionHandoffCommitRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();

    const mode = parsed.data.mode ?? 'target';
    const persistedJob = await readPersistedPrepareJob({
      handoffId: parsed.data.handoffId,
      jobStore: prepareJobStore,
    });
    const persistedSourceExport = await sourceExportStore.load(parsed.data.handoffId);
    const currentStatus = persistedJob?.status;
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
      if (persistedSourceExport?.sessionId && stopSessionForHandoff) {
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

      // `sync_changes` in one-way-safe mode requires a baseline for the (source->target) direction.
      // After a successful cutover, persist the reverse-direction baseline locally so a subsequent
      // “handoff back” can use `sync_changes` immediately without forcing a full snapshot transfer.
      if (
        persistedSourceExport?.workspaceManifest
        && persistedSourceExport.sourceMachineId
        && persistedSourceExport.targetMachineId
      ) {
        const reverseSourceRootPath = normalizeReverseRootPath(parsed.data.workspaceReplicationReverseSourceRootPath);
        const reverseTargetRootPath = normalizeReverseRootPath(parsed.data.workspaceReplicationReverseTargetRootPath);
        if (reverseSourceRootPath && reverseTargetRootPath) {
          const reverseScope = {
            sourceMachineId: persistedSourceExport.targetMachineId,
            sourceWorkspaceRoot: reverseSourceRootPath,
            targetMachineId: persistedSourceExport.sourceMachineId,
            targetWorkspaceRoot: reverseTargetRootPath,
            mode: 'one_way_safe' as const,
          };

          // Canonicalize ordering + fingerprint so the saved baseline matches what the engine will
          // compute when building offers from manifests later.
          const manifest = await readWorkspaceReplicationManifestFromFile({
            transferId: persistedSourceExport.workspaceManifest.transferId,
            filePath: persistedSourceExport.workspaceManifest.filePath,
            sizeBytes: persistedSourceExport.workspaceManifest.sizeBytes,
          });
          await workspaceReplicationAdapter.persistBaselineFromManifest({
            activeServerDir,
            scope: reverseScope,
            manifest,
            savedAtMs: Date.now(),
          });
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
    if (persistedJob) {
      await prepareJobStore.write(buildPrepareJobRecord({
        jobId: persistedJob.jobId,
        handoffId: parsed.data.handoffId,
        createdAtMs: persistedJob.createdAtMs,
        updatedAtMs: Date.now(),
        completedAtMs: Date.now(),
        workspaceReplicationJobId: persistedJob.workspaceReplicationJobId,
        status,
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
    await disposeEphemeralServerRoutedPayloadSourcesForHandoff(parsed.data.handoffId);
    directPeerTransfer?.clearPublishedTransfer(buildSessionHandoffAgentBundleTransferId(parsed.data.handoffId));
    directPeerTransfer?.clearPublishedTransfer(buildSessionHandoffWorkspaceManifestTransferId({ handoffId: parsed.data.handoffId }));
    return { handoffId: parsed.data.handoffId, status };
  };
}
