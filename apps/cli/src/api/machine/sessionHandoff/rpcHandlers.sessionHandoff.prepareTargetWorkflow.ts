import {
  type ResolvePrepareTargetBootstrapInput,
} from './rpcHandlers.sessionHandoff.prepareTargetBootstrap';
import {
  resolvePrepareTargetResponseFromRaw,
} from './rpcHandlers.sessionHandoff.prepareTargetRawWorkflow';
import { type SessionHandoffPrepareTargetResponse } from './rpcHandlers.sessionHandoff.prepareTargetResponseResolution';

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
