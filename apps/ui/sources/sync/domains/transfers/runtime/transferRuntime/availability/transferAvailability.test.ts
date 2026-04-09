import { describe, expect, it } from 'vitest';

import { FeaturesResponseSchema } from '@happier-dev/protocol';

describe('resolveTransferAvailability', () => {
    it('derives canonical direct-peer, server-relay, and machine-rpc route availability from server bits and route records', async () => {
        const { resolveTransferAvailability } = await import('./transferAvailability');

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

        expect(resolveTransferAvailability({
            serverFeatures,
            directPeerRoute: { status: 'viable', checkedAt: 10, expiresAt: 20 },
            machineRpcDirectRoute: { status: 'unavailable', checkedAt: 11, expiresAt: 21, failureReason: 'machine_rpc_direct_unavailable' },
        })).toEqual({
            machineTransferEnabled: true,
            directPeerEnabled: true,
            serverRelayEnabled: true,
            directPeerRoute: { status: 'viable', checkedAt: 10, expiresAt: 20 },
            machineRpcDirectRoute: { status: 'unavailable', checkedAt: 11, expiresAt: 21, failureReason: 'machine_rpc_direct_unavailable' },
        });
    });

    it('fails closed when transfer features are missing', async () => {
        const { resolveTransferAvailability } = await import('./transferAvailability');

        expect(resolveTransferAvailability({
            serverFeatures: null,
            directPeerRoute: { status: 'unknown' },
            machineRpcDirectRoute: { status: 'unknown' },
        })).toEqual({
            machineTransferEnabled: false,
            directPeerEnabled: false,
            serverRelayEnabled: false,
            directPeerRoute: { status: 'unknown' },
            machineRpcDirectRoute: { status: 'unknown' },
        });
    });
});
