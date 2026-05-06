import { describe, expect, it, vi } from 'vitest';

import { createPeerRouteViabilityCache } from '@happier-dev/peer-mediation';

import { resolvePeerLoopbackRouteAvailability } from './resolvePeerLoopbackRouteAvailability';

const endpoint = {
    v: 1,
    routeKind: 'loopback_direct',
    url: 'http://127.0.0.1:3456/peer-mediation/v1/probe',
    endpointFingerprint: 'loopback_endpoint_1',
    expiresAt: 10_000,
} as const;

const grant = {
    payload: {
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
        endpointFingerprint: 'loopback_endpoint_1',
    },
    signature: {
        keyId: 'key_1',
        alg: 'Ed25519',
        valueBase64Url: 'AbCdEf012_-',
    },
} as const;

describe('resolvePeerLoopbackRouteAvailability', () => {
    it('records a viable loopback route only after grant and probe success', async () => {
        const cache = createPeerRouteViabilityCache({
            now: () => 2_000,
            positiveTtlMs: 10_000,
            negativeTtlMs: 2_000,
        });
        const requestGrant = vi.fn(async () => ({ ok: true as const, grant }));
        const createNonceProof = vi.fn(async () => ({ ok: true as const, nonceProof: {
            v: 1,
            grantId: 'grant_1',
            routeKind: 'loopback_direct',
            flowKind: 'bounded_transfer',
            endpointFingerprint: 'loopback_endpoint_1',
            nonceBase64Url: 'nonce_1',
            signatureBase64Url: 'AbCdEf012_-',
        } as const }));
        const postProbe = vi.fn(async () => ({
            v: 1,
            ok: true as const,
            receipt: 'peer.route.selected' as const,
            routeKind: 'loopback_direct' as const,
            flowKind: 'bounded_transfer' as const,
            endpointFingerprint: 'loopback_endpoint_1',
        } as const));

        const result = await resolvePeerLoopbackRouteAvailability({
            serverId: 'server-1',
            targetMachineId: 'machine_1',
            flowKind: 'bounded_transfer',
            routeKind: 'loopback_direct',
            endpoint,
            cache,
            requestGrant,
            createNonceProof,
            postProbe,
        });

        expect(result).toEqual({
            kind: 'selected',
            receipt: 'peer.route.selected',
            routeKind: 'loopback_direct',
            flowKind: 'bounded_transfer',
            endpointFingerprint: 'loopback_endpoint_1',
            grant,
            nonceProof: {
                v: 1,
                grantId: 'grant_1',
                routeKind: 'loopback_direct',
                flowKind: 'bounded_transfer',
                endpointFingerprint: 'loopback_endpoint_1',
                nonceBase64Url: 'nonce_1',
                signatureBase64Url: 'AbCdEf012_-',
            },
        });
        expect(cache.read({
            serverId: 'server-1',
            targetMachineId: 'machine_1',
            flowKind: 'bounded_transfer',
            routeKind: 'loopback_direct',
            endpointFingerprint: 'loopback_endpoint_1',
        })).toMatchObject({ status: 'viable' });
        expect(requestGrant).toHaveBeenCalledOnce();
        expect(createNonceProof).toHaveBeenCalledOnce();
        expect(postProbe).toHaveBeenCalledOnce();
    });

    it('records fallback without clearing server-mediated behavior when probe denies the route', async () => {
        const cache = createPeerRouteViabilityCache({
            now: () => 2_000,
            positiveTtlMs: 10_000,
            negativeTtlMs: 2_000,
        });

        const result = await resolvePeerLoopbackRouteAvailability({
            serverId: 'server-1',
            targetMachineId: 'machine_1',
            flowKind: 'bounded_transfer',
            routeKind: 'loopback_direct',
            endpoint,
            cache,
            requestGrant: async () => ({ ok: true, grant }),
            createNonceProof: async () => ({ ok: true, nonceProof: {
                v: 1,
                grantId: 'grant_1',
                routeKind: 'loopback_direct',
                flowKind: 'bounded_transfer',
                endpointFingerprint: 'loopback_endpoint_1',
                nonceBase64Url: 'nonce_1',
                signatureBase64Url: 'AbCdEf012_-',
            } as const }),
            postProbe: async () => ({
                v: 1,
                ok: false,
                receipt: 'peer.route.fallback',
                reasonCode: 'grant_endpoint_mismatch',
            } as const),
        });

        expect(result).toEqual({
            kind: 'fallback',
            receipt: 'peer.route.fallback',
            reasonCode: 'grant_endpoint_mismatch',
        });
        expect(cache.read({
            serverId: 'server-1',
            targetMachineId: 'machine_1',
            flowKind: 'bounded_transfer',
            routeKind: 'loopback_direct',
            endpointFingerprint: 'loopback_endpoint_1',
        })).toMatchObject({
            status: 'unavailable',
            failureReason: 'grant_endpoint_mismatch',
        });
    });

    it('does not record selected route viability when the probe response binding differs', async () => {
        const cache = createPeerRouteViabilityCache({
            now: () => 2_000,
            positiveTtlMs: 10_000,
            negativeTtlMs: 2_000,
        });

        const result = await resolvePeerLoopbackRouteAvailability({
            serverId: 'server-1',
            targetMachineId: 'machine_1',
            flowKind: 'bounded_transfer',
            routeKind: 'loopback_direct',
            endpoint,
            cache,
            requestGrant: async () => ({ ok: true, grant }),
            createNonceProof: async () => ({ ok: true, nonceProof: {
                v: 1,
                grantId: 'grant_1',
                routeKind: 'loopback_direct',
                flowKind: 'bounded_transfer',
                endpointFingerprint: 'loopback_endpoint_1',
                nonceBase64Url: 'nonce_1',
                signatureBase64Url: 'AbCdEf012_-',
            } as const }),
            postProbe: async () => ({
                v: 1,
                ok: true,
                receipt: 'peer.route.selected',
                routeKind: 'loopback_direct',
                flowKind: 'bounded_transfer',
                endpointFingerprint: 'other_endpoint',
            } as const),
        });

        expect(result).toEqual({
            kind: 'fallback',
            receipt: 'peer.route.fallback',
            reasonCode: 'probe_binding_mismatch',
        });
        expect(cache.read({
            serverId: 'server-1',
            targetMachineId: 'machine_1',
            flowKind: 'bounded_transfer',
            routeKind: 'loopback_direct',
            endpointFingerprint: 'loopback_endpoint_1',
        })).toMatchObject({
            status: 'unavailable',
            failureReason: 'probe_binding_mismatch',
        });
    });
});
