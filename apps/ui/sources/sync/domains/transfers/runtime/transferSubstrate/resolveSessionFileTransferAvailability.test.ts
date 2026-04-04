import { describe, expect, it } from 'vitest';

import { FeaturesResponseSchema } from '@happier-dev/protocol';

describe('resolveSessionFileTransferAvailability', () => {
    it('does not prefer direct peer when the daemon transfer state does not advertise a configured transfer listener', async () => {
        const { resolveSessionFileTransferAvailability } = await import('./resolveSessionFileTransferAvailability');

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
                            enabled: false,
                        },
                    },
                },
            },
            capabilities: {},
        });

        const result = resolveSessionFileTransferAvailability({
            sessionAvailable: true,
            machineTargetAvailable: true,
            serverFeatures,
            directPeerRoute: { status: 'viable', checkedAt: 10, expiresAt: 20 },
            machineRpcDirectRoute: { status: 'viable', checkedAt: 11, expiresAt: 21 },
            machineDaemonState: {
                transfer: {
                    supported: {
                        import: false,
                        export: true,
                    },
                    listenerClasses: {
                        loopback_http: {
                            enabled: false,
                            configured: false,
                            active: false,
                        },
                        lan_http: {
                            enabled: false,
                            configured: false,
                            active: false,
                        },
                        tailscale_serve_https: {
                            enabled: false,
                            configured: false,
                            active: false,
                            available: false,
                        },
                    },
                    lifecycle: {
                        mode: 'lazy_idle_shutdown',
                        version: 1,
                    },
                },
            } as any,
        } as any);

        expect(result.available).toBe(true);
        expect(result.decision?.kind).toBe('selected');
        if (result.decision?.kind !== 'selected') {
            throw new Error('expected selected transfer route decision');
        }
        expect(result.decision.preferredRouteKind).toBe('machine_rpc_direct');
    });

    it('prefers direct peer when the daemon transfer listener is active and direct peer is enabled', async () => {
        const { resolveSessionFileTransferAvailability } = await import('./resolveSessionFileTransferAvailability');

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
                            enabled: false,
                        },
                    },
                },
            },
            capabilities: {},
        });

        const result = resolveSessionFileTransferAvailability({
            sessionAvailable: true,
            machineTargetAvailable: true,
            serverFeatures,
            machineRpcDirectRoute: { status: 'unknown' },
            machineDaemonState: {
                transfer: {
                    supported: {
                        import: true,
                        export: true,
                    },
                    listenerClasses: {
                        loopback_http: {
                            enabled: true,
                            configured: true,
                            active: true,
                        },
                        lan_http: {
                            enabled: false,
                            configured: false,
                            active: false,
                        },
                        tailscale_serve_https: {
                            enabled: false,
                            configured: false,
                            active: false,
                            available: false,
                        },
                    },
                    lifecycle: {
                        mode: 'lazy_idle_shutdown',
                        version: 1,
                    },
                },
            } as any,
        } as any);

        expect(result.available).toBe(true);
        expect(result.decision?.kind).toBe('selected');
        if (result.decision?.kind !== 'selected') {
            throw new Error('expected selected transfer route decision');
        }
        expect(result.decision.preferredRouteKind).toBe('direct_peer');
    });
});
