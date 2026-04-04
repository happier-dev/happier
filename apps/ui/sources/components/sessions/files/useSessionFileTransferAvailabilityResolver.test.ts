import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    session: { active: true } as any,
    machineReachability: { machineRpcTargetAvailable: true } as any,
    machineTarget: { machineId: 'machine-1', basePath: '/repo' } as any,
    machine: null as any,
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

vi.mock('@/sync/domains/state/storage', () =>
    createStorageModuleStub({
        useSession: () => state.session,
        useMachine: () => state.machine,
        useServerScopedMachine: () => state.serverScopedMachine,
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

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: () => 'server-1',
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
