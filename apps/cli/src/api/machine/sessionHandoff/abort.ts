import { SessionHandoffAbortRequestSchema } from '@happier-dev/protocol/sessions/control/handoff/handoffSchemas';
import type { SessionHandoffStatus } from '@happier-dev/protocol';

import {
  createSessionHandoffPrepareTargetJobStore,
  type SessionHandoffPrepareTargetJobRecord,
  type SessionHandoffPrepareTargetJobRecordInput,
} from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { createSessionHandoffSourceExportStore } from '../../../session/handoff/state/sessionHandoffSourceExportStore';
import { buildSessionHandoffAgentBundleTransferId, buildSessionHandoffWorkspaceSeedTransferId } from '../../../session/handoff/agentBundle/transferPublication';
import { createManagedSessionDirectories } from '../../../session/creation/managedSessionDirectories';
import { tryAcquireSessionHandoffPrepareTargetJobLease, releaseSessionHandoffPrepareTargetJobLease } from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobLease';
import { configuration } from '@/configuration';

import type { SessionHandoffDirectPeerTransferHandle } from './prepareTransport';

type SessionHandoffPrepareTargetJobStore = ReturnType<typeof createSessionHandoffPrepareTargetJobStore>;
type SessionHandoffSourceExportStore = ReturnType<typeof createSessionHandoffSourceExportStore>;

export type RegisterSessionHandoffAbortRpcHandlerInput = Readonly<{
  activeServerDir?: string;
  prepareJobStore: SessionHandoffPrepareTargetJobStore;
  sourceExportStore: SessionHandoffSourceExportStore;
  directPeerTransfer: SessionHandoffDirectPeerTransferHandle | undefined;
  stopSessionForHandoff?: (sessionId: string, options?: Readonly<{ expectedSpawnNonce: string }>) => Promise<'stopped' | 'already_inactive' | 'failed'>;
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

    let persistedJob = await readPersistedPrepareJob({
      handoffId: parsed.data.handoffId,
      jobStore: prepareJobStore,
    });
    const persistedSourceExport = await sourceExportStore.load(parsed.data.handoffId);
    if (!persistedJob && !persistedSourceExport) return { ok: false, errorCode: 'not_found' } as const;

    if (persistedJob?.status.status === 'completed') return { handoffId: parsed.data.handoffId, status: persistedJob.status };
    if (persistedJob?.schemaVersion === 2 && persistedJob.recordKind === 'prepared_target'
      && persistedJob.terminal.status !== 'aborted') {
      const claimed = await prepareJobStore.transitionPredecessorV2(persistedJob.jobId, current => {
        if (current.recordKind !== 'prepared_target' || current.terminal.status === 'completed'
          || current.terminal.status === 'aborted') return null;
        const revision = current.transitionRevision + 1;
        return { ...current, transitionRevision: revision, updatedAtMs: Date.now(),
          cancelRequestedAtMs: current.cancelRequestedAtMs ?? Date.now(),
          ...(current.resume.status === 'preexisting_unowned' ? {
            targetCleanup: { status: 'not_owned' as const, reason: 'preexisting_or_adopted' as const },
          } : current.resume.status === 'not_attempted' ? {
            targetCleanup: { status: 'not_owned' as const, reason: 'resume_not_attempted' as const },
          } : {}),
          terminal: { status: 'aborting', operationId: current.terminal.status === 'aborting'
            ? current.terminal.operationId : current.handoffId, claimedRevision: revision } };
      });
      if (claimed?.recordKind !== 'prepared_target' || claimed.terminal.status !== 'aborting') {
        return { ok: false, errorCode: 'not_ready' } as const;
      }
      persistedJob = claimed;
      if ((claimed.resume.status === 'attempted' || claimed.resume.status === 'confirmed')
        && claimed.targetCleanup.status !== 'proved_absent') {
        let stopResult: 'stopped' | 'already_inactive' | 'failed' = 'failed';
        try { stopResult = await params.stopSessionForHandoff?.(claimed.sessionId,
          { expectedSpawnNonce: claimed.resume.attemptId }) ?? 'failed'; } catch { /* Failed stop retains private custody. */ }
        const settled = await prepareJobStore.transitionPredecessorV2(claimed.jobId, current => {
          if (current.recordKind !== 'prepared_target' || current.terminal.status !== 'aborting') return null;
          const revision = current.transitionRevision + 1;
          const now = Date.now();
          return { ...current, transitionRevision: revision, updatedAtMs: now,
            terminal: { ...current.terminal, claimedRevision: revision },
            targetCleanup: stopResult === 'failed' ? { status: 'failed', reason: 'failed', attemptedAtMs: now }
              : { status: 'proved_absent', proof: stopResult, provedAtMs: now } };
        });
        if (stopResult === 'failed' || !settled) return { ok: false, errorCode: 'target_stop_failed' } as const;
        persistedJob = settled;
      }
    }

    if (persistedJob) {
      const abortedAtMs = Date.now();
      const transitioned = await prepareJobStore.update(persistedJob.jobId, (current) => {
        if (current.status.status === 'completed') return current;
        const status: SessionHandoffStatus = { ...current.status, status: 'aborted' };
        return {
          ...current,
          updatedAtMs: abortedAtMs,
          cancelRequestedAtMs: current.cancelRequestedAtMs ?? abortedAtMs,
          abortedAtMs,
          status,
          ...(current.prepareTargetResult ? {
            prepareTargetResult: { ...current.prepareTargetResult, status },
          } : {}),
        };
      });
      if (transitioned?.status.status === 'completed') {
        return { handoffId: parsed.data.handoffId, status: transitioned.status };
      }
      persistedJob = transitioned ?? persistedJob;
      if (persistedJob.schemaVersion === 2 && persistedJob.terminal.status === 'aborting') {
        persistedJob = await prepareJobStore.transitionPredecessorV2(persistedJob.jobId, current => {
          if (current.terminal.status !== 'aborting') return null;
          const revision = current.transitionRevision + 1;
          return { ...current, transitionRevision: revision, updatedAtMs: Date.now(),
            terminal: { status: 'aborted', operationId: current.terminal.operationId, completedRevision: revision } };
        }) ?? persistedJob;
      }
      const targetRequest = persistedJob.prepareTargetRequest;
      if (targetRequest?.targetDirectory?.kind === 'managed' && targetRequest.operationId && targetRequest.sessionId) {
        const activeServerDir = params.activeServerDir ?? configuration.activeServerDir;
        const ownerId = `cli-daemon:${process.pid}:handoff-abort`;
        // Reuse the prepare writer's existing lease. Active writers clean up in
        // their cancellation finally; crashed pending jobs have no writer left.
        const lease = await tryAcquireSessionHandoffPrepareTargetJobLease({ activeServerDir,
          jobId: persistedJob.jobId, ownerId, nowMs: Date.now(),
        });
        if (lease.acquired) {
          try {
            await createManagedSessionDirectories({ activeServerDir }).abortHandoff({
              operationId: targetRequest.operationId, sessionId: targetRequest.sessionId,
            });
          } finally {
            await releaseSessionHandoffPrepareTargetJobLease({ activeServerDir, jobId: persistedJob.jobId, ownerId });
          }
        }
      }
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
    directPeerTransfer?.clearPublishedTransfer(buildSessionHandoffWorkspaceSeedTransferId(parsed.data.handoffId));
    await sourceExportStore.releaseTransferFiles(parsed.data.handoffId, {
      preserveRequesterSessionCustody: persistedJob?.schemaVersion === 2 && persistedJob.recordKind === 'prepared_target'
        && persistedJob.resume.status === 'preexisting_unowned',
    });
    return { handoffId: parsed.data.handoffId, status };
  };
}
