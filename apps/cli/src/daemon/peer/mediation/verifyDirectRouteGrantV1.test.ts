import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';

import {
    createDirectRouteGrantSigningInputV1,
    createDirectRouteGrantSigningInputV2,
    createEphemeralPeerRouteProofHandleV2,
    type DirectRouteGrantPayloadV1,
    type DirectRouteGrantPayloadV2,
} from '@happier-dev/protocol';

import {
    createPeerRouteNonceProofV1,
    resolvePeerRouteNonceSigningSeedFromCredentials,
    verifyDirectRouteGrantV1,
    verifyDirectRouteGrantV2,
    verifyPeerRouteNonceV1,
} from './verifyDirectRouteGrantV1';

function toBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64url');
}

const signingSeed = new Uint8Array(32).fill(7);
const signingKeyPair = tweetnacl.sign.keyPair.fromSeed(signingSeed);
const accountSeed = new Uint8Array(32).fill(9);
const accountKeyPair = tweetnacl.sign.keyPair.fromSeed(accountSeed);

const payload: DirectRouteGrantPayloadV1 = {
    v: 1,
    grantId: 'grant_1',
    grantFamilyId: 'family_1',
    accountId: 'account_1',
    machineId: 'machine_1',
    flowKind: 'bounded_transfer',
    routeKind: 'loopback_direct',
    scope: {
        kind: 'bounded_transfer',
        mode: 'single',
        transferId: 'transfer_1',
        maxBytes: 1024,
    },
    iat: 1_000,
    exp: 601_000,
    aud: 'happier-daemon-route-grant',
    endpointFingerprint: 'endpoint_1',
};

function createSignedGrant(overrides: Partial<DirectRouteGrantPayloadV1> = {}) {
    const nextPayload = { ...payload, ...overrides };
    const signingInput = Buffer.from(createDirectRouteGrantSigningInputV1(nextPayload), 'utf8');
    return {
        payload: nextPayload,
        signature: {
            keyId: 'key_1',
            alg: 'Ed25519',
            valueBase64Url: toBase64Url(tweetnacl.sign.detached(signingInput, signingKeyPair.secretKey)),
        },
    } as const;
}

describe('verifyDirectRouteGrantV1', () => {
    it('verifies signature, audience, expiry, endpoint, and expected route binding', () => {
        expect(verifyDirectRouteGrantV1({
            grant: createSignedGrant(),
            trustRoots: [{ keyId: 'key_1', publicKey: toBase64Url(signingKeyPair.publicKey) }],
            nowMs: 2_000,
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                flowKind: 'bounded_transfer',
                routeKind: 'loopback_direct',
                endpointFingerprint: 'endpoint_1',
            },
        })).toEqual(expect.objectContaining({
            valid: true,
        }));
    });

    it('rejects key, signature, expiry, audience, and endpoint mismatches with structured reasons', () => {
        expect(verifyDirectRouteGrantV1({
            grant: createSignedGrant(),
            trustRoots: [{ keyId: 'other_key', publicKey: toBase64Url(signingKeyPair.publicKey) }],
            nowMs: 2_000,
            expected: { accountId: 'account_1', machineId: 'machine_1', flowKind: 'bounded_transfer', routeKind: 'loopback_direct' },
        })).toEqual({ valid: false, reasonCode: 'grant_unknown_key' });

        expect(verifyDirectRouteGrantV1({
            grant: createSignedGrant({ exp: 2_000 }),
            trustRoots: [{ keyId: 'key_1', publicKey: toBase64Url(signingKeyPair.publicKey) }],
            nowMs: 2_001,
            expected: { accountId: 'account_1', machineId: 'machine_1', flowKind: 'bounded_transfer', routeKind: 'loopback_direct' },
        })).toEqual({ valid: false, reasonCode: 'grant_expired' });

        expect(verifyDirectRouteGrantV1({
            grant: createSignedGrant({ exp: 2_000 }),
            trustRoots: [{ keyId: 'key_1', publicKey: toBase64Url(signingKeyPair.publicKey) }],
            nowMs: 2_000,
            expected: { accountId: 'account_1', machineId: 'machine_1', flowKind: 'bounded_transfer', routeKind: 'loopback_direct' },
        })).toEqual({ valid: false, reasonCode: 'grant_expired' });

        expect(verifyDirectRouteGrantV1({
            grant: createSignedGrant({ endpointFingerprint: 'endpoint_2' }),
            trustRoots: [{ keyId: 'key_1', publicKey: toBase64Url(signingKeyPair.publicKey) }],
            nowMs: 2_000,
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                flowKind: 'bounded_transfer',
                routeKind: 'loopback_direct',
                endpointFingerprint: 'endpoint_1',
            },
        })).toEqual({ valid: false, reasonCode: 'grant_endpoint_mismatch' });
    });

    it('rejects revoked grant ids and grant families before expiry', () => {
        expect(verifyDirectRouteGrantV1({
            grant: createSignedGrant(),
            trustRoots: [{ keyId: 'key_1', publicKey: toBase64Url(signingKeyPair.publicKey) }],
            nowMs: 2_000,
            expected: { accountId: 'account_1', machineId: 'machine_1', flowKind: 'bounded_transfer', routeKind: 'loopback_direct' },
            revokedGrantIds: new Set(['grant_1']),
        })).toEqual({ valid: false, reasonCode: 'grant_revoked' });

        expect(verifyDirectRouteGrantV1({
            grant: createSignedGrant(),
            trustRoots: [{ keyId: 'key_1', publicKey: toBase64Url(signingKeyPair.publicKey) }],
            nowMs: 2_000,
            expected: { accountId: 'account_1', machineId: 'machine_1', flowKind: 'bounded_transfer', routeKind: 'loopback_direct' },
            revokedGrantFamilyIds: new Set(['family_1']),
        })).toEqual({ valid: false, reasonCode: 'grant_revoked' });
    });
});

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
                maxCalls: 1,
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

describe('verifyPeerRouteNonceV1', () => {
    it('binds peer nonce proof to grant, route, flow, and endpoint fingerprint', () => {
        const proof = createPeerRouteNonceProofV1({
            grantId: 'grant_1',
            routeKind: 'loopback_direct',
            flowKind: 'bounded_transfer',
            endpointFingerprint: 'endpoint_1',
            nonceBase64Url: toBase64Url(new Uint8Array(32).fill(3)),
            accountSigningSeed: accountSeed,
        });

        expect(verifyPeerRouteNonceV1({
            proof,
            accountPublicKey: toBase64Url(accountKeyPair.publicKey),
            expected: {
                grantId: 'grant_1',
                routeKind: 'loopback_direct',
                flowKind: 'bounded_transfer',
                endpointFingerprint: 'endpoint_1',
            },
        })).toEqual({ valid: true });

        expect(verifyPeerRouteNonceV1({
            proof,
            accountPublicKey: toBase64Url(accountKeyPair.publicKey),
            expected: {
                grantId: 'grant_1',
                routeKind: 'lan_direct',
                flowKind: 'bounded_transfer',
                endpointFingerprint: 'endpoint_1',
            },
        })).toEqual({ valid: false, reasonCode: 'nonce_binding_mismatch' });
    });

    it('only resolves nonce signing seed from legacy credentials', () => {
        expect(resolvePeerRouteNonceSigningSeedFromCredentials({
            token: 'token',
            encryption: { type: 'legacy', secret: accountSeed },
        })).toEqual({ ok: true, seed: accountSeed });

        expect(resolvePeerRouteNonceSigningSeedFromCredentials({
            token: 'token',
            encryption: {
                type: 'dataKey',
                publicKey: new Uint8Array(32),
                machineKey: new Uint8Array(32),
            },
        })).toEqual({
            ok: false,
            reasonCode: 'account_signing_key_unavailable_for_credential_mode',
        });
    });
});
