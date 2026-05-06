import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { DirectRouteGrantPayloadV1, PeerMachineRpcDirectRequestV1 } from '@happier-dev/protocol';

import { createPeerMachineRpcCallLimiter } from './callLimits';
import { createPeerMachineRpcVerificationQuarantine } from './quarantine';
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

describe('validatePeerMachineRpcDirectRequest', () => {
    it('quarantines repeated grant verification failures by expected endpoint, not caller-supplied endpoint', () => {
        let nowMs = 2_000;
        const callLimiter = createPeerMachineRpcCallLimiter({ nowMs: () => nowMs });
        const quarantine = createPeerMachineRpcVerificationQuarantine({ nowMs: () => nowMs });
        const replayKeyCache = createPeerMachineRpcReplayKeyCache({ nowMs: () => nowMs });
        const baseOptions = {
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                flowKind: 'machine_rpc' as const,
                routeKind: 'loopback_direct' as const,
                endpointFingerprint: 'endpoint_1',
                accountPublicKey: Buffer.alloc(32, 3).toString('base64url'),
            },
            trustRoots: [{ keyId: 'key_1', publicKey: Buffer.alloc(32, 4).toString('base64url') }],
            revokedGrantIds: undefined,
            revokedGrantFamilyIds: undefined,
            callLimiter,
            quarantine,
            replayKeyCache,
        };

        for (let index = 0; index < 5; index += 1) {
            const result = validatePeerMachineRpcDirectRequest({
                ...baseOptions,
                body: createRequest(`attacker_endpoint_${index}`),
                nowMs: nowMs + index,
            });
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.response.reasonCode).toBe('grant_bad_signature');
            }
        }

        nowMs = 2_010;
        const quarantined = validatePeerMachineRpcDirectRequest({
            ...baseOptions,
            body: createRequest('another_attacker_endpoint'),
            nowMs,
        });

        expect(quarantined.ok).toBe(false);
        if (!quarantined.ok) {
            expect(quarantined.response.reasonCode).toBe('quarantined');
        }
    });
});
