import { describe, expect, it } from 'vitest';

describe('resolveMachineDaemonTransferDirectPeerRoute', () => {
    it('maps only safe active listener mechanisms to final direct route kinds', async () => {
        const { resolveMachineDaemonTransferDirectPeerDiagnostics } = await import('./machineDaemonTransferState');

        expect(resolveMachineDaemonTransferDirectPeerDiagnostics({
            daemonState: {
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
                            enabled: true,
                            configured: true,
                            active: true,
                        },
                        tailscale_serve_https: {
                            enabled: true,
                            configured: true,
                            active: true,
                        },
                    },
                    lifecycle: {
                        mode: 'lazy_idle_shutdown',
                        version: 1,
                    },
                },
            },
        })).toEqual(expect.objectContaining({
            state: 'active',
            activeListenerClasses: ['loopback_http', 'tailscale_serve_https'],
            activeRouteKinds: ['loopback_direct', 'tailscale_serve_direct'],
        }));
    });

    it('ignores an undeclared listener class instead of projecting LAN-direct viability', async () => {
        const {
            readMachineDaemonTransferState,
            resolveMachineDaemonTransferDirectPeerDiagnostics,
        } = await import('./machineDaemonTransferState');
        const input = {
            daemonState: {
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
        } as const;

        expect(readMachineDaemonTransferState(input)?.listenerClasses).toEqual({
            loopback_http: { enabled: false, configured: false, active: false },
            tailscale_serve_https: { enabled: false, configured: false, active: false, available: false },
        });
        expect(resolveMachineDaemonTransferDirectPeerDiagnostics(input)).toEqual({
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
    });

    it('returns a viable route when a configured transfer listener is active', async () => {
        const { resolveMachineDaemonTransferDirectPeerRoute } = await import('./machineDaemonTransferState');

        expect(resolveMachineDaemonTransferDirectPeerRoute({
            daemonState: {
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
            },
        })).toEqual(expect.objectContaining({
            status: 'viable',
        }));
    });

    it('returns unavailable when no transfer listener is configured', async () => {
        const { resolveMachineDaemonTransferDirectPeerRoute } = await import('./machineDaemonTransferState');

        expect(resolveMachineDaemonTransferDirectPeerRoute({
            daemonState: {
                transfer: {
                    supported: {
                        import: true,
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
            },
        })).toEqual(expect.objectContaining({
            status: 'unavailable',
            failureReason: 'daemon_transfer_listener_unconfigured',
        }));
    });

    it('returns configured-inactive diagnostics when tailscale serve is configured but not active yet', async () => {
        const {
            resolveMachineDaemonTransferDirectPeerDiagnostics,
            resolveMachineDaemonTransferDirectPeerRoute,
        } = await import('./machineDaemonTransferState');

        const input = {
            daemonState: {
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
                            enabled: true,
                            configured: true,
                            active: false,
                            available: true,
                        },
                    },
                    lifecycle: {
                        mode: 'lazy_idle_shutdown',
                        version: 1,
                    },
                },
            },
        } as const;

        expect(resolveMachineDaemonTransferDirectPeerRoute(input)).toEqual({ status: 'unknown' });
        expect(resolveMachineDaemonTransferDirectPeerDiagnostics(input)).toEqual({
            route: { status: 'unknown' },
            state: 'configured_inactive',
            configuredListenerClasses: ['loopback_http', 'tailscale_serve_https'],
            activeListenerClasses: [],
            activeRouteKinds: [],
            inactiveListenerClasses: ['loopback_http', 'tailscale_serve_https'],
            unavailableListenerClasses: [],
        });
    });

    it('returns unavailable when transfer support is disabled even if a listener looks active', async () => {
        const {
            resolveMachineDaemonTransferDirectPeerDiagnostics,
            resolveMachineDaemonTransferDirectPeerRoute,
        } = await import('./machineDaemonTransferState');

        const input = {
            daemonState: {
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
            },
        } as const;

        expect(resolveMachineDaemonTransferDirectPeerRoute(input)).toEqual({
            status: 'unavailable',
            checkedAt: 0,
            expiresAt: 0,
            failureReason: 'daemon_transfer_listener_unconfigured',
        });
        expect(resolveMachineDaemonTransferDirectPeerDiagnostics(input)).toEqual({
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
    });

    it('treats a configured listener with available false as non-active and keeps the route unknown', async () => {
        const {
            resolveMachineDaemonTransferDirectPeerDiagnostics,
            resolveMachineDaemonTransferDirectPeerRoute,
        } = await import('./machineDaemonTransferState');

        const input = {
            daemonState: {
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
            },
        } as const;

        expect(resolveMachineDaemonTransferDirectPeerRoute(input)).toEqual({ status: 'unknown' });
        expect(resolveMachineDaemonTransferDirectPeerDiagnostics(input)).toEqual({
            route: { status: 'unknown' },
            state: 'configured_inactive',
            configuredListenerClasses: ['loopback_http'],
            activeListenerClasses: [],
            activeRouteKinds: [],
            inactiveListenerClasses: [],
            unavailableListenerClasses: ['loopback_http'],
        });
    });
});
