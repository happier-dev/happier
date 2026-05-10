import {
  type ActionExecuteResult,
  ExternalSessionTakeoverPersistRequestSchema as DirectSessionTakeoverPersistRequestSchema,
  ExternalSessionTakeoverRequestSchema as DirectSessionTakeoverRequestSchema,
  type ExternalSessionTakeoverPersistResponse as DirectSessionTakeoverPersistResponse,
  type ExternalSessionTakeoverResponse as DirectSessionTakeoverResponse,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  mapExternalSessionsTakeoverPersistToExternalSessionTakeoverInputV1 as mapDirectSessionsTakeoverPersistToExternalSessionTakeoverInputV1,
  mapExternalSessionsTakeoverToExternalSessionTakeoverInputV1 as mapDirectSessionsTakeoverToExternalSessionTakeoverInputV1,
} from '@happier-dev/protocol/sessions';

import {
  externalSessionsError as directSessionsError,
  mapActionFailureToExternalSessionsError as mapActionFailureToDirectSessionsError,
  mapExternalTakeoverResultToDirectTakeoverPersistResponse,
  mapExternalTakeoverResultToDirectTakeoverResponse,
  type ExternalSessionTakeoverActionInput,
} from '@/session/actions/externalSessions';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';

export type LegacyDirectSessionTakeoverDispatcher = (
  actionInput: ExternalSessionTakeoverActionInput,
) => Promise<ActionExecuteResult>;

export function registerLegacyDirectSessionTakeoverWireAliases(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  dispatchExternalSessionTakeoverAction: LegacyDirectSessionTakeoverDispatcher;
}>): void {
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY, async (raw: unknown) => {
    const parsed = DirectSessionTakeoverRequestSchema.safeParse(raw);
    if (!parsed.success) return directSessionsError('invalid_request') satisfies DirectSessionTakeoverResponse;
    const actionInput = {
      ...mapDirectSessionsTakeoverToExternalSessionTakeoverInputV1({
        linkedSessionId: parsed.data.sessionId,
        ...(parsed.data.forceStop === undefined ? {} : { forceStop: parsed.data.forceStop }),
      }),
      machineId: parsed.data.machineId,
    };
    const dispatched = await params.dispatchExternalSessionTakeoverAction(actionInput);
    if (!dispatched.ok) {
      return mapActionFailureToDirectSessionsError(dispatched) satisfies DirectSessionTakeoverResponse;
    }
    return mapExternalTakeoverResultToDirectTakeoverResponse(dispatched.result);
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_LEGACY, async (raw: unknown) => {
    const parsed = DirectSessionTakeoverPersistRequestSchema.safeParse(raw);
    if (!parsed.success) return directSessionsError('invalid_request') satisfies DirectSessionTakeoverPersistResponse;
    const actionInput = {
      ...mapDirectSessionsTakeoverPersistToExternalSessionTakeoverInputV1({
        linkedSessionId: parsed.data.sessionId,
        ...(parsed.data.forceStop === undefined ? {} : { forceStop: parsed.data.forceStop }),
      }),
      machineId: parsed.data.machineId,
    };
    const dispatched = await params.dispatchExternalSessionTakeoverAction(actionInput);
    if (!dispatched.ok) {
      return mapActionFailureToDirectSessionsError(dispatched) satisfies DirectSessionTakeoverPersistResponse;
    }
    return mapExternalTakeoverResultToDirectTakeoverPersistResponse(dispatched.result);
  });
}
