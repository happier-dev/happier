import {
  SessionCreationTargetPreparationRequestV1Schema,
  type SessionCreationTargetPreparationResultV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';

import { prepareSessionCreationTarget } from './prepareSessionCreationTarget';

type PrepareSessionCreationTarget = typeof prepareSessionCreationTarget;

export function registerSessionCreationTargetPreparationRpc(input: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  prepare?: PrepareSessionCreationTarget;
}>): void {
  const prepare = input.prepare ?? prepareSessionCreationTarget;
  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE,
    async (rawRequest, context): Promise<SessionCreationTargetPreparationResultV1> => {
      if (!context) {
        throw new Error('Session creation target preparation requires an RPC cancellation context');
      }
      return await prepare({
        request: SessionCreationTargetPreparationRequestV1Schema.parse(rawRequest),
        signal: context.signal,
      });
    },
  );
}
