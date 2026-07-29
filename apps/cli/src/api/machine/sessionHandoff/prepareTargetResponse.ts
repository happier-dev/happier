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

import {
  missingHandoffMetadataV2,
  waitForPrepareJobFastPath,
} from './prepareTargetState';

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
    input.request.negotiatedTransportStrategy !== 'direct_peer'
    || input.request.handoffMetadataV2 !== undefined
  ) {
    return null;
  }

  const localSourceExport = await input.sourceExportStore.load(input.request.handoffId);
  const hasLocalAgentBundle = Boolean(localSourceExport?.agentBundle);
  const needsWorkspaceReplicationMetadata = input.request.workspaceTransfer?.enabled === true;
  const hasLocalWorkspaceReplicationMetadata = Boolean(
    localSourceExport?.workspaceManifest && localSourceExport.workspaceSourceRootPath,
  );

  if (!hasLocalAgentBundle || (needsWorkspaceReplicationMetadata && !hasLocalWorkspaceReplicationMetadata)) {
    return missingHandoffMetadataV2();
  }

  return null;
}

function resolvePrepareTargetResponseFromJobRecord(input: Readonly<{
  handoffId: string;
  job: SessionHandoffPrepareTargetJobRecord;
  pendingStatus: SessionHandoffStatus;
}>): SessionHandoffPrepareTargetResponse {
  if (input.job.prepareTargetResult) {
    return input.job.prepareTargetResult;
  }
  if (input.job.status.status === 'awaiting_recovery' && input.job.lastErrorMessage) {
    return {
      handoffId: input.handoffId,
      status: input.pendingStatus,
    };
  }
  return {
    handoffId: input.handoffId,
    status: input.job.status,
  };
}

export async function resolvePrepareTargetResponseAfterFastPath(input: Readonly<{
  handoffId: string;
  jobId: string;
  pendingStatus: SessionHandoffStatus;
  prepareJobStore: SessionHandoffPrepareTargetJobStore;
  runJob: Promise<void>;
}>): Promise<SessionHandoffPrepareTargetResponse> {
  const fastPathResult = await waitForPrepareJobFastPath(input.runJob);
  if (fastPathResult === 'completed') {
    const completedJob = await input.prepareJobStore.read(input.jobId);
    if (completedJob) {
      return resolvePrepareTargetResponseFromJobRecord({
        handoffId: input.handoffId,
        job: completedJob,
        pendingStatus: input.pendingStatus,
      });
    }
  }

  const timedOutJob = await input.prepareJobStore.read(input.jobId);
  if (timedOutJob && typeof timedOutJob.completedAtMs === 'number') {
    return resolvePrepareTargetResponseFromJobRecord({
      handoffId: input.handoffId,
      job: timedOutJob,
      pendingStatus: input.pendingStatus,
    });
  }

  return {
    handoffId: input.handoffId,
    status: input.pendingStatus,
  };
}
