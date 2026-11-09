import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    createDirectRouteGrantSigningInputV2,
    createEphemeralPeerRouteProofHandleV2,
    type DirectRouteGrantPayloadV1,
    type DirectRouteGrantPayloadV2,
    type PeerMachineRpcDirectRequestV1,
    type PeerMachineRpcDirectRequestV2,
} from '@happier-dev/protocol';

import { createPeerMachineRpcReplayKeyCache } from './replayKeys';
import { validatePeerMachineRpcDirectRequest } from './validateRequest';

const grantPayload: DirectRouteGrantPayloadV1 = {
    v: 1,
    grantId: 'grant_1',
    accountId: 'account_1',
    machineId: 'machine_1',
    flowKind: 'machine_rpc',
    routeKind: 'loopback_direct',
    scope: {
        kind: 'machine_rpc',
        rpcScopeId: 'rpc_scope_1',
        allowedMethods: [RPC_METHODS.DAEMON_MEMORY_STATUS],
        maxCalls: 2,
        maxIdleMs: 30_000,
    },
    iat: 1_000,
    exp: 61_000,
    aud: 'happier-daemon-route-grant',
    endpointFingerprint: 'endpoint_1',
};

function createRequest(endpointFingerprint: string): PeerMachineRpcDirectRequestV1 {
    return {
        v: 1,
        requestId: `request_${endpointFingerprint}`,
        method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        params: {},
        routeKind: 'loopback_direct',
        flowKind: 'machine_rpc',
        endpointFingerprint,
        grant: {
            payload: grantPayload,
            signature: {
                keyId: 'key_1',
                alg: 'Ed25519',
                valueBase64Url: Buffer.alloc(64).toString('base64url'),
            },
        },
        nonceProof: {
            v: 1,
            grantId: grantPayload.grantId,
            routeKind: 'loopback_direct',
            flowKind: 'machine_rpc',
            endpointFingerprint,
            nonceBase64Url: Buffer.alloc(16, 1).toString('base64url'),
            signatureBase64Url: Buffer.alloc(64, 2).toString('base64url'),
        },
    };
}

function createCurrentRequest(endpointFingerprint: string): PeerMachineRpcDirectRequestV2 {
    const handle = createEphemeralPeerRouteProofHandleV2({
        randomBytes: (length) => new Uint8Array(length).fill(8),
    });
    const grant = {
        payload: {
            ...grantPayload, v: 2 as const, proofKind: 'ephemeral_ed25519' as const,
            ephemeralPublicKeyBase64Url: handle.publicKeyBase64Url,
        },
        signature: { keyId: 'key_1', alg: 'Ed25519' as const, valueBase64Url: Buffer.alloc(64).toString('base64url') },
    };
    try {
        return {
            v: 2, requestId: `request_${endpointFingerprint}`, method: RPC_METHODS.DAEMON_MEMORY_STATUS,
            params: {}, routeKind: 'loopback_direct', flowKind: 'machine_rpc', endpointFingerprint,
            grant, proof: handle.sign(grant),
        };
    } finally {
        handle.dispose();
    }
}

describe('validatePeerMachineRpcDirectRequest', () => {
    it('rejects the retired account-signed direct request before grant admission', () => {
        const nowMs = 2_000;
        const result = validatePeerMachineRpcDirectRequest({
            body: createRequest('endpoint_1'),
            expected: {
                accountId: 'account_1', machineId: 'machine_1', flowKind: 'machine_rpc',
                routeKind: 'loopback_direct', endpointFingerprint: 'endpoint_1',
            },
            trustRoots: [{ keyId: 'key_1', publicKey: Buffer.alloc(32, 4).toString('base64url') }],
            nowMs,
            replayKeyCache: createPeerMachineRpcReplayKeyCache({ nowMs: () => nowMs }),
        });
        expect(result).toMatchObject({ ok: false, response: { v: 2, reasonCode: 'invalid_request' } });
    });

    it('validates signed method scope without consuming a per-grant call allowance', () => {
        const serverKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
        const handle = createEphemeralPeerRouteProofHandleV2({
            randomBytes: (length) => new Uint8Array(length).fill(length === 32 ? 8 : 9),
        });
        const payload: DirectRouteGrantPayloadV2 = {
            ...grantPayload,
            v: 2,
            proofKind: 'ephemeral_ed25519',
            ephemeralPublicKeyBase64Url: handle.publicKeyBase64Url,
        };
        const grant = {
            payload,
            signature: {
                keyId: 'key_1',
                alg: 'Ed25519' as const,
                valueBase64Url: Buffer.from(tweetnacl.sign.detached(
                    Buffer.from(createDirectRouteGrantSigningInputV2(payload), 'utf8'),
                    serverKeyPair.secretKey,
                )).toString('base64url'),
            },
        };
        const request: PeerMachineRpcDirectRequestV2 = {
            v: 2,
            requestId: 'request_v2',
            method: RPC_METHODS.DAEMON_MEMORY_STATUS,
            params: {},
            routeKind: 'loopback_direct',
            flowKind: 'machine_rpc',
            endpointFingerprint: 'endpoint_1',
            grant,
            proof: handle.sign(grant),
        };
        const nowMs = 2_000;
        const replayKeyCache = createPeerMachineRpcReplayKeyCache({ nowMs: () => nowMs });
        const options = {
            body: request,
            expected: {
                accountId: 'account_1', machineId: 'machine_1', flowKind: 'machine_rpc' as const,
                routeKind: 'loopback_direct' as const, endpointFingerprint: 'endpoint_1',
            },
            trustRoots: [{ keyId: 'key_1', publicKey: Buffer.from(serverKeyPair.publicKey).toString('base64url') }],
            nowMs,
            replayKeyCache,
        };
        // Validation authenticates each request; the route's atomic reservation owns one-use consumption.
        for (let index = 0; index < 3; index++) {
            const result = validatePeerMachineRpcDirectRequest(options);
            expect(result.ok).toBe(true);
            if (result.ok) expect(result.request.v).toBe(2);
        }

    });

    it('keeps authenticating each request after repeated invalid signatures', () => {
        let nowMs = 2_000;
        const replayKeyCache = createPeerMachineRpcReplayKeyCache({ nowMs: () => nowMs });
        const baseOptions = {
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                flowKind: 'machine_rpc' as const,
                routeKind: 'loopback_direct' as const,
                endpointFingerprint: 'endpoint_1',
            },
            trustRoots: [{ keyId: 'key_1', publicKey: Buffer.alloc(32, 4).toString('base64url') }],
            replayKeyCache,
        };

        for (let index = 0; index < 5; index += 1) {
            const result = validatePeerMachineRpcDirectRequest({
                ...baseOptions,
                body: createCurrentRequest(`attacker_endpoint_${index}`),
                nowMs: nowMs + index,
            });
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.response.reasonCode).toBe('grant_bad_signature');
            }
        }

        nowMs = 2_010;
        const rejected = validatePeerMachineRpcDirectRequest({
            ...baseOptions,
            body: createCurrentRequest('another_attacker_endpoint'),
            nowMs,
        });

        expect(rejected.ok).toBe(false);
        if (!rejected.ok) {
            expect(rejected.response.reasonCode).toBe('grant_bad_signature');
        }
    });
});
