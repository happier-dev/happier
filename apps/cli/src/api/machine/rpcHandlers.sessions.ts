import {
  registerPrivateSpawnSessionRpcHandlers,
  registerSessionLifecycleRpcHandlers,
  registerSessionSpawnNewRpcHandlers,
} from '@/rpc/handlers/sessionLifecycle';
import { registerSessionAgentTransitionRpcHandlers } from '@/rpc/handlers/sessionAgentTransition';
import { registerMachineSessionServerStartRpcHandler } from '@/rpc/handlers/sessionServerStartMachineBinding';
import type { SessionSpawnDirectTargetTransport } from '@/session/actions/createCliActionDeps';
import { MACHINE_SESSION_LIFECYCLE_RPC_SCOPES } from '@/rpc/handlers/actionSpecRpcRegistration';
import {
  createMachineSessionLifecycleActionExecutor,
  createMachineSessionSpawnRpcHandler,
} from '@/session/actions/sessionLifecycleActions';
import { registerSessionCreationTargetPreparationRpc } from '@/session/creation/registerSessionCreationTargetPreparationRpc';
import { readStoredCredentials } from '@/persistence';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { RpcHandlerRegistrar } from '../rpc/types';
import type { MachineRpcHandlerDeps, MachineRpcHandlers } from './rpcHandlers';
import type { RegisterActionSpecRpcHandlersParams } from '@/rpc/handlers/registerActionSpecRpcHandlers';

export function registerMachineSessionRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager & RpcHandlerRegistrar;
  handlers: MachineRpcHandlers;
  deps?: MachineRpcHandlerDeps;
}>): Readonly<{
  sessionSpawnDirectTargetTransport?: SessionSpawnDirectTargetTransport;
}> {
  const spawnLifecycleHandler = createMachineSessionSpawnRpcHandler({
    handlers: { spawnSession: params.handlers.spawnSession },
  });
  registerSessionCreationTargetPreparationRpc({
    rpcHandlerManager: params.rpcHandlerManager,
  });
  registerPrivateSpawnSessionRpcHandlers({
    rpcHandlerManager: params.rpcHandlerManager,
    spawnLifecycleHandler,
    ...(params.handlers.resolveSpawnSessionByNonce
      ? { resolveSpawnSessionByNonce: params.handlers.resolveSpawnSessionByNonce }
      : {}),
    ...(params.handlers.sessionSpawnV1OutcomeRequired === true
      ? { requireSessionCreationOutcome: true }
      : {}),
  });
  const sessionSpawnDirectTargetTransport = params.deps?.sessionServerStart
    ? registerMachineSessionServerStartRpcHandler(params.rpcHandlerManager, {
      ...params.deps.sessionServerStart,
      spawnLifecycleHandler,
      ...(params.handlers.resolveSpawnSessionByNonce
        ? { resolveSpawnSessionByNonce: params.handlers.resolveSpawnSessionByNonce }
        : {}),
    })
    : undefined;
  registerSessionSpawnNewRpcHandlers({
    rpcHandlerManager: params.rpcHandlerManager,
    ...(params.deps?.actionOperations
      ? { observeExecution: params.deps.actionOperations.observeExecution }
      : {}),
  });
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
    ...(params.deps?.actionOperations
      ? { observeExecution: params.deps.actionOperations.observeExecution }
      : {}),
  });
  registerSessionAgentTransitionRpcHandlers(params.rpcHandlerManager, {
    readCredentials: readStoredCredentials,
    // Protected E2EE Session input can only be admitted through the
    // authenticated machine transport — the Account route cannot carry the
    // host-derived equality assertion — and the transition admits the user's
    // initiating message AFTER the source is stopped and the target current
    // view is committed. Without this the ordinary E2EE switch leaves the
    // Session on the target with the message unadmitted, so the transport this
    // daemon already owns for Session-start admission is threaded here too.
    ...(params.deps?.sessionServerStart?.machineAdmissionTransport
      ? { machineAdmissionTransport: params.deps.sessionServerStart.machineAdmissionTransport }
      : {}),
  });
  return sessionSpawnDirectTargetTransport
    ? { sessionSpawnDirectTargetTransport }
    : {};
}
