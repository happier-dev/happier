import { describe, expect, it } from 'vitest';

import { FeaturesResponseSchema } from '@happier-dev/protocol';

describe('resolveSessionFileTransferAvailability', () => {
    it('routes predecessor lan_http-only state to relay without selecting direct peer', async () => {
        const { resolveSessionFileTransferAvailability } = await import('./resolveSessionFileTransferAvailability');
        const serverFeatures = FeaturesResponseSchema.parse({
            features: {
                machines: {
                    enabled: true,
                    transfer: {
                        enabled: true,
                        directPeer: { enabled: true },
                        serverRouted: { enabled: true },
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
            machineRpcDirectRoute: {
                status: 'unavailable',
                checkedAt: 10,
                expiresAt: 20,
                failureReason: 'machine_rpc_direct_unavailable',
            },
            machineDaemonState: {
                transfer: {
                    supported: { import: true, export: true },
                    listenerClasses: {
                        loopback_http: { enabled: false, configured: false, active: false },
                        lan_http: { enabled: true, configured: true, active: true },
                        tailscale_serve_https: { enabled: false, configured: false, active: false, available: false },
                    },
                    lifecycle: { mode: 'lazy_idle_shutdown', version: 1 },
                },
            },
        });

        expect(result.daemonDirectPeerDiagnostics.activeRouteKinds).toEqual([]);
        expect(result.daemonDirectPeerDiagnostics.route.status).toBe('unavailable');
        expect(result.decision).toEqual(expect.objectContaining({
            kind: 'selected',
            preferredRouteKind: 'server_relay_stream',
        }));
    });

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
        expect(result.daemonDirectPeerDiagnostics).toEqual({
            route: {
                status: 'unavailable',
                checkedAt: 0,
                expiresAt: 0,
                failureReason: 'daemon_transfer_listener_unconfigured',
            },
            state: 'unconfigured',
            configuredListenerClasses: [],
            activeListenerClasses: [],
            activeRouteKinds: [],
            inactiveListenerClasses: [],
            unavailableListenerClasses: [],
        });
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
        expect(result.daemonDirectPeerDiagnostics).toEqual({
            route: {
                status: 'viable',
                checkedAt: 0,
                expiresAt: Number.MAX_SAFE_INTEGER,
            },
            state: 'active',
            configuredListenerClasses: ['loopback_http'],
            activeListenerClasses: ['loopback_http'],
            activeRouteKinds: ['loopback_direct'],
            inactiveListenerClasses: [],
            unavailableListenerClasses: [],
        });
        expect(result.decision?.kind).toBe('selected');
        if (result.decision?.kind !== 'selected') {
            throw new Error('expected selected transfer route decision');
        }
        expect(result.decision.preferredRouteKind).toBe('direct_peer');
        expect(result.decision.availability.directPeerRouteKinds).toEqual(['loopback_direct']);
    });

    it('does not prefer a cached direct peer route when the daemon transfer listener is configured but inactive', async () => {
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
            directPeerRoute: { status: 'viable', checkedAt: 12, expiresAt: 22 },
            machineRpcDirectRoute: { status: 'viable', checkedAt: 13, expiresAt: 23 },
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
        expect(result.daemonDirectPeerDiagnostics).toEqual({
            route: { status: 'unknown' },
            state: 'configured_inactive',
            configuredListenerClasses: ['loopback_http'],
            activeListenerClasses: [],
            activeRouteKinds: [],
            inactiveListenerClasses: ['loopback_http'],
            unavailableListenerClasses: [],
        });
        expect(result.decision?.kind).toBe('selected');
        if (result.decision?.kind !== 'selected') {
            throw new Error('expected selected transfer route decision');
        }
        expect(result.decision.preferredRouteKind).toBe('machine_rpc_direct');
    });

    it('falls back to the machine-rpc route when the configured daemon listener reports available false', async () => {
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
            directPeerRoute: { status: 'viable', checkedAt: 12, expiresAt: 22 },
            machineRpcDirectRoute: { status: 'viable', checkedAt: 13, expiresAt: 23 },
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
                            available: false,
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
        expect(result.daemonDirectPeerDiagnostics).toEqual({
            route: { status: 'unknown' },
            state: 'configured_inactive',
            configuredListenerClasses: ['loopback_http'],
            activeListenerClasses: [],
            activeRouteKinds: [],
            inactiveListenerClasses: [],
            unavailableListenerClasses: ['loopback_http'],
        });
        expect(result.decision?.kind).toBe('selected');
        if (result.decision?.kind !== 'selected') {
            throw new Error('expected selected transfer route decision');
        }
        expect(result.decision.preferredRouteKind).toBe('machine_rpc_direct');
    });

    it('fails closed to the machine-rpc route when daemon transfer support is disabled', async () => {
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
            directPeerRoute: { status: 'viable', checkedAt: 12, expiresAt: 22 },
            machineRpcDirectRoute: { status: 'viable', checkedAt: 13, expiresAt: 23 },
            machineDaemonState: {
                transfer: {
                    supported: {
                        import: false,
                        export: false,
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
        expect(result.daemonDirectPeerDiagnostics).toEqual({
            route: {
                status: 'unavailable',
                checkedAt: 0,
                expiresAt: 0,
                failureReason: 'daemon_transfer_listener_unconfigured',
            },
            state: 'unconfigured',
            configuredListenerClasses: [],
            activeListenerClasses: [],
            activeRouteKinds: [],
            inactiveListenerClasses: [],
            unavailableListenerClasses: [],
        });
        expect(result.decision?.kind).toBe('selected');
        if (result.decision?.kind !== 'selected') {
            throw new Error('expected selected transfer route decision');
        }
        expect(result.decision.preferredRouteKind).toBe('machine_rpc_direct');
    });
});
