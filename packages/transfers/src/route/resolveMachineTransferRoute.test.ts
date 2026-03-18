import { describe, expect, it } from 'vitest';

import type { FeaturesResponse } from '@happier-dev/protocol';

import { resolveMachineTransferRoute } from './resolveMachineTransferRoute';

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

describe('resolveMachineTransferRoute', () => {
    it('prefers direct peer when it is both enabled and currently available', () => {
        expect(resolveMachineTransferRoute({
            serverFeatures: createServerFeatures(),
            preferredStrategies: ['direct_peer', 'server_routed_stream'],
            directPeerAvailable: true,
        })).toEqual({
            kind: 'selected',
            strategy: 'direct_peer',
            allowServerRoutedFallback: true,
        });
    });

    it('falls back to server-routed transfer when direct peer is unavailable', () => {
        expect(resolveMachineTransferRoute({
            serverFeatures: createServerFeatures(),
            preferredStrategies: ['direct_peer', 'server_routed_stream'],
            directPeerAvailable: false,
        })).toEqual({
            kind: 'selected',
            strategy: 'server_routed_stream',
            allowServerRoutedFallback: true,
        });
    });

    it('fails closed when machine transfer is disabled', () => {
        expect(resolveMachineTransferRoute({
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
            preferredStrategies: ['direct_peer', 'server_routed_stream'],
            directPeerAvailable: true,
        })).toEqual({
            kind: 'unavailable',
            reasonCode: 'transfer_disabled',
        });
    });

    it('fails closed when server-routed transfer is disabled and direct peer cannot be used', () => {
        expect(resolveMachineTransferRoute({
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
