import { describe, expect, it } from 'vitest';

import { FeaturesResponseSchema } from '@happier-dev/protocol';

describe('resolveTransferRouteDecision', () => {
    it('prefers direct peer when the route is viable and the server enables direct peer transfers', async () => {
        const { resolveTransferRouteDecision } = await import('./resolveTransferRouteDecision');

        const serverFeatures = FeaturesResponseSchema.parse({
            features: {
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
        });

        expect(resolveTransferRouteDecision({
            serverFeatures,
            directPeerRoute: { status: 'viable', checkedAt: 10, expiresAt: 20 },
            machineRpcDirectRoute: { status: 'viable', checkedAt: 11, expiresAt: 21 },
        })).toEqual({
            kind: 'selected',
            preferredRouteKind: 'direct_peer',
            preferScopedMachineRpc: true,
            availability: {
                machineTransferEnabled: true,
                directPeerEnabled: true,
                serverRelayEnabled: true,
                directPeerRoute: { status: 'viable', checkedAt: 10, expiresAt: 20 },
                machineRpcDirectRoute: { status: 'viable', checkedAt: 11, expiresAt: 21 },
            },
        });
    });

    it('falls back to server relay when direct peer is unavailable and relay is enabled', async () => {
        const { resolveTransferRouteDecision } = await import('./resolveTransferRouteDecision');

        const serverFeatures = FeaturesResponseSchema.parse({
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
            },
            capabilities: {},
        });

        expect(resolveTransferRouteDecision({
            serverFeatures,
            directPeerRoute: { status: 'unavailable', checkedAt: 10, expiresAt: 20, failureReason: 'direct_peer_unavailable' },
            machineRpcDirectRoute: { status: 'unavailable', checkedAt: 11, expiresAt: 21, failureReason: 'machine_rpc_direct_unavailable' },
        })).toEqual({
            kind: 'selected',
            preferredRouteKind: 'server_relay_stream',
            preferScopedMachineRpc: true,
            availability: {
                machineTransferEnabled: true,
                directPeerEnabled: false,
                serverRelayEnabled: true,
                directPeerRoute: { status: 'unavailable', checkedAt: 10, expiresAt: 20, failureReason: 'direct_peer_unavailable' },
                machineRpcDirectRoute: { status: 'unavailable', checkedAt: 11, expiresAt: 21, failureReason: 'machine_rpc_direct_unavailable' },
            },
        });
    });

    it('fails closed when no transfer route is available', async () => {
        const { resolveTransferRouteDecision } = await import('./resolveTransferRouteDecision');

        expect(resolveTransferRouteDecision({
            serverFeatures: FeaturesResponseSchema.parse({
                features: {
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: false,
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
            }),
            directPeerRoute: { status: 'unknown' },
            machineRpcDirectRoute: { status: 'unknown' },
        })).toEqual({
            kind: 'unavailable',
            reasonCode: 'transfer_disabled',
            preferScopedMachineRpc: true,
            availability: {
                machineTransferEnabled: false,
                directPeerEnabled: false,
                serverRelayEnabled: false,
                directPeerRoute: { status: 'unknown' },
                machineRpcDirectRoute: { status: 'unknown' },
            },
        });
    });
});
