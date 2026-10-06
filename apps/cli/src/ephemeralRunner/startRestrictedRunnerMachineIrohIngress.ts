import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import { resolveEphemeralRunnerMachineRpcAuthority } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import {
  type FeaturesResponse,
} from '@happier-dev/protocol';

import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { DaemonMachineIrohRuntime } from '@/daemon/peer/iroh/daemonMachineIrohRuntime';
import {
  startPeerMediationLoopback,
  type StartPeerMediationLoopbackInput,
} from '@/daemon/peer/mediation/rpc/startLoopback';

type StartLoopback = (input: StartPeerMediationLoopbackInput) => ReturnType<typeof startPeerMediationLoopback>;

/**
 * Starts the existing classified peer-mediation ingress before the Runner
 * advertises its Iroh endpoint. The Machine-service registrar remains only a
 * handler installer; Protocol classification is the sole operation authority
 * for both socket and direct invocation.
 */
export async function startRestrictedRunnerMachineIrohIngress(input: Readonly<{
  accountId: string;
  machineId: string;
  serverFeatures: FeaturesResponse;
  runtime: Readonly<{
    endpoint: Readonly<{ endpointId: string }>;
    startAttemptAcceptor: DaemonMachineIrohRuntime['startAttemptAcceptor'];
    stopActiveTunnels: DaemonMachineIrohRuntime['stopActiveTunnels'];
    stopAttemptAcceptor: DaemonMachineIrohRuntime['stopAttemptAcceptor'];
  }>;
  rpcHandlerManager: Pick<RpcHandlerManager, 'invokeLocal'>;
  ensureDirectTransferListening(): Promise<number>;
  startLoopback?: StartLoopback;
}>): Promise<Readonly<{ stop(): Promise<void> }>> {
  const startLoopback = input.startLoopback ?? startPeerMediationLoopback;
  let closing = false;
  const loopback = await startLoopback({
    accountId: input.accountId,
    machineId: input.machineId,
    serverFeatures: input.serverFeatures,
    rpcHandlerManager: {
      invokeLocal: async (method, params, options) => {
        if (closing || resolveEphemeralRunnerMachineRpcAuthority(method) === null) {
          return {
            error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND,
            errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
          };
        }
        return await input.rpcHandlerManager.invokeLocal(method, params, options);
      },
    },
    irohMachineAdmission: {
      localEndpointId: input.runtime.endpoint.endpointId,
      role: 'acceptor',
      allowedFlows: ['finite_transfer'],
      resolveApplicationTarget: async ({ handshake }) => !closing && handshake.flow === 'finite_transfer'
        ? { port: await input.ensureDirectTransferListening() }
        : null,
    },
  });
  if (!loopback) throw new Error('runner_machine_iroh_ingress_unavailable');

  let acceptorStarted = false;
  try {
    const admissionPort = Number(new URL(loopback.endpoint.url).port);
    if (!Number.isInteger(admissionPort) || admissionPort < 1 || admissionPort > 65_535) {
      throw new Error('runner_machine_iroh_admission_port_invalid');
    }
    await input.runtime.startAttemptAcceptor({ admissionPort });
    acceptorStarted = true;
  } catch (error) {
    closing = true;
    await input.runtime.stopActiveTunnels().catch(() => undefined);
    await input.runtime.stopAttemptAcceptor().catch(() => undefined);
    await loopback.stop().catch(() => undefined);
    throw error;
  }

  let stopped = false;
  return Object.freeze({
    stop: async () => {
      if (stopped) return;
      stopped = true;
      closing = true;
      try {
        await input.runtime.stopActiveTunnels();
      } finally {
        try {
          if (acceptorStarted) await input.runtime.stopAttemptAcceptor();
        } finally {
          await loopback.stop();
        }
      }
    },
  });
}
