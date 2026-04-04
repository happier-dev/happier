import { describe, expect, it } from 'vitest';

describe('resolveMachineDaemonTransferDirectPeerRoute', () => {
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
});
