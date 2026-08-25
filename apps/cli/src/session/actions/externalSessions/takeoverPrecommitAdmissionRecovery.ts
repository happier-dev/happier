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
  operationClaimId: string | undefined;
  message: string;
  nowMs: number;
}>;

/**
 * The outcome of one pre-commit takeover admission recovery.
 *
 * The distinction is load-bearing: leaving an operation at `running`/`admitting`
 * after its waiter is cancelled and its claim released strands it permanently,
 * so only proof that the exact attempt left that state may be reported as an
 * outcome. `unresolved` means this call could neither read the record nor
 * commit the transition, and the operation may still be stranded.
 */
export type ExternalSessionTakeoverPrecommitAdmissionRecovery =
  | Readonly<{
      status: 'recovered';
      record: ExternalSessionOperationRecordV1;
    }>
  | Readonly<{
      status: 'already_settled';
      record: ExternalSessionOperationRecordV1;
    }>
  | Readonly<{ status: 'unresolved' }>;

const UNRESOLVED_RECOVERY = Object.freeze({
  status: 'unresolved' as const,
});

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
 * modes: it rereads the exact
 * `{ sessionId, operationId, attemptId, operationClaimId }` record and CASes
 * whatever revision the admission owner left behind. It deliberately
 * refuses anything that is not still a pre-commit admitting attempt — a
 * post-commit `spawning` row, a completed row, or another attempt — because
 * those outcomes have their own owners and must not be overwritten as failed;
 * that observation is `already_settled` and carries the record it verified.
 */
export async function recoverExternalSessionTakeoverPrecommitAdmission(
  input: ExternalSessionTakeoverPrecommitAdmissionRecoveryInput,
): Promise<ExternalSessionTakeoverPrecommitAdmissionRecovery> {
  if (!input.attemptId || !input.operationClaimId) return UNRESOLVED_RECOVERY;
  const latest = await readExternalSessionOperationRecord(
    input.activeServerDir,
    input.operationId,
  ).catch(() => null);
  if (!latest) return UNRESOLVED_RECOVERY;
  if (!isPrecommitAdmissionAttempt(latest, input)) {
    return { status: 'already_settled', record: latest };
  }
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
  return failed?.ok
    ? { status: 'recovered', record: failed.record }
    : UNRESOLVED_RECOVERY;
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
    && record.bindings.operationClaimId === input.operationClaimId
    && record.status === 'running'
    && record.phase === 'admitting';
}
