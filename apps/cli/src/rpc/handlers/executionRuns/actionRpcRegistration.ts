import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcActionExecutor } from '../_actionDispatchAdapter';
import { EXECUTION_RUN_RPC_SCOPES } from '../actionSpecRpcRegistration';
import { registerActionSpecRpcHandlers } from '../registerActionSpecRpcHandlers';

export function invalidExecutionRunRpcParams(): Readonly<{ ok: false; error: string; errorCode: string }> {
  return { ok: false, error: 'Invalid params', errorCode: 'execution_run_invalid_action_input' };
}

/** Bind Run Actions and live host consent to their original Session authority. */
export function registerExecutionRunActionRpcHandlers(rpc: RpcHandlerRegistrar, params: Readonly<{
  executor: RpcActionExecutor;
  defaultSessionId: string | null;
  machineId?: string;
  serverId?: string;
  runtimeAccountId?: string;
}>): void {
  const actionExecutor: RpcActionExecutor = {
    execute: async (actionId, input, context) => {
      const defaultSessionId = context?.defaultSessionId ?? params.defaultSessionId;
      const result = await params.executor.execute(actionId, input, {
        ...context,
        ...(defaultSessionId ? { defaultSessionId } : {}),
        ...(params.machineId ? { defaultSessionMachineId: params.machineId } : {}),
        ...(params.serverId ? { serverId: params.serverId } : {}),
        ...(params.runtimeAccountId ? { runtimeAccountId: params.runtimeAccountId } : {}),
        sessionListAccess: defaultSessionId && params.runtimeAccountId ? 'current_session' : 'unavailable',
      });
      return !result.ok && result.errorCode === 'invalid_parameters'
        ? { ...result, ...invalidExecutionRunRpcParams() } : result;
    },
  };
  registerActionSpecRpcHandlers({ rpcHandlerManager: rpc, actionExecutor,
    scopes: [...EXECUTION_RUN_RPC_SCOPES,
      // Detached machine scopes already have the canonical approval registrar.
      ...(params.defaultSessionId ? [{ id: 'executionRun.approval', methods: [RPC_METHODS.APPROVAL_REQUEST_DECIDE] }] : []),
    ],
  });
}
