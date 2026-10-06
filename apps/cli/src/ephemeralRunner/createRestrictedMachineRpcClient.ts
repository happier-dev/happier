import {
  createManagedConnectionSupervisor,
  DEFAULT_MANAGED_CONNECTION_POLICY,
  type ManagedConnectionSupervisor,
  type ManagedConnectionSupervisorConfig,
  type ReadinessProbeResult,
} from '@happier-dev/connection-supervisor';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { resolveEphemeralRunnerMachineRpcAuthority } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol/actions/externalActionApi';
import { PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT } from '@happier-dev/protocol/machines/peer/mediation/tunnel/relay';
import type { MachineInstallationProofV1, IrohEndpointDescriptorV1, PeerTcpTunnelRelayEnvelope } from '@happier-dev/protocol';
import type { VerifiedEphemeralSessionRunnerPrincipal } from '@happier-dev/protocol/ephemeralRunner/principal';
import { classifyTransportErrorToProbeResult } from '@/api/connection/classifyTransportErrorToProbeResult';
import type { Socket } from 'socket.io-client';

import { createLoopbackHomeIdentityProbe } from '@/api/connection/createLoopbackReadinessProbe';
import { createMachineSocketTransport } from '@/api/machine/connection/createMachineSocketTransport';
import {
  CURRENT_SESSION_RUNTIME_OPERATION_PROTOCOL_CAPABILITIES_V1,
  publishMachineOperationProtocolCapabilitiesOnSocket,
} from '@/api/machine/publishMachineOperationProtocolCapabilities';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcHandlerRegistrar, RpcRequest } from '@/api/rpc/types';
import { resolveMachineSessionInputAdmissionCapability } from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';
import { fetchServerFeaturesSnapshot, type CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { registerMachinePeerTcpTunnelRelayRuntime } from '@/daemon/machine/registerMachinePeerTcpTunnelRelayRuntime';
import { logger } from '@/ui/logger';

import { createEphemeralRunnerRestrictedRpcAdmission } from './restrictedTransportAdmission';

type RestrictedTransport =
  | Readonly<{ encryptionMode: 'plain' }>
  | Readonly<{ encryptionMode: 'e2ee'; encryptionKey: Uint8Array; encryptionVariant: 'dataKey' }>;

type RestrictedMachineRpcClientDependencies = Readonly<{
  createSupervisor(configuration: ManagedConnectionSupervisorConfig): ManagedConnectionSupervisor;
  createTransport: typeof createMachineSocketTransport;
  probeReadiness(params: Readonly<{ serverUrl: string; expectedServerIdentityId: string }>): () => Promise<ReadinessProbeResult>;
  fetchFeatures: typeof fetchServerFeaturesSnapshot;
}>;

const productionDependencies: RestrictedMachineRpcClientDependencies = {
  createSupervisor: createManagedConnectionSupervisor,
  createTransport: createMachineSocketTransport,
  probeReadiness: createLoopbackHomeIdentityProbe,
  fetchFeatures: fetchServerFeaturesSnapshot,
};

/**
 * Restricted composition of the existing Machine transport and RPC receiver.
 * It deliberately cannot construct ApiMachineClient or register daemon-wide handlers.
 */
export function createRestrictedMachineRpcClient(input: Readonly<{
  principal: VerifiedEphemeralSessionRunnerPrincipal;
  homeServerIdentityId: string;
  runtimeOrigin: string;
  runtimeToken: string;
  /** Activation-local allowlist; ambient proxy/provider configuration is excluded. */
  transportEnvironment: NodeJS.ProcessEnv;
  /**
   * Session-lived native endpoint created by the existing Machine Iroh owner.
   * When present it is published in the same replace-all projection as the
   * Runner's Session capabilities; a second capability publisher would race
   * and withdraw one side of the projection.
   */
  irohEndpoint?: IrohEndpointDescriptorV1;
  installationProof: MachineInstallationProofV1;
  transport: RestrictedTransport;
  registerHandlers(rpc: RpcHandlerRegistrar): void;
  /** Terminal restricted-principal loss is handed to the ordinary Session Stop owner. */
  onTerminalConnectionFailure?: () => void;
  /**
   * This Machine's live transport connectivity, so a surface that presents the
   * running Session reflects the Session's own connection rather than the
   * activation connection it replaced.
   */
  onConnectionState?: (state: 'connected' | 'reconnecting') => void;
  dependencies?: RestrictedMachineRpcClientDependencies;
}>) {
  const dependencies = input.dependencies ?? productionDependencies;
  const admission = createEphemeralRunnerRestrictedRpcAdmission({
    principal: input.principal,
  });
  const rpc = new RpcHandlerManager({
    scopePrefix: input.principal.machineId,
    ...input.transport,
    authorizeRequest: admission.authorizeRpc,
  });
  // Publishing the protected-Action capability is what makes the Home dispatch
  // to this Machine, so it is derived from the actual registration rather than
  // asserted: a Runner that installed no dispatch receiver never advertises one.
  let externalActionDispatchInstalled = false;
  const registrar: RpcHandlerRegistrar = {
    registerHandler(method, handler) {
      if (resolveEphemeralRunnerMachineRpcAuthority(method) === null) {
        throw new Error(`runner_rpc_method_not_classified:${method}`);
      }
      if (method === EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1) externalActionDispatchInstalled = true;
      rpc.registerHandler(method, handler);
    },
  };
  input.registerHandlers(registrar);

  let activeSocket: Socket | null = null;
  let currentCapabilityPublication: Promise<void> = Promise.resolve();
  let capabilityPublicationQueueBusy = false;
  let desiredCapabilityPublicationGeneration = 0;
  let acknowledgedCapabilityPublicationGeneration = 0;
  let sessionFollowWakeReceiverCount = 0;
  const relayListeners = new Set<(payload: PeerTcpTunnelRelayEnvelope) => void | Promise<void>>();
  let relayRuntime: ReturnType<typeof registerMachinePeerTcpTunnelRelayRuntime> = null;
  let serverFeaturesSnapshot: CliServerFeaturesSnapshot | undefined;
  const buildCapabilities = () => ({
    ...CURRENT_SESSION_RUNTIME_OPERATION_PROTOCOL_CAPABILITIES_V1,
    ...(sessionFollowWakeReceiverCount > 0
      ? { sessionFollow: { contextV1: true as const, wakeOnHumanChangeV1: true as const } }
      : {}),
    // The target-admission leaf is negotiated by the daemon-wide owner from the
    // Home's feature snapshot, never asserted locally: a Runner must not advertise
    // a target route the connected Home cannot own.
    sessionInputAdmission: resolveMachineSessionInputAdmissionCapability(serverFeaturesSnapshot),
    // The production Runner connects this client only after its canonical
    // direct-transfer listener and Iroh acceptor are serving. This remains in
    // the single Machine capability projection rather than adding a Runner
    // publisher that could race the socket owner.
    finiteTransferRpc: { protocolVersions: [1] as const },
    ...(externalActionDispatchInstalled
      ? { externalActionExecutionAuthorization: { protocolVersions: [1] as const } }
      : {}),
    ...(input.irohEndpoint
      ? {
          irohMachineEndpoint: {
            protocolVersions: [1] as const,
            ...input.irohEndpoint,
          },
        }
      : {}),
  });
  const publishCurrentCapabilities = async (socket: Socket): Promise<void> => {
    await publishMachineOperationProtocolCapabilitiesOnSocket({
      socket,
      machineId: input.principal.machineId,
      capabilities: buildCapabilities(),
    });
  };
  const queueCurrentCapabilitiesPublication = (socket: Socket): Promise<void> => {
    desiredCapabilityPublicationGeneration += 1;
    const publish = async (): Promise<void> => {
      if (socket !== activeSocket || socket.connected !== true) return;
      const generation = desiredCapabilityPublicationGeneration;
      if (generation <= acknowledgedCapabilityPublicationGeneration) return;
      try {
        await publishCurrentCapabilities(socket);
      } catch (error) {
        // Match the ordinary Machine generation contract: rejection never
        // acknowledges the desired replace-all projection, so the next real
        // registration/reconnect trigger retries the latest desired state.
        logger.warn('[EPHEMERAL RUNNER] Failed to publish Machine operation protocol capabilities; the next receiver lifecycle event or reconnect will retry', {
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      if (socket === activeSocket && socket.connected === true) {
        acknowledgedCapabilityPublicationGeneration = generation;
      }
    };
    const nextPublication = capabilityPublicationQueueBusy
      ? currentCapabilityPublication.catch(() => undefined).then(publish)
      : publish();
    capabilityPublicationQueueBusy = true;
    const trackedPublication = nextPublication.finally(() => {
      if (currentCapabilityPublication === trackedPublication) {
        capabilityPublicationQueueBusy = false;
      }
    });
    currentCapabilityPublication = trackedPublication;
    return currentCapabilityPublication;
  };
  const queueCurrentCapabilitiesPublicationForActiveSocket = (): void => {
    const socket = activeSocket;
    if (!socket?.connected) return;
    void queueCurrentCapabilitiesPublication(socket).catch(() => undefined);
  };
  const supervisor = dependencies.createSupervisor({
    ...DEFAULT_MANAGED_CONNECTION_POLICY,
    createTransport: () => {
      const { socket, transport } = dependencies.createTransport({
        serverUrl: input.runtimeOrigin,
        token: input.runtimeToken,
        machineId: input.principal.machineId,
        runtimeId: input.principal.activationId,
        startupSource: 'ephemeral-runner',
        installationId: input.principal.installationId,
        installationPublicKey: input.principal.installationPublicKey,
        installationProof: input.installationProof,
        env: input.transportEnvironment,
      });
      activeSocket = socket;
      socket.on(SOCKET_RPC_EVENTS.REQUEST, async (request: RpcRequest, callback: (response: unknown) => void) => {
        if (socket !== activeSocket) return;
        const response = await rpc.handleRequest(request);
        if (socket === activeSocket) callback(response);
      });
      socket.on('disconnect', () => {
        if (socket !== activeSocket) return;
        rpc.onSocketDisconnect();
      });
      socket.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, (payload: PeerTcpTunnelRelayEnvelope) => {
        if (socket !== activeSocket) return;
        for (const listener of relayListeners) void listener(payload);
      });
      return transport;
    },
    probeReadiness: dependencies.probeReadiness({
      serverUrl: input.runtimeOrigin,
      expectedServerIdentityId: input.homeServerIdentityId,
    }),
    // Without this the supervisor reads every failed connect as unreachable, so
    // a Home that revoked this Runner's credential would leave it retrying with
    // a live child Agent instead of stopping.
    classifyTransportErrorToProbeResult,
    onStateChange: (state) => {
      input.onConnectionState?.(state.phase === 'online' ? 'connected' : 'reconnecting');
    },
    onConnected: () => {
      if (!activeSocket) return;
      rpc.onSocketConnect(activeSocket);
      // The server admits Pending input and Follow observation only after this
      // exact authenticated Machine publishes the runtime capabilities whose
      // handlers are already installed above. Repeat on every reconnect because
      // the persisted projection is replace-only and may have been withdrawn.
      currentCapabilityPublication = queueCurrentCapabilitiesPublication(activeSocket);
      // The connection supervisor intentionally does not await application
      // callbacks. Attach a rejection observer for reconnects; the explicit
      // initial `connect()` below still awaits and surfaces this same promise.
      void currentCapabilityPublication.catch(() => undefined);
    },
    onAuthFailed: () => {
      rpc.onSocketDisconnect();
      input.onTerminalConnectionFailure?.();
    },
  });

  return Object.freeze({
    rpc,
    installSessionFollowWakeReceiver: () => {
      sessionFollowWakeReceiverCount += 1;
      queueCurrentCapabilitiesPublicationForActiveSocket();
      let installed = true;
      return () => {
        if (!installed) return;
        installed = false;
        sessionFollowWakeReceiverCount = Math.max(0, sessionFollowWakeReceiverCount - 1);
        queueCurrentCapabilitiesPublicationForActiveSocket();
      };
    },
    connect: async (options: Readonly<{ signal?: AbortSignal }> = {}) => {
      const signal = options.signal;
      const awaitWhileCurrent = async <T>(operation: Promise<T>): Promise<T> => {
        if (!signal) return await operation;
        if (signal.aborted) {
          const error = new Error('Runner Machine startup was cancelled');
          error.name = 'AbortError';
          throw error;
        }
        return await new Promise<T>((resolve, reject) => {
          const onAbort = () => {
            const error = new Error('Runner Machine startup was cancelled');
            error.name = 'AbortError';
            reject(error);
          };
          signal.addEventListener('abort', onAbort, { once: true });
          void operation.then(
            (value) => {
              signal.removeEventListener('abort', onAbort);
              resolve(value);
            },
            (error: unknown) => {
              signal.removeEventListener('abort', onAbort);
              reject(error);
            },
          );
        });
      };
      try {
        if (!relayRuntime) {
          // Tunnel publication is an optional carrier owned by the shared Machine
          // runtime. A temporarily unavailable feature projection must not take the
          // restricted socket (and therefore files, previews, Follow and control)
          // down with it. The Home still fails tunnel admission closed because no
          // relay terminator is registered without a positive capability snapshot.
          const snapshot = await awaitWhileCurrent(dependencies.fetchFeatures({
            serverUrl: input.runtimeOrigin,
            token: input.runtimeToken,
            ...(signal ? { signal } : {}),
          }).catch(() => null));
          serverFeaturesSnapshot = snapshot ?? undefined;
          if (snapshot?.status === 'ready') {
            relayRuntime = registerMachinePeerTcpTunnelRelayRuntime({
              accountId: input.principal.accountId,
              machineId: input.principal.machineId,
              serverFeatures: snapshot.features,
              nowMs: () => Date.now(),
              eventPort: {
                subscribe: (listener) => {
                  relayListeners.add(listener);
                  return () => relayListeners.delete(listener);
                },
                emit: (payload) => activeSocket?.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, payload),
              },
            });
          }
        }
        await awaitWhileCurrent(supervisor.start());
        await awaitWhileCurrent(currentCapabilityPublication);
      } catch (error) {
        if (signal?.aborted) await supervisor.stop().catch(() => undefined);
        throw error;
      }
    },
    close: async () => {
      await supervisor.stop();
      activeSocket = null;
      rpc.onSocketDisconnect();
      await rpc.waitForIdle();
      await relayRuntime?.dispose();
      relayRuntime = null;
      relayListeners.clear();
    },
  });
}
