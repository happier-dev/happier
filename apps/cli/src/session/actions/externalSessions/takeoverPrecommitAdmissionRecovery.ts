import type { ExternalSessionOperationRecordV1 } from '@happier-dev/protocol';

import {
  mutateExternalSessionOperationRecordAtRevision,
  readExternalSessionOperationRecord,
} from './operationRecordStore';

export type ExternalSessionTakeoverPrecommitAdmissionRecoveryInput = Readonly<{
  activeServerDir: string;
  targetStorageMode: 'persisted' | 'external-linked';
  sessionId: string;
  operationId: string;
  attemptId: string | undefined;
  message: string;
  nowMs: number;
}>;

/**
 * Marks a definitively rejected pre-commit takeover admission failed.
 *
 * The admission owner commits refreshed transcript/pending authority evidence
 * at `revision + 1` immediately before it sends the Server admission command.
 * A caller that then marks failure at the revision it read *before* preparation
 * CASes against a stale revision, so the operation stays `running`/`admitting`
 * with no live waiter and no child able to complete it — permanently stuck.
 *
 * This helper is the single owner of that transition for both takeover storage
 * modes: it rereads the exact `{ sessionId, operationId, attemptId }` record and
 * CASes whatever revision the admission owner left behind. It deliberately
 * refuses anything that is not still a pre-commit admitting attempt — a
 * post-commit `spawning` row, a completed row, or another attempt — because
 * those outcomes have their own owners and must not be overwritten as failed.
 */
export async function recoverExternalSessionTakeoverPrecommitAdmission(
  input: ExternalSessionTakeoverPrecommitAdmissionRecoveryInput,
): Promise<ExternalSessionOperationRecordV1 | null> {
  if (!input.attemptId) return null;
  const latest = await readExternalSessionOperationRecord(
    input.activeServerDir,
    input.operationId,
  ).catch(() => null);
  if (!isPrecommitAdmissionAttempt(latest, input)) return null;
  const failed = await mutateExternalSessionOperationRecordAtRevision(
    input.activeServerDir,
    latest.operationId,
    latest.revision,
    (fresh) => {
      if (!isPrecommitAdmissionAttempt(fresh, input)) {
        throw new Error(
          'external_session_takeover_precommit_admission_recovery_conflict',
        );
      }
      const {
        terminalResult: _terminalResult,
        cancellation: _cancellation,
        ...withoutTerminal
      } = fresh;
      const {
        acceptedThroughServerSeq: _acceptedThroughServerSeq,
        acknowledgedBatchId: _acknowledgedBatchId,
        ...persistedCheckpoint
      } = fresh.checkpoint;
      return {
        ...(input.targetStorageMode === 'external-linked'
          ? withoutTerminal
          : { ...fresh, checkpoint: persistedCheckpoint }),
        revision: fresh.revision + 1,
        status: 'failed',
        phase: 'admitting',
        updatedAtMs: input.nowMs,
        retryTargetPhase: 'admitting',
        error: {
          code: 'admission_failed',
          message: input.message,
          retryable: true,
          occurredAtMs: input.nowMs,
        },
      };
    },
  ).catch(() => null);
  return failed?.ok ? failed.record : null;
}

function isPrecommitAdmissionAttempt(
  record: ExternalSessionOperationRecordV1 | null,
  input: ExternalSessionTakeoverPrecommitAdmissionRecoveryInput,
): record is ExternalSessionOperationRecordV1 {
  return record !== null
    && record.request.plan === 'takeover'
    && record.request.targetStorageMode === input.targetStorageMode
    && record.request.sessionId === input.sessionId
    && record.operationId === input.operationId
    && record.bindings.targetRuntimeAttemptId === input.attemptId
    && record.status === 'running'
    && record.phase === 'admitting';
}
