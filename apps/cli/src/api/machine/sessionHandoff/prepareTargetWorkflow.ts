import {
  resolvePrepareTargetBootstrap,
  type ResolvePrepareTargetBootstrapInput,
} from './prepareTargetBootstrap';
import type { SessionHandoffPrepareTargetJobRecordV2 } from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import {
  resolvePrepareTargetResponseFromRaw,
} from './prepareTargetRawWorkflow';
import { type SessionHandoffPrepareTargetResponse } from './prepareTargetResponse';

export type CreateSessionHandoffPrepareTargetWorkflowInput = Omit<ResolvePrepareTargetBootstrapInput, 'request'>;

export type SessionHandoffPrepareTargetWorkflow = Readonly<{
  handlePrepareTargetRaw: (raw: unknown) => Promise<
    | SessionHandoffPrepareTargetResponse
    | Readonly<{ ok: false; errorCode: string; error?: string }>
  >;
  resumePersistedPrepareTarget: (
    record: SessionHandoffPrepareTargetJobRecordV2,
  ) => Promise<void>;
}>;

export function createSessionHandoffPrepareTargetWorkflow(
  params: CreateSessionHandoffPrepareTargetWorkflowInput,
): SessionHandoffPrepareTargetWorkflow {
  const handlePrepareTargetRaw = (raw: unknown) => resolvePrepareTargetResponseFromRaw({
    ...params,
    raw,
  });
  const resumePersistedPrepareTarget = async (
    record: SessionHandoffPrepareTargetJobRecordV2,
  ): Promise<void> => {
    if (!record.prepareTargetRequest) {
      throw new Error('Interrupted prepare-target job has no persisted request');
    }
    if (record.prepareTargetRequest.handoffId !== record.handoffId) {
      throw new Error('Interrupted prepare-target job identity disagrees with its persisted request');
    }
    await resolvePrepareTargetBootstrap({
      ...params,
      request: record.prepareTargetRequest,
      acceptedResumeJobId: record.jobId,
    });
  };

  return {
    handlePrepareTargetRaw,
    resumePersistedPrepareTarget,
  };
}
