import {
  type ResolvePrepareTargetBootstrapInput,
} from './prepareTargetBootstrap';
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
}>;

export function createSessionHandoffPrepareTargetWorkflow(
  params: CreateSessionHandoffPrepareTargetWorkflowInput,
): SessionHandoffPrepareTargetWorkflow {
  const handlePrepareTargetRaw = (raw: unknown) => resolvePrepareTargetResponseFromRaw({
    ...params,
    raw,
  });

  return {
    handlePrepareTargetRaw,
  };
}
