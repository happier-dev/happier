import {
  SessionHandoffPrepareTargetResumeRequestSchema,
  type SessionHandoffPrepareTargetResumeErrorCode,
  type SessionHandoffPrepareTargetResumeResponse,
} from '@happier-dev/protocol';

import {
  createSessionHandoffPrepareTargetJobStore,
  type SessionHandoffPrepareTargetJobRecordV2,
} from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';

type SessionHandoffPrepareTargetJobStore = ReturnType<typeof createSessionHandoffPrepareTargetJobStore>;

const ERROR_MESSAGES: Readonly<Record<SessionHandoffPrepareTargetResumeErrorCode, string>> = {
  invalid_request: 'Invalid interrupted handoff Resume request.',
  not_found: 'The interrupted handoff prepare-target job was not found.',
  identity_conflict: 'The handoff and prepare-target job identities do not match.',
  stale_revision: 'The interrupted handoff changed before Resume was accepted.',
  attempt_conflict: 'A different Resume attempt already owns this interrupted handoff transition.',
  invalid_state: 'The handoff prepare-target job is not awaiting explicit Resume.',
  reconciliation_required: 'The durable handoff records disagree and require reconciliation.',
  internal_error: 'The interrupted handoff could not be resumed.',
};

export function createSessionHandoffPrepareTargetResumeActionHandler(params: Readonly<{
  prepareJobStore: SessionHandoffPrepareTargetJobStore;
  resumePersistedPrepareTarget: (record: SessionHandoffPrepareTargetJobRecordV2) => Promise<void>;
  nowMs?: () => number;
}>): (raw: unknown) => Promise<SessionHandoffPrepareTargetResumeResponse> {
  const activeAttempts = new Map<string, Promise<void>>();
  const nowMs = params.nowMs ?? Date.now;

  return async (raw: unknown): Promise<SessionHandoffPrepareTargetResumeResponse> => {
    const parsed = SessionHandoffPrepareTargetResumeRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: 'invalid_request',
          message: ERROR_MESSAGES.invalid_request,
        },
      };
    }

    const accepted = await params.prepareJobStore.acceptPrepareTargetResume({
      ...parsed.data,
      nowMs: nowMs(),
    }).catch(() => null);
    if (!accepted) {
      return {
        ok: false,
        error: {
          code: 'internal_error',
          message: ERROR_MESSAGES.internal_error,
        },
      };
    }
    if (!accepted.ok) {
      return {
        ok: false,
        error: {
          code: accepted.errorCode,
          message: ERROR_MESSAGES[accepted.errorCode],
        },
      };
    }

    const attemptKey = `${accepted.record.jobId}\u0000${parsed.data.attemptId}`;
    if (!activeAttempts.has(attemptKey)) {
      const continuation = params.resumePersistedPrepareTarget(accepted.record)
        .catch(() => undefined)
        .finally(() => {
          if (activeAttempts.get(attemptKey) === continuation) {
            activeAttempts.delete(attemptKey);
          }
        });
      activeAttempts.set(attemptKey, continuation);
    }

    return {
      ok: true,
      handoffId: accepted.record.handoffId,
      jobId: accepted.record.jobId,
      transitionRevision: accepted.record.transitionRevision,
      status: accepted.record.status,
    };
  };
}
