import {
  registerPrivateSpawnSessionRpcHandlers,
  registerSessionLifecycleRpcHandlers,
  registerSessionSpawnNewRpcHandlers,
} from '@/rpc/handlers/sessionLifecycle';
import { registerSessionAgentTransitionRpcHandlers } from '@/rpc/handlers/sessionAgentTransition';
import { registerSessionWorkspaceReturnRpcHandlers } from '@/rpc/handlers/sessionWorkspaceReturn';
import { registerMachineSessionServerStartRpcHandler } from '@/rpc/handlers/sessionServerStartMachineBinding';
import type { SessionSpawnDirectTargetTransport, MachineActionDirectTargetTransport } from '@/session/actions/createCliActionDeps';
import { MACHINE_SESSION_LIFECYCLE_RPC_SCOPES } from '@/rpc/handlers/actionSpecRpcRegistration';
import {
  createMachineSessionLifecycleActionExecutor,
  createMachineSessionSpawnRpcHandler,
} from '@/session/actions/sessionLifecycleActions';
import { registerSessionCreationTargetPreparationRpc } from '@/session/creation/registerSessionCreationTargetPreparationRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readStoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readCurrentMachineInstallation } from '@/daemon/identity/currentMachineInstallation';
import { createSessionHandoffPrepareTargetJobStore } from '@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { RpcHandlerRegistrar } from '../rpc/types';
import type { MachineRpcHandlerDeps, MachineRpcHandlers } from './rpcHandlers';
import type { RegisterActionSpecRpcHandlersParams } from '@/rpc/handlers/registerActionSpecRpcHandlers';

/** What the new-Session family needs from the Machine's RPC composition (see `MachineRpcLifecycleRegistration`). */
export type MachineSessionRpcFamily = Readonly<{
  handlers: MachineRpcHandlers;
  deps?: MachineRpcHandlerDeps;
}>;

/**
 * The new-Session Machine RPC family: creation preparation, spawn, spawn-new, server start, fork,
 * continue-with-replay and continuation reads. Registered by the `sessions` Machine role.
 */
export function registerMachineSessionRpcHandlers(params: MachineSessionRpcFamily & Readonly<{
  rpcHandlerManager: RpcHandlerManager & RpcHandlerRegistrar;
}>): Readonly<{
  sessionSpawnDirectTargetTransport?: SessionSpawnDirectTargetTransport;
}> {
  const spawnLifecycleHandler = createMachineSessionSpawnRpcHandler({
    handlers: { spawnSession: params.handlers.spawnSession, stopSession: params.handlers.stopSession },
    ...(params.deps?.currentServerId ? { serverId: params.deps.currentServerId } : {}),
    ...(params.deps?.awaitAgentSessionOpen ? { awaitAgentSessionOpen: params.deps.awaitAgentSessionOpen } : {}),
  });
  const machineId = params.deps?.currentMachineId ?? params.deps?.sessionServerStart?.machineId;
  const machineActionDirectTargetTransport: MachineActionDirectTargetTransport | undefined = machineId ? {
    machineId,
    invoke: (method, request, options) => params.rpcHandlerManager.invokeLocal(method, request, options),
  } : undefined;
  const preparationTransport = {
    ...(machineActionDirectTargetTransport ? { machineActionDirectTargetTransport } : {}),
    ...(params.deps?.sessionCreationInstallation
      ? { sessionCreationInstallation: params.deps.sessionCreationInstallation } : {}),
  };
  registerSessionCreationTargetPreparationRpc({
    rpcHandlerManager: params.rpcHandlerManager,
    ...(params.deps?.filesystemEffectAdmission ? {
      directoryPreflightAdmission: params.deps.filesystemEffectAdmission,
    } : {}),
  });
  registerPrivateSpawnSessionRpcHandlers({
    rpcHandlerManager: params.rpcHandlerManager,
    spawnLifecycleHandler,
    handoffTargetResume: { prepareJobStore: createSessionHandoffPrepareTargetJobStore({ activeServerDir: configuration.activeServerDir }),
      ...(params.deps?.currentMachineId ? { machineId: params.deps.currentMachineId } : {}) },
    ...(params.deps?.requesterSessionRuntime ? { requesterSessionRuntime: params.deps.requesterSessionRuntime } : {}),
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
      ...preparationTransport,
      spawnLifecycleHandler,
      ...(params.handlers.resolveSpawnSessionByNonce
        ? { resolveSpawnSessionByNonce: params.handlers.resolveSpawnSessionByNonce }
        : {}),
    })
    : undefined;
  registerSessionSpawnNewRpcHandlers({
    rpcHandlerManager: params.rpcHandlerManager,
    ...(params.deps?.workspaceSync?.readRequesterWorkspaceScope ? {
      readRequesterWorkspaceScope: params.deps.workspaceSync.readRequesterWorkspaceScope,
    } : {}),
    ...preparationTransport,
    ...(params.deps?.currentServerId ? { requesterBootstrapBoundary: {
      serverId: params.deps.currentServerId, serverHttpBaseUrl: resolveServerHttpBaseUrl(),
      happyHomeDir: configuration.happyHomeDir, spawnLifecycleHandler,
      ...(params.deps?.sessionServerStart?.readMachineMetadataSnapshot ? {
        readMachineMetadataSnapshot: params.deps.sessionServerStart.readMachineMetadataSnapshot,
      } : {}),
      readInstallation: readCurrentMachineInstallation,
      getObservedServerIdentityId: () => {
        const snapshot = params.deps?.getServerFeaturesSnapshot?.();
        return snapshot?.status === 'ready' ? snapshot.features.capabilities.serverIdentity?.serverIdentityId ?? null : null;
      },
      ...(params.handlers.resolveSpawnSessionByNonce ? { resolveSpawnSessionByNonce: params.handlers.resolveSpawnSessionByNonce } : {}),
    } } : {}),
    ...(sessionSpawnDirectTargetTransport
      ? { sessionSpawnDirectTargetTransport }
      : {}),
    ...(params.deps?.actionOperations
      ? { observeExecution: params.deps.actionOperations.observeExecution }
      : {}),
  });
  registerSessionLifecycleRpcHandlers({
    rpcHandlerManager: params.rpcHandlerManager,
    ...(params.deps?.requesterSessionRuntime ? { requesterSessionRuntime: params.deps.requesterSessionRuntime } : {}),
    actionExecutor: createMachineSessionLifecycleActionExecutor({
      handlers: {
        spawnSession: params.handlers.spawnSession,
        stopSession: params.handlers.stopSession,
      },
      deps: {
        ...(params.deps?.currentMachineId ? { currentMachineId: params.deps.currentMachineId } : {}),
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
  });
  registerSessionWorkspaceReturnRpcHandlers(params.rpcHandlerManager, params.deps?.workspaceSync);
  // New Session is open on this Machine: the call is held while the intent lasts (its caller cancels
  // it when New Session closes or disconnects) and the daemon keeps its session host ready meanwhile.
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_CREATION_INTENT, async (_raw: unknown, context) => {
    if (!context) throw new Error('A New Session intent requires an RPC cancellation context');
    await params.deps?.prestartSessionHost?.(context.signal);
    return { ok: true };
  });
  return sessionSpawnDirectTargetTransport
    ? { sessionSpawnDirectTargetTransport }
    : {};
}
