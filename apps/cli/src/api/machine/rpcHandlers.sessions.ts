import { registerSessionLifecycleRpcHandlers } from '@/rpc/handlers/sessionLifecycle';
import { MACHINE_SESSION_LIFECYCLE_RPC_SCOPES } from '@/rpc/handlers/actionSpecRpcRegistration';
import { createMachineSessionLifecycleActionExecutor } from '@/session/actions/sessionLifecycleActions';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { MachineRpcHandlerDeps, MachineRpcHandlers } from './rpcHandlers';

export function registerMachineSessionRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  handlers: MachineRpcHandlers;
  deps?: MachineRpcHandlerDeps;
}>): void {
  registerSessionLifecycleRpcHandlers({
    rpcHandlerManager: params.rpcHandlerManager,
    actionExecutor: createMachineSessionLifecycleActionExecutor({
      handlers: {
        spawnSession: params.handlers.spawnSession,
        stopSession: params.handlers.stopSession,
      },
      deps: {
        ...(params.deps?.runReplaySummaryForDialog
          ? { runReplaySummaryForDialog: params.deps.runReplaySummaryForDialog }
        : {}),
        ...(params.deps?.resolveExecutionSurfaces
          ? { resolveExecutionSurfaces: params.deps.resolveExecutionSurfaces }
          : {}),
        ...(params.deps?.awaitAgentSessionOpen
          ? { awaitAgentSessionOpen: params.deps.awaitAgentSessionOpen }
          : {}),
      },
    }),
    scopes: MACHINE_SESSION_LIFECYCLE_RPC_SCOPES,
  });
}
