import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    session: { active: true } as any,
    machineReachability: { machineRpcTargetAvailable: true } as any,
    machineTarget: { machineId: 'machine-1', basePath: '/repo' } as any,
    machine: null as any,
    serverScopedMachineServerId: 'server-1' as string | null,
    serverScopedMachine: null as any,
    cachedMachineRpcDirectRoute: { status: 'unknown' as const } as any,
    serverSnapshot: {
        status: 'ready' as const,
        features: {
            features: {
                machines: {
                    enabled: true,
                    transfer: {
                        enabled: true,
                        directPeer: {
                            enabled: false,
                        },
                        serverRouted: { enabled: false },
                    },
                },
            },
            capabilities: {
                machines: {
                    transfer: {
                        serverRouted: {
                            maxBytes: 128,
                        },
                    },
                },
            },
        },
    } as any,
}));
const activeServerState = vi.hoisted(() => {
    const listeners = new Set<() => void>();

    return {
        serverId: 'server-1' as string | null,
        listeners,
        setServerId(next: string | null) {
            activeServerState.serverId = next;
            for (const listener of Array.from(listeners)) {
                listener();
            }
        },
        reset() {
            activeServerState.serverId = 'server-1';
            listeners.clear();
        },
    };
});

vi.mock('@/sync/domains/state/storage', () =>
    createStorageModuleStub({
        useSession: () => state.session,
        useMachine: () => state.machine,
        useServerScopedMachine: (_serverId: string | null) =>
            _serverId !== null && _serverId === state.serverScopedMachineServerId ? state.serverScopedMachine : null,
    }),
);

vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => state.machineReachability,
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: () => state.machineTarget,
}));

vi.mock('@/sync/domains/transfers/runtime/transferRouteCache', () => ({
    readCachedMachineRpcDirectRoute: () => state.cachedMachineRpcDirectRoute,
    subscribeCachedMachineRpcDirectRoute: () => () => {},
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    useServerFeaturesSnapshotForServerId: () => state.serverSnapshot,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: (sessionId: string) => {
        void sessionId;
        return React.useSyncExternalStore(
            (listener: () => void) => {
                activeServerState.listeners.add(listener);
                return () => {
                    activeServerState.listeners.delete(listener);
                };
            },
            () => state.session?.serverId ?? activeServerState.serverId,
            () => state.session?.serverId ?? activeServerState.serverId,
        );
    },
}));

describe('useSessionFileTransferAvailabilityResolver', () => {
    it('does not gate bulk file transfers by the total transfer size (chunked transfers)', async () => {
        state.session = { active: true } as any;
        state.machineReachability = { machineRpcTargetAvailable: true } as any;
        state.machineTarget = { machineId: 'machine-1', basePath: '/repo' } as any;
        state.serverScopedMachine = null as any;
        state.cachedMachineRpcDirectRoute = { status: 'viable' as const, checkedAt: 10, expiresAt: 20 } as any;
        state.serverSnapshot = {
            status: 'ready' as const,
            features: {
                features: {
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: {
                                enabled: false,
                            },
                            serverRouted: { enabled: false },
                        },
                    },
                },
                capabilities: {
                    machines: {
                        transfer: {
                            serverRouted: {
                                maxBytes: 128,
                            },
                        },
                    },
                },
            },
        } as any;

        const { useSessionFileTransferAvailabilityResolver } = await import('./useSessionFileTransferAvailability');
        const hook = await renderHook(() => useSessionFileTransferAvailabilityResolver('s1'));

        expect(hook.getCurrent()(64)).toBe(true);
        expect(hook.getCurrent()(512)).toBe(true);
    });

    it('allows session file transfers when the daemon direct transfer listener is active and direct peer is enabled', async () => {
        state.session = { active: true } as any;
        state.machineReachability = { machineRpcTargetAvailable: true } as any;
        state.machineTarget = { machineId: 'machine-1', basePath: '/repo' } as any;
        state.machine = {
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
        } as any;
        state.serverScopedMachine = state.machine;
        state.cachedMachineRpcDirectRoute = { status: 'unknown' as const } as any;
        state.serverSnapshot = {
            status: 'ready' as const,
            features: {
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
            },
        } as any;

        const { useSessionFileTransferAvailabilityResolver } = await import('./useSessionFileTransferAvailability');
        const hook = await renderHook(() => useSessionFileTransferAvailabilityResolver('s1'));

        expect(hook.getCurrent()(64)).toBe(true);
    });

    it('exposes coarse daemon direct-peer diagnostics for configured-but-inactive listeners', async () => {
        state.session = { active: true } as any;
        state.machineReachability = { machineRpcTargetAvailable: true } as any;
        state.machineTarget = { machineId: 'machine-1', basePath: '/repo' } as any;
        state.machine = {
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
        } as any;
        state.serverScopedMachine = state.machine;
        state.cachedMachineRpcDirectRoute = { status: 'viable' as const, checkedAt: 20, expiresAt: 30 } as any;
        state.serverSnapshot = {
            status: 'ready' as const,
            features: {
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
            },
        } as any;

        const { useSessionFileTransferAvailabilityState } = await import('./useSessionFileTransferAvailability');
        const hook = await renderHook(() => useSessionFileTransferAvailabilityState('s1'));

        expect(hook.getCurrent().daemonDirectPeerDiagnostics).toEqual({
            route: { status: 'unknown' },
            state: 'configured_inactive',
            configuredListenerClasses: ['loopback_http', 'tailscale_serve_https'],
            activeListenerClasses: [],
            activeRouteKinds: [],
            inactiveListenerClasses: ['loopback_http', 'tailscale_serve_https'],
            unavailableListenerClasses: [],
        });
        expect(hook.getCurrent().available).toBe(true);
    });

    it('uses the preferred server scoped machine daemon state instead of the active global machine record', async () => {
        state.session = { active: true } as any;
        state.machineReachability = { machineRpcTargetAvailable: true } as any;
        state.machineTarget = { machineId: 'machine-1', basePath: '/repo' } as any;
        state.machine = null as any;
        state.serverScopedMachine = {
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
        } as any;
        state.cachedMachineRpcDirectRoute = { status: 'unknown' as const } as any;
        state.serverSnapshot = {
            status: 'ready' as const,
            features: {
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
            },
        } as any;

        const { useSessionFileTransferAvailabilityResolver } = await import('./useSessionFileTransferAvailability');
        const hook = await renderHook(() => useSessionFileTransferAvailabilityResolver('s1'));

        expect(hook.getCurrent()(64)).toBe(true);
    });

    it('uses the session server id when preferred server resolution is unavailable', async () => {
        state.session = { active: true, serverId: 'server-explicit' } as any;
        state.machineReachability = { machineRpcTargetAvailable: true } as any;
        state.machineTarget = { machineId: 'machine-1', basePath: '/repo' } as any;
        state.serverScopedMachineServerId = 'server-explicit';
        state.machine = null as any;
        state.serverScopedMachine = {
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
        } as any;
        state.cachedMachineRpcDirectRoute = { status: 'unknown' as const } as any;
        state.serverSnapshot = {
            status: 'ready' as const,
            features: {
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
            },
        } as any;

        const { useSessionFileTransferAvailabilityResolver } = await import('./useSessionFileTransferAvailability');
        const hook = await renderHook(() => useSessionFileTransferAvailabilityResolver('s1'));

        expect(hook.getCurrent()(64)).toBe(true);
    });

    it('reacts to active server changes when the session server id is not hydrated yet', async () => {
        state.session = { active: true } as any;
        state.machineReachability = { machineRpcTargetAvailable: true } as any;
        state.machineTarget = { machineId: 'machine-1', basePath: '/repo' } as any;
        state.machine = null as any;
        state.serverScopedMachineServerId = 'server-b';
        state.serverScopedMachine = {
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
        } as any;
        state.cachedMachineRpcDirectRoute = { status: 'unknown' as const } as any;
        state.serverSnapshot = {
            status: 'ready' as const,
            features: {
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
            },
        } as any;
        activeServerState.setServerId('server-a');

        const { useSessionFileTransferAvailabilityResolver } = await import('./useSessionFileTransferAvailability');
        const hook = await renderHook(() => useSessionFileTransferAvailabilityResolver('s1'));

        expect(hook.getCurrent()(64)).toBe(false);

        act(() => {
            activeServerState.setServerId('server-b');
        });

        expect(hook.getCurrent()(64)).toBe(true);
    });

    it('falls back to the active global machine daemon state when the preferred server scoped machine record is not loaded yet', async () => {
        state.session = { active: true } as any;
        state.machineReachability = { machineRpcTargetAvailable: true } as any;
        state.machineTarget = { machineId: 'machine-1', basePath: '/repo' } as any;
        state.machine = {
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
        } as any;
        state.serverScopedMachine = null as any;
        state.cachedMachineRpcDirectRoute = { status: 'unknown' as const } as any;
        state.serverSnapshot = {
            status: 'ready' as const,
            features: {
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
            },
        } as any;

        const { useSessionFileTransferAvailabilityResolver } = await import('./useSessionFileTransferAvailability');
        const hook = await renderHook(() => useSessionFileTransferAvailabilityResolver('s1'));

        expect(hook.getCurrent()(64)).toBe(true);
    });

    it('fails closed when file transfer policy has no viable route', async () => {
        state.session = { active: true } as any;
        state.machineReachability = { machineRpcTargetAvailable: true } as any;
        state.machineTarget = { machineId: 'machine-1', basePath: '/repo' } as any;
        state.serverScopedMachine = null as any;
        state.cachedMachineRpcDirectRoute = { status: 'unknown' as const } as any;
        state.serverSnapshot = {
            status: 'ready' as const,
            features: {
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
                capabilities: {},
            },
        } as any;

        const { useSessionFileTransferAvailabilityResolver } = await import('./useSessionFileTransferAvailability');
        const hook = await renderHook(() => useSessionFileTransferAvailabilityResolver('s1'));

        expect(hook.getCurrent()(64)).toBe(false);
    });

    it('fails closed when machine transfers are disabled on the server', async () => {
        state.session = { active: true } as any;
        state.machineReachability = { machineRpcTargetAvailable: true } as any;
        state.machineTarget = { machineId: 'machine-1', basePath: '/repo' } as any;
        state.serverScopedMachine = null as any;
        state.cachedMachineRpcDirectRoute = { status: 'viable' as const, checkedAt: 10, expiresAt: 20 } as any;
        state.serverSnapshot = {
            status: 'ready' as const,
            features: {
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
                capabilities: {},
            },
        } as any;

        const { useSessionFileTransferAvailabilityResolver } = await import('./useSessionFileTransferAvailability');
        const hook = await renderHook(() => useSessionFileTransferAvailabilityResolver('s1'));

        expect(hook.getCurrent()(64)).toBe(false);
    });

    it('fails closed when the session record is missing (no speculative transfer availability)', async () => {
        state.session = null as any;
        state.machineReachability = { machineRpcTargetAvailable: true } as any;
        state.machineTarget = { machineId: 'machine-1', basePath: '/repo' } as any;
        state.serverScopedMachine = null as any;
        state.cachedMachineRpcDirectRoute = { status: 'viable' as const } as any;
        state.serverSnapshot = {
            status: 'ready' as const,
            features: {
                features: {
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            serverRouted: { enabled: true },
                        },
                    },
                },
                capabilities: {},
            },
        } as any;

        const { useSessionFileTransferAvailabilityResolver } = await import('./useSessionFileTransferAvailability');
        const hook = await renderHook(() => useSessionFileTransferAvailabilityResolver('s1'));

        expect(hook.getCurrent()(null)).toBe(false);
    });
});
