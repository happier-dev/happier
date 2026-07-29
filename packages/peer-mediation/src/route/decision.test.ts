import { describe, expect, it } from 'vitest';

import { resolvePeerRouteDecision } from './decision';
import type { PeerRouteCandidate } from './types';

function createCandidate(overrides: Partial<PeerRouteCandidate>): PeerRouteCandidate {
    return {
        routeKind: 'loopback_direct',
        enabled: true,
        viability: { status: 'viable', checkedAt: 1_000, expiresAt: 31_000 },
        endpoint: {
            transport: 'http',
            mechanism: 'loopback_http',
            url: 'http://127.0.0.1:46001/machine-transfers/direct/a',
            endpointFingerprint: 'fingerprint-a',
        },
        ...overrides,
    };
}

describe('resolvePeerRouteDecision', () => {
    it('selects the first preferred viable route using final route names', () => {
        expect(resolvePeerRouteDecision({
            flowKind: 'bounded_transfer',
            preferredRouteKinds: ['loopback_direct', 'server_relay'],
            candidates: [
                createCandidate({ routeKind: 'loopback_direct' }),
                createCandidate({
                    routeKind: 'server_relay',
                    endpoint: {
                        transport: 'socket_io',
                        mechanism: 'server_socket_io',
                        url: 'socket.io://server-1/transfer-relay',
                    },
                }),
            ],
        })).toEqual({
            kind: 'selected',
            flowKind: 'bounded_transfer',
            routeKind: 'loopback_direct',
            endpoint: {
                transport: 'http',
                mechanism: 'loopback_http',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/a',
                endpointFingerprint: 'fingerprint-a',
            },
            viability: { status: 'viable', checkedAt: 1_000, expiresAt: 31_000 },
        });
    });

    it('skips disabled and unavailable routes before selecting a fallback route', () => {
        expect(resolvePeerRouteDecision({
            flowKind: 'bounded_transfer',
            preferredRouteKinds: ['loopback_direct', 'lan_direct', 'server_relay'],
            candidates: [
                createCandidate({ routeKind: 'loopback_direct', enabled: false }),
                createCandidate({
                    routeKind: 'lan_direct',
                    viability: {
                        status: 'unavailable',
                        checkedAt: 1_000,
                        expiresAt: 6_000,
                        failureReason: 'network_error',
                    },
                }),
                createCandidate({
                    routeKind: 'server_relay',
                    endpoint: {
                        transport: 'socket_io',
                        mechanism: 'server_socket_io',
                        url: 'socket.io://server-1/transfer-relay',
                    },
                }),
            ],
        })).toEqual(expect.objectContaining({
            kind: 'selected',
            routeKind: 'server_relay',
        }));
    });

    it('selects a later viable candidate for the same preferred route kind', () => {
        expect(resolvePeerRouteDecision({
            flowKind: 'bounded_transfer',
            preferredRouteKinds: ['lan_direct', 'server_relay'],
            candidates: [
                createCandidate({
                    routeKind: 'lan_direct',
                    viability: {
                        status: 'unavailable',
                        checkedAt: 1_000,
                        expiresAt: 6_000,
                        failureReason: 'network_error',
                    },
                }),
                createCandidate({
                    routeKind: 'lan_direct',
                    endpoint: {
                        transport: 'ws',
                        mechanism: 'lan_ws',
                        url: 'ws://192.168.1.10:46001/peer-mediation',
                        endpointFingerprint: 'fingerprint-lan-b',
                    },
                }),
            ],
        })).toEqual(expect.objectContaining({
            kind: 'selected',
            routeKind: 'lan_direct',
            endpoint: expect.objectContaining({
                endpointFingerprint: 'fingerprint-lan-b',
            }),
        }));
    });

    it('fails closed when no preferred route is enabled and viable', () => {
        expect(resolvePeerRouteDecision({
            flowKind: 'bounded_transfer',
            preferredRouteKinds: ['loopback_direct', 'server_relay'],
            candidates: [
                createCandidate({ routeKind: 'loopback_direct', enabled: false }),
                createCandidate({
                    routeKind: 'server_relay',
                    enabled: false,
                    endpoint: {
                        transport: 'socket_io',
                        mechanism: 'server_socket_io',
                        url: 'socket.io://server-1/transfer-relay',
                    },
                }),
            ],
        })).toEqual({
            kind: 'unavailable',
            flowKind: 'bounded_transfer',
            reasonCode: 'no_routes_available',
        });
    });
});
