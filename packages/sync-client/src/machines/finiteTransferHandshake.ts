import { DIRECT_ROUTE_GRANT_TTL_MS } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import { DirectRouteGrantRequestV2Schema, SignedDirectRouteGrantV2Schema } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
import { createEphemeralPeerRouteProofHandleV2 } from '@happier-dev/protocol/machines/peer/mediation/ephemeralPeerRouteProofV2';
import { IrohMachineHandshakeV1Schema } from '@happier-dev/protocol/connectivity/iroh/machineHandshakeV1';
import type { IrohEndpointDescriptorV1 } from '@happier-dev/protocol';

/** One account-client grant/proof/target-pin owner for UI and headless finite senders. */
export async function mintFiniteAccountClientTransferHandshake(input: Readonly<{
  accountId: string;
  machineId: string;
  readTargetEndpoint: () => IrohEndpointDescriptorV1 | null | Promise<IrohEndpointDescriptorV1 | null>;
  resolveInitiatorEndpointId: (targetRelayUrls: readonly string[]) => Promise<string>;
  randomBytes: (length: number) => Uint8Array;
  requestGrant: (request: ReturnType<typeof DirectRouteGrantRequestV2Schema.parse>) => Promise<unknown>;
  signal?: AbortSignal;
}>) {
  input.signal?.throwIfAborted();
  const target = await input.readTargetEndpoint();
  if (!target) throw new Error('Target Iroh endpoint is unavailable');
  const initiatorEndpointId = await input.resolveInitiatorEndpointId(target.relayUrls ?? []);
  input.signal?.throwIfAborted();
  const proofHandle = createEphemeralPeerRouteProofHandleV2({ randomBytes: input.randomBytes });
  try {
    const request = DirectRouteGrantRequestV2Schema.parse({ v: 2, kind: 'ephemeral_ed25519',
      ephemeralPublicKeyBase64Url: proofHandle.publicKeyBase64Url, machineId: input.machineId,
      flowKind: 'bounded_transfer', routeKind: 'iroh_peer', endpointFingerprint: target.endpointId,
      ttlMs: DIRECT_ROUTE_GRANT_TTL_MS.finiteTransferCarrier, scope: { kind: 'bounded_transfer', mode: 'carrier' },
      iroh: { initiator: { kind: 'account_client', endpointId: initiatorEndpointId },
        target: { machineId: input.machineId, endpointId: target.endpointId }, operationKind: 'finite_transfer' } });
    const grant = SignedDirectRouteGrantV2Schema.parse(await input.requestGrant(request));
    input.signal?.throwIfAborted();
    const binding = grant.payload.iroh;
    if (grant.payload.accountId !== input.accountId || grant.payload.machineId !== input.machineId
        || grant.payload.routeKind !== 'iroh_peer' || grant.payload.flowKind !== 'bounded_transfer'
        || grant.payload.endpointFingerprint !== target.endpointId || grant.payload.scope.kind !== 'bounded_transfer'
        || grant.payload.scope.mode !== 'carrier' || grant.payload.ephemeralPublicKeyBase64Url !== proofHandle.publicKeyBase64Url
        || binding?.initiator.kind !== 'account_client' || binding.initiator.endpointId !== initiatorEndpointId
        || binding.target.machineId !== input.machineId || binding.target.endpointId !== target.endpointId || binding.operationKind !== 'finite_transfer') {
      throw new Error('Finite transfer grant does not match the admitted target');
    }
    const currentTarget = await input.readTargetEndpoint();
    if (!currentTarget || currentTarget.endpointId !== binding.target.endpointId) throw new Error('Target Iroh endpoint changed while authorizing transfer');
    const handshake = IrohMachineHandshakeV1Schema.parse({ v: 1, accountId: input.accountId,
      initiator: binding.initiator, target: binding.target, flow: 'finite_transfer', grant, proof: proofHandle.sign(grant) });
    return { handshake, endpoint: currentTarget };
  } finally { proofHandle.dispose(); }
}
