import { SessionCreationTargetPreparationRequestV1Schema, needsSessionCreationDirectoryApprovalPreflightV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';
import type { SessionCreationTargetPreparationResultV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createRpcCallError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';

import { prepareSessionCreationTarget } from './prepareSessionCreationTarget';

type PrepareSessionCreationTarget = typeof prepareSessionCreationTarget;

type TargetPreparationRpcInput = Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  prepare?: PrepareSessionCreationTarget;
}>;

function createPreparationHandler(input: TargetPreparationRpcInput, readOnly: boolean) {
  const prepare = input.prepare ?? prepareSessionCreationTarget;
  return async (rawRequest: unknown, context: RpcHandlerContext | undefined): Promise<SessionCreationTargetPreparationResultV1> => {
    if (!context) {
      throw new Error('Session creation target preparation requires an RPC cancellation context');
    }
    const request = SessionCreationTargetPreparationRequestV1Schema.parse(rawRequest);
    // This method is read-only for every caller. The original materializing
    // method keeps its custodian-only admission, including on older guests.
    if (readOnly && !needsSessionCreationDirectoryApprovalPreflightV1(request)) {
      throw createRpcCallError({ error: 'Directory preflight is read-only', errorCode: RPC_ERROR_CODES.FORBIDDEN });
    }
    return await prepare({ request, signal: context.signal });
  };
}

/** The native filesystem worker registers only the already-admitted read. */
export function registerSessionCreationDirectoryPreflightRpc(input: TargetPreparationRpcInput): void {
  input.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT,
    createPreparationHandler(input, true));
}

export function registerSessionCreationTargetPreparationRpc(input: TargetPreparationRpcInput & Readonly<{
  directoryPreflightRpcHandlerManager?: RpcHandlerRegistrar;
}>): void {
  input.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE,
    createPreparationHandler(input, false));
  registerSessionCreationDirectoryPreflightRpc({ ...input,
    rpcHandlerManager: input.directoryPreflightRpcHandlerManager ?? input.rpcHandlerManager });
}
