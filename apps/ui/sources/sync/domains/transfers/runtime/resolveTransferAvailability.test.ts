import { FeaturesResponseSchema, type FeaturesResponse } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

function createServerFeaturesResponse(partial?: Readonly<{
    features?: unknown;
    capabilities?: unknown;
}>): FeaturesResponse {
    return FeaturesResponseSchema.parse({
        features: {
            machines: {
                enabled: true,
                transfer: {
                    enabled: true,
                    directPeer: {
                        enabled: false,
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
    });
}

describe('resolveTransferAvailability', () => {
    it('returns direct-peer handoff selection details without speculative seam flags', async () => {
        const { resolveMachineTransferAvailability } = await import('./resolveTransferAvailability');

        expect(resolveMachineTransferAvailability({
            serverFeatures: {
                features: {
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
                    },
                    capabilities: {},
                },
            },
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
        })).toEqual({
            ok: true,
            negotiatedTransportStrategy: 'direct_peer',
            allowServerRoutedFallback: true,
        });
    });

    it('fails closed for handoff when session handoff is disabled on the selected server', async () => {
        const { resolveMachineTransferAvailability } = await import('./resolveTransferAvailability');

        expect(resolveMachineTransferAvailability({
            serverFeatures: {
                features: {
                    features: {
                        sessions: {
                            enabled: true,
                            handoff: { enabled: false },
                        },
                    },
                    capabilities: {},
                },
            },
            preferredTransportStrategies: ['direct_peer'],
        })).toEqual({
            ok: false,
            errorCode: 'handoff_disabled',
            errorMessage: 'Session handoff is disabled on the selected server',
        });
    });

    it('fails closed for handoff when all transfer strategies are disabled on the selected server', async () => {
        const { resolveMachineTransferAvailability } = await import('./resolveTransferAvailability');

        expect(resolveMachineTransferAvailability({
            serverFeatures: {
                features: {
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
                                    enabled: false,
                                },
                                serverRouted: {
                                    enabled: false,
                                },
                            },
                        },
                    },
                    capabilities: {},
                },
            },
            preferredTransportStrategies: ['direct_peer'],
        })).toEqual({
            ok: false,
            errorCode: 'transfer_disabled',
            errorMessage: 'Machine transfer is disabled on the selected server',
        });
    });
});
