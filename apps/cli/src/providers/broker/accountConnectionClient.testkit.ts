import tweetnacl from 'tweetnacl';
import { createProviderBrokerRouteGrantSigningInputV2, type ProviderBrokerAccountOpenResponseV2 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { createProviderBrokerMachineCarrierTunnelOpen } from '@/daemon/peer/iroh/providerBrokerMachineCarrierTunnelOpen';
import { createNativeRuntimeAbsentProviderBrokerError } from '@/daemon/startup/prepareDaemonMachineIrohRuntime';
import { openAccountConnectionProviderBrokerAccess, type OpenAccountConnectionProviderBrokerAccess } from './accountConnectionClient';

export const brokerOpenFailureCases = ['broker_open_refused', 'binding_invalid', 'tunnel_open_failed',
  'endpoint_discovery_failed', 'consumer_binding_invalid', 'native_runtime_absent'] as const;

/** Replace Home issuance/admission, native I/O and HTTP, retaining the real consumer/carrier/verifier. */
export async function openRefusedAccountConnectionBroker(
  request: Parameters<OpenAccountConnectionProviderBrokerAccess>[0], reason: typeof brokerOpenFailureCases[number],
) {
  if (reason === 'native_runtime_absent') throw createNativeRuntimeAbsentProviderBrokerError(request);
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
  const payload = { v: 2, grantId: 'grant', aud: 'happier-provider-broker-route-v2', issuedAt: 100, expiresAt: 200,
    homeId: 'home', accountId: 'account', initiatorTokenEpoch: 0,
    source: { kind: 'account_connection', connectionId: request.connectionId,
      expectedConnectionSecurityFingerprint: request.expectedConnectionSecurityFingerprint,
      expectedManagedRuntimeBindingFingerprint: request.expectedManagedRuntimeBindingFingerprint },
    initiator: { accountId: 'account', machineId: 'peer-worker', endpointId: 'a'.repeat(64) },
    target: { custodianAccountId: 'account', machineId: request.targetMachineId, endpointId: 'b'.repeat(64) },
    consumer: request.consumer, application: request.application } as const;
  const opened: Extract<ProviderBrokerAccountOpenResponseV2, { ok: true }> = {
    ok: true, authority: { payload, signature: { alg: 'Ed25519', keyId: 'home',
      valueBase64Url: Buffer.from(tweetnacl.sign.detached(Buffer.from(createProviderBrokerRouteGrantSigningInputV2(payload)), key.secretKey)).toString('base64url') } },
    target: { custodianAccountId: 'account', brokerMachineId: request.targetMachineId, endpointId: 'b'.repeat(64),
      endpointRevision: 1, endpoint: { endpointId: 'b'.repeat(64) } },
  };
  const openTunnel = createProviderBrokerMachineCarrierTunnelOpen({ homeId: 'home', accountId: 'account', localMachineId: 'peer-worker',
    runtime: { endpoint: { endpointId: 'a'.repeat(64) }, openHttpTunnel: async () => {
      if (reason === 'tunnel_open_failed') throw new Error('private-native-error?token=do-not-log');
      return { localPort: 43123, localCapability: 'c'.repeat(64), observedPath: 'unknown', remoteEndpointId: 'b'.repeat(64), close: async () => {} };
    } }, resolveTrustRoots: () => [{ keyId: 'home', publicKey: Buffer.from(key.publicKey).toString('base64url') }], nowMs: () => 150,
    fetchImpl: async () => new Response(null, { status: 204 }) });
  return await openAccountConnectionProviderBrokerAccess({ ...request, homeId: 'home', accountId: 'account', initiatorMachineId: 'peer-worker',
    ...(reason === 'consumer_binding_invalid' ? { executionRunOccurrenceId: 'unexpected-session-occurrence' } : {}),
    targetMachineId: reason === 'binding_invalid' ? 'wrong-target' : request.targetMachineId,
    openBroker: async () => reason === 'broker_open_refused' ? { ok: false, reasonCode: 'broker_unavailable' } : opened,
    openTunnel,
    fetchImpl: async () => new Response(null, { status: 403 }) });
}
