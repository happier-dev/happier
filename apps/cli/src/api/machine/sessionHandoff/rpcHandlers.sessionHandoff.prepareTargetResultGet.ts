import {
  SessionHandoffPrepareTargetResultGetRequestSchema,
  type SessionHandoffStatus,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
  createSessionHandoffPrepareTargetJobStore,
  type SessionHandoffPrepareTargetJobRecord,
} from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';

import type { RpcHandlerManager } from '../../rpc/RpcHandlerManager';

type SessionHandoffPrepareTargetJobStore = ReturnType<typeof createSessionHandoffPrepareTargetJobStore>;

export type RegisterSessionHandoffPrepareTargetResultGetRpcHandlerInput = Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  prepareJobStore: SessionHandoffPrepareTargetJobStore;
  readPersistedPrepareJob: (params: Readonly<{
    handoffId: string;
    jobStore: SessionHandoffPrepareTargetJobStore;
  }>) => Promise<SessionHandoffPrepareTargetJobRecord | null>;
  maybeRecoverPrepareTargetJobMissingRunner: (
    job: SessionHandoffPrepareTargetJobRecord,
  ) => Promise<SessionHandoffPrepareTargetJobRecord>;
  isTerminalHandoffStatus: (status: SessionHandoffStatus) => boolean;
  invalidRequest: () => Readonly<{
    ok: false;
    errorCode: 'invalid_request';
  }>;
}>;

export function registerSessionHandoffPrepareTargetResultGetRpcHandler(
  params: RegisterSessionHandoffPrepareTargetResultGetRpcHandlerInput,
): void {
  const {
    rpcHandlerManager,
    prepareJobStore,
    readPersistedPrepareJob,
    maybeRecoverPrepareTargetJobMissingRunner,
    isTerminalHandoffStatus,
    invalidRequest,
  } = params;

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET, async (raw: unknown) => {
    const parsed = SessionHandoffPrepareTargetResultGetRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();

    let persistedJob = await readPersistedPrepareJob({
      handoffId: parsed.data.handoffId,
      jobStore: prepareJobStore,
    });
    if (persistedJob) {
      persistedJob = await maybeRecoverPrepareTargetJobMissingRunner(persistedJob);
    }
    if (persistedJob?.prepareTargetResult) {
      return persistedJob.prepareTargetResult;
    }
    if (persistedJob) {
      // Canonical contract: result-get returns the terminal ready payload. While the prepare
      // job is still running, callers should poll `status.get` for progress. If the job has
      // reached a terminal non-ready state (aborted/failed/awaiting_recovery), surface that
      // explicitly so callers don't spin forever on `not_found`.
      if (isTerminalHandoffStatus(persistedJob.status)) {
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
  });
}
