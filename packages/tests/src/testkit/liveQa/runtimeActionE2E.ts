import {
  ExecutionRunActionResponseSchema,
  type ActionId,
  type ExecutionRunActionResponse,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { callLegacyEncryptedSessionRpc } from '../sessionRpc';
import type { SocketCollector } from '../socketClient';

export type DispatchRuntimeActionE2EContext = Readonly<{
  ui: SocketCollector;
  sessionId: string;
  runId: string;
  secret: Uint8Array;
  timeoutMs?: number;
}>;

export async function dispatchRuntimeActionE2E(
  context: DispatchRuntimeActionE2EContext,
  actionId: ActionId | string,
  input?: unknown,
): Promise<ExecutionRunActionResponse> {
  return callLegacyEncryptedSessionRpc({
    ui: context.ui,
    sessionId: context.sessionId,
    method: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
    req: {
      runId: context.runId,
      actionId,
      ...(input === undefined ? {} : { input }),
    },
    secret: context.secret,
    schema: ExecutionRunActionResponseSchema,
    timeoutMs: context.timeoutMs ?? 45_000,
  });
}
