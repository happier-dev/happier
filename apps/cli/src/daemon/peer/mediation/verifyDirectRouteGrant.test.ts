import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';

import {
    createDirectRouteGrantSigningInputV2,
    createEphemeralPeerRouteProofHandleV2,
    type DirectRouteGrantPayloadV2,
} from '@happier-dev/protocol';

import { verifyDirectRouteGrantV2 } from './verifyDirectRouteGrant';

function toBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64url');
}

const signingSeed = new Uint8Array(32).fill(7);
const signingKeyPair = tweetnacl.sign.keyPair.fromSeed(signingSeed);
describe('verifyDirectRouteGrantV2', () => {
    function createV2GrantAndProof(overrides: Partial<DirectRouteGrantPayloadV2> = {}) {
        const handle = createEphemeralPeerRouteProofHandleV2({
            randomBytes: (length) => new Uint8Array(length).fill(length === 32 ? 5 : 6),
        });
        const payloadV2: DirectRouteGrantPayloadV2 = {
            v: 2,
            grantId: 'grant_v2',
            grantFamilyId: 'family_v2',
            accountId: 'account_1',
            machineId: 'machine_1',
            flowKind: 'machine_rpc',
            routeKind: 'loopback_direct',
            scope: {
                kind: 'machine_rpc',
                rpcScopeId: 'rpc_1',
                allowedMethods: ['daemon.memory.status'],
                maxIdleMs: 1_000,
            },
            iat: 1_000,
            exp: 61_000,
            aud: 'happier-daemon-route-grant',
            endpointFingerprint: 'endpoint_1',
            proofKind: 'ephemeral_ed25519',
            ephemeralPublicKeyBase64Url: handle.publicKeyBase64Url,
            ...overrides,
        };
        const grant = {
            payload: payloadV2,
            signature: {
                keyId: 'key_1',
                alg: 'Ed25519' as const,
                valueBase64Url: toBase64Url(tweetnacl.sign.detached(
                    Buffer.from(createDirectRouteGrantSigningInputV2(payloadV2), 'utf8'),
                    signingKeyPair.secretKey,
                )),
            },
        };
        return { grant, proof: handle.sign(grant) };
    }

    it('verifies server signature, complete binding, digest, nonce, and ephemeral possession', () => {
        const { grant, proof } = createV2GrantAndProof();
        expect(verifyDirectRouteGrantV2({
            grant,
            proof,
            trustRoots: [{ keyId: 'key_1', publicKey: toBase64Url(signingKeyPair.publicKey) }],
            nowMs: 2_000,
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                flowKind: 'machine_rpc',
                routeKind: 'loopback_direct',
                endpointFingerprint: 'endpoint_1',
            },
        })).toEqual(expect.objectContaining({ valid: true }));
    });

    it('requires the full signed Iroh relationship when V2 admits machine/1', () => {
        const sourceEndpointId = 'a'.repeat(64);
        const targetEndpointId = 'b'.repeat(64);
        const iroh = {
            initiator: {
                kind: 'account_client' as const,
                endpointId: sourceEndpointId,
            },
            target: {
                machineId: 'machine_target',
                endpointId: targetEndpointId,
            },
            operationKind: 'finite_transfer' as const,
        };
        const { grant, proof } = createV2GrantAndProof({
            machineId: iroh.target.machineId,
            flowKind: 'bounded_transfer',
            routeKind: 'iroh_peer',
            scope: { kind: 'bounded_transfer', mode: 'carrier' },
            endpointFingerprint: targetEndpointId,
            iroh,
        });
        const baseInput = {
            grant,
            proof,
            trustRoots: [{ keyId: 'key_1', publicKey: toBase64Url(signingKeyPair.publicKey) }],
            nowMs: 2_000,
        } as const;

        expect(verifyDirectRouteGrantV2({
            ...baseInput,
            expected: {
                accountId: 'account_1',
                machineId: iroh.target.machineId,
                flowKind: 'bounded_transfer',
                routeKind: 'iroh_peer',
                endpointFingerprint: targetEndpointId,
                iroh,
            },
        })).toEqual(expect.objectContaining({ valid: true }));
        expect(verifyDirectRouteGrantV2({
            ...baseInput,
            expected: {
                accountId: 'account_1',
                machineId: iroh.target.machineId,
                flowKind: 'bounded_transfer',
                routeKind: 'iroh_peer',
                endpointFingerprint: targetEndpointId,
            },
        })).toEqual({ valid: false, reasonCode: 'grant_iroh_binding_mismatch' });

        expect(verifyDirectRouteGrantV2({
            ...baseInput,
            expected: {
                accountId: 'account_1',
                machineId: iroh.target.machineId,
                flowKind: 'bounded_transfer',
                routeKind: 'iroh_peer',
                endpointFingerprint: 'c'.repeat(64),
                iroh: {
                    ...iroh,
                    target: { ...iroh.target, endpointId: 'c'.repeat(64) },
                },
            },
        })).toEqual({ valid: false, reasonCode: 'grant_endpoint_mismatch' });
    });

    it('rejects a V2 machine grant after its signing trust root expires', () => {
        const { grant, proof } = createV2GrantAndProof();
        expect(verifyDirectRouteGrantV2({
            grant,
            proof,
            trustRoots: [{
                keyId: 'key_1',
                publicKey: toBase64Url(signingKeyPair.publicKey),
                expiresAt: 2_000,
            }],
            nowMs: 2_000,
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                flowKind: 'machine_rpc',
                routeKind: 'loopback_direct',
                endpointFingerprint: 'endpoint_1',
            },
        })).toEqual({ valid: false, reasonCode: 'grant_unknown_key' });
    });

    it.each([
        ['accountId', 'other-account', 'grant_account_mismatch'],
        ['machineId', 'other-machine', 'grant_machine_mismatch'],
        ['flowKind', 'live_stream', 'grant_flow_mismatch'],
        ['routeKind', 'lan_direct', 'grant_route_mismatch'],
        ['endpointFingerprint', 'other-endpoint', 'grant_endpoint_mismatch'],
    ] as const)('rejects an altered %s binding before admission', (field, value, reasonCode) => {
        const { grant, proof } = createV2GrantAndProof();
        expect(verifyDirectRouteGrantV2({
            grant,
            proof,
            trustRoots: [{ keyId: 'key_1', publicKey: toBase64Url(signingKeyPair.publicKey) }],
            nowMs: 2_000,
            expected: {
                accountId: field === 'accountId' ? value : 'account_1',
                machineId: field === 'machineId' ? value : 'machine_1',
                flowKind: field === 'flowKind' ? value : 'machine_rpc',
                routeKind: field === 'routeKind' ? value : 'loopback_direct',
                endpointFingerprint: field === 'endpointFingerprint' ? value : 'endpoint_1',
            },
        })).toEqual({ valid: false, reasonCode });
    });

    it('rejects proof reuse against another signed grant digest', () => {
        const { grant, proof } = createV2GrantAndProof();
        const alteredGrant = {
            ...grant,
            signature: { ...grant.signature, keyId: 'other-key' },
        };
        expect(verifyDirectRouteGrantV2({
            grant: alteredGrant,
            proof,
            trustRoots: [{ keyId: 'other-key', publicKey: toBase64Url(signingKeyPair.publicKey) }],
            nowMs: 2_000,
            expected: {
                accountId: 'account_1', machineId: 'machine_1', flowKind: 'machine_rpc',
                routeKind: 'loopback_direct', endpointFingerprint: 'endpoint_1',
            },
        })).toEqual({ valid: false, reasonCode: 'proof_grant_digest_mismatch' });
    });
});
