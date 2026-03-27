import { afterEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

import { useAllMachines, useMachineListByServerId } from '@/sync/domains/state/storage';
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

    it('includes offline machines and sorts online machines first', async () => {
        const previousState = storage.getState();
        try {
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
                    'server-a': [
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
            expect((byServerHook.getCurrent()['server-a'] ?? []).map((machine) => machine.id)).toEqual(['m-online']);

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
