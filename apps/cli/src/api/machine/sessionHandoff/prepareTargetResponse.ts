import {
  type SessionHandoffPrepareTargetRequest,
  type SessionHandoffPrepareTargetResultGetSuccessResponse,
  type SessionHandoffStatus,
} from '@happier-dev/protocol';

import {
  createSessionHandoffPrepareTargetJobStore,
  type SessionHandoffPrepareTargetJobRecord,
} from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { createSessionHandoffSourceExportStore } from '../../../session/handoff/state/sessionHandoffSourceExportStore';

import { missingHandoffMetadataV2 } from './prepareTargetState';

type SessionHandoffPrepareTargetJobStore = ReturnType<typeof createSessionHandoffPrepareTargetJobStore>;
type SessionHandoffSourceExportStore = ReturnType<typeof createSessionHandoffSourceExportStore>;

export type SessionHandoffPrepareTargetResponse = Readonly<{
  handoffId: string;
  status: SessionHandoffStatus;
}> | SessionHandoffPrepareTargetResultGetSuccessResponse;

export type SessionHandoffPrepareTargetErrorResponse = Readonly<{
  ok: false;
  errorCode: string;
  error?: string;
}>;

export async function resolvePrepareTargetDirectPeerMetadataPreflight(input: Readonly<{
  request: SessionHandoffPrepareTargetRequest;
  sourceExportStore: SessionHandoffSourceExportStore;
}>): Promise<SessionHandoffPrepareTargetErrorResponse | null> {
  if (
    input.request.stateTransfer === 'existing'
    || input.request.negotiatedTransportStrategy !== 'direct_peer'
    || input.request.handoffMetadataV2 !== undefined
  ) {
    return null;
  }

  const localSourceExport = await input.sourceExportStore.load(input.request.handoffId);
  const hasLocalAgentBundle = Boolean(localSourceExport?.agentBundle);

  if (!hasLocalAgentBundle) {
    return missingHandoffMetadataV2();
  }

  return null;
}

function resolvePrepareTargetResponseFromJobRecord(input: Readonly<{
  handoffId: string;
  job: SessionHandoffPrepareTargetJobRecord;
}>): SessionHandoffPrepareTargetResponse {
  if (input.job.prepareTargetResult) {
    return input.job.prepareTargetResult;
  }
  return {
    handoffId: input.handoffId,
    status: input.job.status,
  };
}

export async function resolvePrepareTargetResponse(input: Readonly<{
  handoffId: string;
  jobId: string;
  pendingStatus: SessionHandoffStatus;
  prepareJobStore: SessionHandoffPrepareTargetJobStore;
}>): Promise<SessionHandoffPrepareTargetResponse> {
  const job = await input.prepareJobStore.read(input.jobId);
  if (job) {
    return resolvePrepareTargetResponseFromJobRecord({
      handoffId: input.handoffId,
      job,
    });
  }

  return {
    handoffId: input.handoffId,
    status: input.pendingStatus,
  };
}
