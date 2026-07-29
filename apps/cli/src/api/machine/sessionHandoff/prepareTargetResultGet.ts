import {
  SessionHandoffPrepareTargetResultGetRequestSchema,
  type SessionHandoffStatus,
} from '@happier-dev/protocol';

import {
  createSessionHandoffPrepareTargetJobStore,
  type SessionHandoffPrepareTargetJobRecord,
} from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';

type SessionHandoffPrepareTargetJobStore = ReturnType<typeof createSessionHandoffPrepareTargetJobStore>;

export type RegisterSessionHandoffPrepareTargetResultGetRpcHandlerInput = Readonly<{
  prepareJobStore: SessionHandoffPrepareTargetJobStore;
  readPersistedPrepareJob: (params: Readonly<{
    handoffId: string;
    jobStore: SessionHandoffPrepareTargetJobStore;
  }>) => Promise<SessionHandoffPrepareTargetJobRecord | null>;
  isTerminalHandoffStatus: (status: SessionHandoffStatus) => boolean;
  invalidRequest: () => Readonly<{
    ok: false;
    errorCode: 'invalid_request';
  }>;
}>;

export function createSessionHandoffPrepareTargetResultGetActionHandler(
  params: RegisterSessionHandoffPrepareTargetResultGetRpcHandlerInput,
): (raw: unknown) => Promise<unknown> {
  const {
    prepareJobStore,
    readPersistedPrepareJob,
    isTerminalHandoffStatus,
    invalidRequest,
  } = params;

  return async (raw: unknown) => {
    const parsed = SessionHandoffPrepareTargetResultGetRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();

    const persistedJob = await readPersistedPrepareJob({
      handoffId: parsed.data.handoffId,
      jobStore: prepareJobStore,
    });
    if (persistedJob?.prepareTargetResult) {
      return persistedJob.prepareTargetResult;
    }
    if (persistedJob) {
      // Canonical contract: result-get returns the terminal ready payload. While the prepare
      // job is still running, callers should poll `status.get` for progress. If the job has
      // reached a terminal non-ready state (aborted/failed/awaiting_recovery), surface that
      // explicitly so callers don't spin forever on `not_found`.
      if (isTerminalHandoffStatus(persistedJob.status)) {
        if (persistedJob.lastErrorCode) {
          return {
            ok: false,
            errorCode: persistedJob.lastErrorCode,
            error: persistedJob.lastErrorMessage ?? 'Session handoff preparation failed',
          } as const;
        }
        if (persistedJob.status.failure) {
          return {
            ok: false,
            errorCode: persistedJob.status.failure.code,
            error: persistedJob.lastErrorMessage ?? 'Prepare-target native import failed',
          } as const;
        }
        const statusCode = persistedJob.status.status;
        // `ready_for_cutover` should always have a result payload, but fail closed if the record is corrupt.
        if (statusCode === 'ready_for_cutover') {
          return {
            ok: false,
            errorCode: 'awaiting_recovery',
            error: persistedJob.lastErrorMessage ?? 'Prepare-target result missing for ready_for_cutover job',
          } as const;
        }
        if (statusCode === 'completed') {
          return {
            ok: false,
            errorCode: 'awaiting_recovery',
            error: persistedJob.lastErrorMessage ?? 'Prepare-target job completed without a ready_for_cutover result',
          } as const;
        }
        return {
          ok: false,
          errorCode: statusCode,
          error: persistedJob.lastErrorMessage ?? `Prepare-target job is ${statusCode}`,
        } as const;
      }
    }
    return { ok: false, errorCode: 'not_found' } as const;
  };
}
