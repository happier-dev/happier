import { describe, expect, it } from 'vitest';

import type { FeaturesResponse } from '@happier-dev/protocol';

import { resolveBoundedTransferRouteDecision } from './route';

function createServerFeatures(partial?: Partial<FeaturesResponse>): FeaturesResponse {
    return {
        features: {
            sessions: {
                enabled: true,
                handoff: {
                    enabled: true,
                },
            },
            machines: {
                enabled: true,
                transfer: {
                    enabled: true,
                    directPeer: {
                        enabled: true,
                    },
                    serverRouted: {
                        enabled: true,
                    },
                },
            },
            ...(partial?.features ?? {}),
        },
        capabilities: {
            ...(partial?.capabilities ?? {}),
        },
    };
}

describe('resolveBoundedTransferRouteDecision', () => {
    it('preserves current direct-peer preference behavior for bounded transfers', () => {
        expect(resolveBoundedTransferRouteDecision({
            serverFeatures: createServerFeatures(),
            preferredStrategies: ['direct_peer', 'server_relay_stream'],
            directPeerAvailable: true,
        })).toEqual({
            kind: 'selected',
            strategy: 'direct_peer',
            allowServerRelayFallback: true,
            allowServerRoutedFallback: true,
        });
    });

    it('preserves server-routed fallback behavior when direct peer is unavailable', () => {
        expect(resolveBoundedTransferRouteDecision({
            serverFeatures: createServerFeatures(),
            preferredStrategies: ['direct_peer', 'server_relay_stream'],
            directPeerAvailable: false,
        })).toEqual({
            kind: 'selected',
            strategy: 'server_relay_stream',
            allowServerRelayFallback: true,
            allowServerRoutedFallback: true,
        });
    });

    it('does not select direct peer when no final direct route kind is available', () => {
        expect(resolveBoundedTransferRouteDecision({
            serverFeatures: createServerFeatures(),
            preferredStrategies: ['direct_peer', 'server_relay_stream'],
            directPeerAvailable: true,
            directRouteKinds: [],
        })).toEqual({
            kind: 'selected',
            strategy: 'server_relay_stream',
            allowServerRelayFallback: true,
            allowServerRoutedFallback: true,
        });
    });

    it('folds the legacy server-routed strategy name into canonical relay naming', () => {
        expect(resolveBoundedTransferRouteDecision({
            serverFeatures: createServerFeatures(),
            preferredStrategies: ['direct_peer', 'server_routed_stream'],
            directPeerAvailable: false,
        })).toEqual({
            kind: 'selected',
            strategy: 'server_relay_stream',
            allowServerRelayFallback: true,
            allowServerRoutedFallback: true,
        });
    });

    it('preserves fail-closed behavior when transfer is disabled', () => {
        expect(resolveBoundedTransferRouteDecision({
            serverFeatures: createServerFeatures({
                features: {
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: false,
                            directPeer: {
                                enabled: true,
                            },
                            serverRouted: {
                                enabled: true,
                            },
                        },
                    },
                },
            }),
            preferredStrategies: ['direct_peer', 'server_relay_stream'],
            directPeerAvailable: true,
        })).toEqual({
            kind: 'unavailable',
            reasonCode: 'transfer_disabled',
        });
    });

    it('preserves fail-closed behavior when server-routed fallback is disabled', () => {
        expect(resolveBoundedTransferRouteDecision({
            serverFeatures: createServerFeatures({
                features: {
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: {
                                enabled: false,
                            },
                            serverRouted: {
                                enabled: false,
                            },
                        },
                    },
                },
            }),
            preferredStrategies: ['direct_peer'],
            directPeerAvailable: true,
        })).toEqual({
            kind: 'unavailable',
            reasonCode: 'server_routed_transfer_disabled',
        });
    });
});
