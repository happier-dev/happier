import { describe, expect, it } from 'vitest';
import { SignedDirectRouteGrantV2Schema, type DirectRouteGrantRequestV2 } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
import { verifyPeerRouteEphemeralProofV2 } from '@happier-dev/protocol/machines/peer/mediation/ephemeralPeerRouteProofV2';
import { mintFiniteAccountClientTransferHandshake } from './finiteTransferHandshake.js';

describe('finite Account-client transfer admission', () => {
  it.each(['ready', 'retired', 'denied', 'wrong_target'] as const)('pins the signed target and real Account-client endpoint (%s)', async state => {
    const target = { endpointId: 'b'.repeat(64), directAddresses: ['127.0.0.1:46000'], relayUrls: [] };
    let granted = false;
    const pending = mintFiniteAccountClientTransferHandshake({ accountId: 'account-one', machineId: 'machine-one',
      readTargetEndpoint: async () => granted && state === 'retired' ? null : target,
      resolveInitiatorEndpointId: async () => 'a'.repeat(64), randomBytes: length => new Uint8Array(length).fill(4),
      requestGrant: async (request: DirectRouteGrantRequestV2) => {
        if (state === 'denied') throw new Error('permission_denied');
        const { kind, ttlMs: _ttlMs, ...binding } = request;
        granted = true;
        const admittedBinding = state === 'wrong_target' ? { ...binding, machineId: 'machine-other',
          iroh: { ...binding.iroh!, target: { ...binding.iroh!.target, machineId: 'machine-other' } } } : binding;
        return SignedDirectRouteGrantV2Schema.parse({ payload: { ...admittedBinding, grantId: 'grant-one', accountId: 'account-one',
          iat: 1000, exp: 301000, aud: 'happier-daemon-route-grant', proofKind: kind },
          signature: { alg: 'Ed25519', keyId: 'key-one', valueBase64Url: 'A'.repeat(86) } });
      },
    });
    if (state !== 'ready') { await expect(pending).rejects.toThrow(state === 'denied' ? 'permission_denied'
      : state === 'wrong_target' ? 'Finite transfer grant does not match' : 'Target Iroh endpoint changed'); return; }
    const result = await pending;
    expect(result.handshake).toMatchObject({ accountId: 'account-one', flow: 'finite_transfer',
      initiator: { kind: 'account_client', endpointId: 'a'.repeat(64) }, target: { machineId: 'machine-one', endpointId: target.endpointId } });
    expect(verifyPeerRouteEphemeralProofV2({ grant: result.handshake.grant, proof: result.handshake.proof })).toMatchObject({ valid: true });
    expect(result.endpoint).toEqual(target);
  });
});
