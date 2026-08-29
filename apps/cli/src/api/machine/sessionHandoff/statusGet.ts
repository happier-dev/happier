import { SessionHandoffStatusGetRequestSchema, type SessionHandoffStatus } from '@happier-dev/protocol';

import {
  createSessionHandoffPrepareTargetJobStore,
  type SessionHandoffPrepareTargetJobRecord,
} from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { createSessionHandoffSourceExportStore } from '../../../session/handoff/state/sessionHandoffSourceExportStore';

type SessionHandoffPrepareTargetJobStore = ReturnType<typeof createSessionHandoffPrepareTargetJobStore>;
type SessionHandoffSourceExportStore = ReturnType<typeof createSessionHandoffSourceExportStore>;
export type RegisterSessionHandoffStatusGetRpcHandlerInput = Readonly<{
  prepareJobStore: SessionHandoffPrepareTargetJobStore;
  sourceExportStore: SessionHandoffSourceExportStore;
  readPersistedPrepareJob: (params: Readonly<{
    handoffId: string;
    jobStore: SessionHandoffPrepareTargetJobStore;
  }>) => Promise<SessionHandoffPrepareTargetJobRecord | null>;
  buildStartPendingStatus: (input: Readonly<{
    handoffId: string;
    sourceStopState: 'stopped' | 'already_inactive';
  }>) => SessionHandoffStatus;
  invalidRequest: () => Readonly<{
    ok: false;
    errorCode: 'invalid_request';
  }>;
}>;

export function createSessionHandoffStatusGetActionHandler(
  params: RegisterSessionHandoffStatusGetRpcHandlerInput,
): (raw: unknown) => Promise<unknown> {
  const {
    prepareJobStore,
    sourceExportStore,
    readPersistedPrepareJob,
    buildStartPendingStatus,
    invalidRequest,
  } = params;

  return async (raw: unknown) => {
    const parsed = SessionHandoffStatusGetRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();

    const persistedJob = await readPersistedPrepareJob({
      handoffId: parsed.data.handoffId,
      jobStore: prepareJobStore,
    });
    if (persistedJob) {
      const baseStatus = persistedJob.status;
      return {
        handoffId: parsed.data.handoffId,
        ...(persistedJob.schemaVersion === 2
          ? { transitionRevision: persistedJob.transitionRevision }
          : {}),
        status: {
          ...baseStatus,
          ...(baseStatus.progress ? { progress: baseStatus.progress } : {}),
        },
      };
    }
    const persistedSourceExport = await sourceExportStore.load(parsed.data.handoffId);
    if (persistedSourceExport) {
      return {
        handoffId: parsed.data.handoffId,
        status: buildStartPendingStatus({ handoffId: parsed.data.handoffId, sourceStopState: 'already_inactive' }),
      };
    }
    return { ok: false, errorCode: 'not_found' } as const;
  };
}
