import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';

import { useAllMachines, useLaunchSelectionMachines, useMachineListByServerId, useSessionForkSupportSource } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

afterEach(() => {
    standardCleanup();
});

describe('useAllMachines', () => {
    it('returns cached machines even when bootstrap is not fully ready (avoids empty flicker)', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: false,
                machines: {
                    'm-cached': {
                        id: 'm-cached',
                        seq: 1,
                        createdAt: 1000,
                        updatedAt: 1000,
                        active: true,
                        activeAt: 1000,
                        metadata: { host: 'cached', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                    },
                },
            }));

            const hook = await renderHook(() => useAllMachines(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent().map((machine) => machine.id)).toEqual(['m-cached']);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps the active-server machine cache visible while bootstrap is still hydrating', async () => {
        const previousState = storage.getState();
        try {
            const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim() || 'server-active';
            storage.setState((state) => ({
                ...state,
                isDataReady: false,
                machines: {},
                machineListByServerId: {
                    [activeServerId]: [
                        {
                            id: 'm-scoped',
                            seq: 1,
                            createdAt: 1000,
                            updatedAt: 1000,
                            active: true,
                            activeAt: 1000,
                            metadata: { host: 'scoped', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                            metadataVersion: 1,
                            daemonState: null,
                            daemonStateVersion: 0,
                            revokedAt: null,
                        } as any,
                    ],
                },
            }));

            const hook = await renderHook(() => useAllMachines(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent().map((machine) => machine.id)).toEqual(['m-scoped']);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps launch-selection machines stable when heartbeat timestamps do not change online status', async () => {
        const previousState = storage.getState();
        try {
            const activeAt = Date.now();
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machines: {
                    'm-online': {
                        id: 'm-online',
                        seq: 1,
                        createdAt: activeAt,
                        updatedAt: activeAt,
                        active: true,
                        activeAt,
                        metadata: { host: 'online', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                        revokedAt: null,
                    },
                },
            }));

            const hook = await renderHook(() => useLaunchSelectionMachines(), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const firstMachines = hook.getCurrent();

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    machines: {
                        ...state.machines,
                        'm-online': {
                            ...state.machines['m-online']!,
                            updatedAt: activeAt + 1000,
                            activeAt: activeAt + 1000,
                        },
                    },
                }));
            });

            expect(hook.getCurrent()).toBe(firstMachines);
            expect(hook.getCurrent()[0]?.activeAt).toBe(activeAt);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('refreshes launch-selection machines when heartbeat freshness changes online status', async () => {
        const previousState = storage.getState();
        try {
            const staleActiveAt = Date.now() - 10 * 60_000;
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machines: {
                    'm-online': {
                        id: 'm-online',
                        seq: 1,
                        createdAt: staleActiveAt,
                        updatedAt: staleActiveAt,
                        active: true,
                        activeAt: staleActiveAt,
                        metadata: { host: 'online', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                        revokedAt: null,
                    },
                },
            }));

            const hook = await renderHook(() => useLaunchSelectionMachines(), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const firstMachines = hook.getCurrent();
            const freshActiveAt = Date.now();

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    machines: {
                        ...state.machines,
                        'm-online': {
                            ...state.machines['m-online']!,
                            updatedAt: freshActiveAt,
                            activeAt: freshActiveAt,
                        },
                    },
                }));
            });

            expect(hook.getCurrent()).not.toBe(firstMachines);
            expect(hook.getCurrent()[0]?.activeAt).toBe(freshActiveAt);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('does not fall back to another server cached machine list while the active server cache is empty during bootstrap', async () => {
        const previousState = storage.getState();
        try {
            const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim() || 'server-active';
            storage.setState((state) => ({
                ...state,
                isDataReady: false,
                machines: {
                    'm-stale-global': {
                        id: 'm-stale-global',
                        seq: 1,
                        createdAt: 900,
                        updatedAt: 900,
                        active: true,
                        activeAt: 900,
                        metadata: { host: 'stale-global', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                    } as any,
                },
                machineListByServerId: {
                    [activeServerId]: [],
                    'server-cached': [
                        {
                            id: 'm-cached-server',
                            seq: 1,
                            createdAt: 1000,
                            updatedAt: 1000,
                            active: true,
                            activeAt: 1000,
                            metadata: { host: 'cached-server', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                            metadataVersion: 1,
                            daemonState: null,
                            daemonStateVersion: 0,
                        } as any,
                    ],
                },
            }));

            const hook = await renderHook(() => useAllMachines(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toEqual([]);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps transcript fork support source stable when only metadata freshness fields change', async () => {
        const previousState = storage.getState();
        try {
            const metadata = {
                path: '/repo',
                host: 'mac',
                codexSessionId: 'codex-session',
                sessionModesV1: {
                    v: 1 as const,
                    provider: 'codex',
                    updatedAt: 100,
                    currentModeId: 'default',
                    availableModes: [{ id: 'default', name: 'Default' }],
                },
                summary: { text: 'Summary', updatedAt: 100 },
            };
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: {
                    ...state.sessions,
                    's-active': {
                        id: 's-active',
                        serverId: 'server-a',
                        seq: 10,
                        createdAt: 1000,
                        updatedAt: 1000,
                        active: true,
                        activeAt: 1000,
                        metadata,
                        metadataVersion: 1,
                        agentState: null,
                        agentStateVersion: 1,
                        thinking: false,
                        thinkingAt: 0,
                        presence: 'online',
                    },
                },
            }));

            const hook = await renderHook(() => useSessionForkSupportSource('s-active'), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const firstSource = hook.getCurrent();

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: {
                        ...state.sessions,
                        's-active': {
                            ...state.sessions['s-active']!,
                            metadataVersion: 2,
                            metadata: {
                                ...metadata,
                                sessionModesV1: {
                                    ...metadata.sessionModesV1,
                                    updatedAt: 200,
                                },
                                summary: { text: 'Summary', updatedAt: 200 },
                            },
                        },
                    },
                }));
            });

            expect(hook.getCurrent()).toBe(firstSource);
            expect(hook.getCurrent()).toEqual({ metadata, serverId: 'server-a' });

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('refreshes transcript fork support source when permission mode timestamp changes', async () => {
        const previousState = storage.getState();
        try {
            const metadata = {
                path: '/repo',
                host: 'mac',
                codexSessionId: 'codex-session',
                permissionMode: 'yolo' as const,
                permissionModeUpdatedAt: 100,
            };
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: {
                    ...state.sessions,
                    's-active': {
                        id: 's-active',
                        serverId: 'server-a',
                        seq: 10,
                        createdAt: 1000,
                        updatedAt: 1000,
                        active: true,
                        activeAt: 1000,
                        metadata,
                        metadataVersion: 1,
                        agentState: null,
                        agentStateVersion: 1,
                        thinking: false,
                        thinkingAt: 0,
                        presence: 'online',
                    },
                },
            }));

            const hook = await renderHook(() => useSessionForkSupportSource('s-active'), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const firstSource = hook.getCurrent();

            const refreshedMetadata = {
                ...metadata,
                permissionModeUpdatedAt: 200,
            };
            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: {
                        ...state.sessions,
                        's-active': {
                            ...state.sessions['s-active']!,
                            metadataVersion: 2,
                            metadata: refreshedMetadata,
                        },
                    },
                }));
            });

            expect(hook.getCurrent()).not.toBe(firstSource);
            expect(hook.getCurrent()).toEqual({ metadata: refreshedMetadata, serverId: 'server-a' });

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('includes offline machines and sorts online machines first', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machineListByServerId: {},
                machineListStatusByServerId: {},
                machines: {
                    'm-online': {
                        id: 'm-online',
                        seq: 1,
                        createdAt: 1000,
                        updatedAt: 1000,
                        active: true,
                        activeAt: 1000,
                        metadata: { host: 'online', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                    },
                    'm-offline': {
                        id: 'm-offline',
                        seq: 1,
                        createdAt: 2000,
                        updatedAt: 2000,
                        active: false,
                        activeAt: 2000,
                        metadata: { host: 'offline', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                    },
                },
            }));

            const hook = await renderHook(() => useAllMachines(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent().map((machine) => machine.id)).toEqual(['m-online', 'm-offline']);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('excludes revoked machines from visible machine lists', async () => {
        const previousState = storage.getState();
        try {
            const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim() || 'server-active';
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machines: {
                    'm-online': {
                        id: 'm-online',
                        seq: 1,
                        createdAt: 1000,
                        updatedAt: 1000,
                        active: true,
                        activeAt: 1000,
                        metadata: { host: 'online', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                        revokedAt: null,
                    },
                    'm-revoked': {
                        id: 'm-revoked',
                        seq: 1,
                        createdAt: 1200,
                        updatedAt: 1200,
                        active: false,
                        activeAt: 1200,
                        metadata: { host: 'revoked', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                        revokedAt: 1700000000000,
                    },
                },
                machineListByServerId: {
                    [activeServerId]: [
                        { id: 'm-online', active: true, activeAt: 1000, createdAt: 1000, updatedAt: 1000, metadata: { host: 'online' }, revokedAt: null } as any,
                        { id: 'm-revoked', active: false, activeAt: 1200, createdAt: 1200, updatedAt: 1200, metadata: { host: 'revoked' }, revokedAt: 1700000000000 } as any,
                    ],
                },
            }));

            const allMachinesHook = await renderHook(() => useAllMachines(), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const byServerHook = await renderHook(() => useMachineListByServerId(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(allMachinesHook.getCurrent().map((machine) => machine.id)).toEqual(['m-online']);
            expect((byServerHook.getCurrent()[activeServerId] ?? []).map((machine) => machine.id)).toEqual(['m-online']);

            await allMachinesHook.unmount();
            await byServerHook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('prefers the active-server machine cache over global machine map entries', async () => {
        const previousState = storage.getState();
        try {
            const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim() || 'server-active';
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machines: {
                    'm-active': {
                        id: 'm-active',
                        seq: 1,
                        createdAt: 1000,
                        updatedAt: 1000,
                        active: true,
                        activeAt: 1000,
                        metadata: { host: 'active', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                        revokedAt: null,
                    },
                    'm-stale': {
                        id: 'm-stale',
                        seq: 1,
                        createdAt: 900,
                        updatedAt: 900,
                        active: true,
                        activeAt: 900,
                        metadata: { host: 'stale', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                        revokedAt: null,
                    },
                },
                machineListByServerId: {
                    [activeServerId]: [
                        {
                            id: 'm-active',
                            seq: 1,
                            createdAt: 1000,
                            updatedAt: 1000,
                            active: true,
                            activeAt: 1000,
                            metadata: { host: 'active', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                            metadataVersion: 1,
                            daemonState: null,
                            daemonStateVersion: 0,
                            revokedAt: null,
                        } as any,
                    ],
                },
            }));

            const hook = await renderHook(() => useAllMachines(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent().map((machine) => machine.id)).toEqual(['m-active']);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
