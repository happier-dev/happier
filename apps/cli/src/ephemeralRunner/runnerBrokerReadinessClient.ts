import { MACHINE_HTTP_LOCAL_CAPABILITY_HEADER } from '@happier-dev/iroh-native/node';
import { readHomeApplicationCarrierEligibilityFromEnv } from '@happier-dev/cli-common/homeEnrollment';
import { doesRunnerBrokerReadinessResponseMatchRequestV1, RunnerBrokerReadinessResponseV1Schema } from '@happier-dev/protocol/teams/credentials/readinessV1';
import type { RunnerBrokerReadinessRequestV1, TeamCredentialResourceReadinessV1 } from '@happier-dev/protocol/teams';
import type { IrohEndpointDescriptorV1 } from '@happier-dev/protocol';

import { createDaemonMachineIrohRuntime } from '@/daemon/peer/iroh/daemonMachineIrohRuntime';
import { MACHINE_CARRIER_ALPN_V1 } from '@/daemon/peer/iroh/machineCarrier';

type DaemonMachineIrohRuntime = Awaited<ReturnType<typeof createDaemonMachineIrohRuntime>>;
type ReadinessRuntime =
  | Pick<Extract<DaemonMachineIrohRuntime, { available: true }>, 'available' | 'endpoint' | 'openHttpTunnel' | 'shutdown'>
  | Pick<Extract<DaemonMachineIrohRuntime, { available: false }>, 'available' | 'shutdown'>;

/**
 * Executes the fixed content-free readiness application through the existing
 * machine/1 HTTP carrier. The attempt owns one temporary endpoint and tunnel;
 * both are closed on success, denial, transport failure, and cancellation.
 */
export async function checkRunnerBrokerNonInferenceReadiness(input: Readonly<{
  /**
   * Creates the signed, content-free application request only after the
   * carrier owner has created its exact process-local endpoint identity.
   * This keeps endpoint identity construction with the Iroh runtime instead
   * of requiring a caller to predict or separately create it.
   */
  createRequest: (initiatorEndpointId: string) => RunnerBrokerReadinessRequestV1;
  target: IrohEndpointDescriptorV1;
  happyHomeDir: string;
  signal: AbortSignal;
  createRuntime?: (input: Parameters<typeof createDaemonMachineIrohRuntime>[0]) => Promise<ReadinessRuntime>;
  fetchImpl?: typeof fetch;
}>): Promise<TeamCredentialResourceReadinessV1> {
  input.signal.throwIfAborted();
  if (readHomeApplicationCarrierEligibilityFromEnv(process.env) === 'standard_only') {
    return { kind: 'broker_unavailable' };
  }
  const createRuntime = input.createRuntime ?? createDaemonMachineIrohRuntime;
  const runtime = await createRuntime({
    happyHomeDir: input.happyHomeDir,
    relayConfig: { relayPolicy: 'automatic', relayUrls: [] },
  });
  let tunnel: Awaited<ReturnType<Extract<ReadinessRuntime, { available: true }>['openHttpTunnel']>> | null = null;
  try {
    if (!runtime.available) return { kind: 'broker_unavailable' };
    const request = input.createRequest(runtime.endpoint.endpointId);
    if (runtime.endpoint.endpointId !== request.initiator.endpointId) return { kind: 'broker_unavailable' };
    tunnel = await runtime.openHttpTunnel({
      alpn: MACHINE_CARRIER_ALPN_V1,
      remoteEndpointId: request.target.endpointId,
      flow: 'provider_broker_readiness',
      handshake: request,
    }, input.target);
    const response = await (input.fetchImpl ?? fetch)(`http://127.0.0.1:${tunnel.localPort}/readiness`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [MACHINE_HTTP_LOCAL_CAPABILITY_HEADER]: tunnel.localCapability,
        connection: 'close',
      },
      body: JSON.stringify(request),
      signal: input.signal,
      redirect: 'error',
    });
    if (!response.ok) {
      return response.status === 403 ? { kind: 'policy_denied' } : { kind: 'broker_unavailable' };
    }
    const checked = RunnerBrokerReadinessResponseV1Schema.safeParse(await response.json());
    if (!checked.success || !doesRunnerBrokerReadinessResponseMatchRequestV1(request, checked.data)) {
      return { kind: 'broker_unavailable' };
    }
    return checked.data.readiness;
  } finally {
    try {
      await tunnel?.close();
    } finally {
      await runtime.shutdown();
    }
  }
}
