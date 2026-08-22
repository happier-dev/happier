import {
  resumePersistedPrepareTarget as resumePersistedPrepareTargetBootstrap,
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
  ): Promise<void> => resumePersistedPrepareTargetBootstrap({
    ...params,
    record,
  });

  return {
    handlePrepareTargetRaw,
    resumePersistedPrepareTarget,
  };
}
