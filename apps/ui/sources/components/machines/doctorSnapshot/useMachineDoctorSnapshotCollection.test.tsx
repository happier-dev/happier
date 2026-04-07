import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import {
    clearCachedMachineDoctorSnapshot,
    writeCachedMachineDoctorSnapshot,
} from './machineDoctorSnapshotCache';

const machineCollectBugReportDiagnosticsMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/machines', () => ({
    machineCollectBugReportDiagnostics: machineCollectBugReportDiagnosticsMock,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('useMachineDoctorSnapshotCollection', () => {
    beforeEach(() => {
        machineCollectBugReportDiagnosticsMock.mockReset();
        clearCachedMachineDoctorSnapshot({ serverId: 'srv_a', machineId: 'machine_1' });
        clearCachedMachineDoctorSnapshot({ serverId: 'srv_b', machineId: 'machine_1' });
    });

    it('keeps duplicate machine ids from different servers isolated', async () => {
        const {
            buildMachineDoctorSnapshotTargetKey,
            useMachineDoctorSnapshotCollection,
        } = await import('./useMachineDoctorSnapshotCollection');
        const serverATargetKey = buildMachineDoctorSnapshotTargetKey({ machineId: 'machine_1', serverId: 'srv_a' });
        const serverBTargetKey = buildMachineDoctorSnapshotTargetKey({ machineId: 'machine_1', serverId: 'srv_b' });

        writeCachedMachineDoctorSnapshot({
            serverId: 'srv_a',
            machineId: 'machine_1',
            cachedAt: 111,
            snapshot: {
                capturedAt: '2026-04-07T10:11:12.000Z',
                server: {
                    activeServerId: 'srv_a',
                    serverUrl: 'https://srv-a.example.test',
                    publicServerUrl: 'https://srv-a.example.test',
                    webappUrl: 'https://srv-a.example.test',
                },
                accountId: 'acct_1',
                settings: {
                    activeServerId: 'srv_a',
                    servers: [],
                    knownAccountIds: ['acct_1'],
                },
            },
        });
        writeCachedMachineDoctorSnapshot({
            serverId: 'srv_b',
            machineId: 'machine_1',
            cachedAt: 222,
            snapshot: {
                capturedAt: '2026-04-07T10:11:13.000Z',
                server: {
                    activeServerId: 'srv_b',
                    serverUrl: 'https://srv-b.example.test',
                    publicServerUrl: 'https://srv-b.example.test',
                    webappUrl: 'https://srv-b.example.test',
                },
                accountId: 'acct_1',
                settings: {
                    activeServerId: 'srv_b',
                    servers: [],
                    knownAccountIds: ['acct_1'],
                },
            },
        });

        const hook = await renderHook(() => useMachineDoctorSnapshotCollection({
            machineDoctorTargetsByKey: new Map([
                [serverATargetKey, { machineId: 'machine_1', serverId: 'srv_a' }],
                [serverBTargetKey, { machineId: 'machine_1', serverId: 'srv_b' }],
            ]),
            enabled: false,
        }));

        await flushHookEffects({ cycles: 2, turns: 2 });

        const current = hook.getCurrent();
        const serverASnapshot = current.machineDoctorSnapshotByTargetKey[serverATargetKey];
        const serverBSnapshot = current.machineDoctorSnapshotByTargetKey[serverBTargetKey];

        expect(serverASnapshot).toEqual(expect.objectContaining({
            status: 'ready',
            cachedAt: 111,
            source: 'cache',
        }));
        expect(serverBSnapshot).toEqual(expect.objectContaining({
            status: 'ready',
            cachedAt: 222,
            source: 'cache',
        }));
        expect(serverASnapshot).not.toEqual(serverBSnapshot);
    });

    it('lets a cached ready snapshot replace an older local error state when snapshots are re-seeded', async () => {
        const { useMachineDoctorSnapshotCollection } = await import('./useMachineDoctorSnapshotCollection');
        const target = { machineId: 'machine_1', serverId: 'srv_a' } as const;

        machineCollectBugReportDiagnosticsMock.mockResolvedValueOnce(null);

        const hook = await renderHook(() => useMachineDoctorSnapshotCollection({
            machineDoctorSnapshotTargets: [target],
            enabled: false,
        }));

        await act(async () => {
            await hook.getCurrent().fetchMachineDoctorSnapshotForTarget(target);
        });

        expect(hook.getCurrent().readMachineDoctorSnapshotState(target)).toEqual({
            status: 'error',
            detail: 'common.unavailable',
        });

        writeCachedMachineDoctorSnapshot({
            serverId: 'srv_a',
            machineId: 'machine_1',
            cachedAt: 333,
            snapshot: {
                capturedAt: '2026-04-07T10:11:14.000Z',
                server: {
                    activeServerId: 'srv_a',
                    serverUrl: 'https://srv-a.example.test',
                    publicServerUrl: 'https://srv-a.example.test',
                    webappUrl: 'https://srv-a.example.test',
                },
                accountId: 'acct_1',
                settings: {
                    activeServerId: 'srv_a',
                    servers: [],
                    knownAccountIds: ['acct_1'],
                },
            },
        });

        await act(async () => {
            hook.getCurrent().seedCachedMachineDoctorSnapshots();
        });
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(hook.getCurrent().readMachineDoctorSnapshotState(target)).toEqual(expect.objectContaining({
            status: 'ready',
            cachedAt: 333,
            source: 'cache',
        }));
    });

    it('keeps a cached ready snapshot visible while a refetch is still in flight', async () => {
        const { useMachineDoctorSnapshotCollection } = await import('./useMachineDoctorSnapshotCollection');
        const target = { machineId: 'machine_1', serverId: 'srv_a' } as const;

        writeCachedMachineDoctorSnapshot({
            serverId: 'srv_a',
            machineId: 'machine_1',
            cachedAt: 444,
            snapshot: {
                capturedAt: '2026-04-07T10:11:15.000Z',
                server: {
                    activeServerId: 'srv_a',
                    serverUrl: 'https://srv-a.example.test',
                    publicServerUrl: 'https://srv-a.example.test',
                    webappUrl: 'https://srv-a.example.test',
                },
                accountId: 'acct_1',
                settings: {
                    activeServerId: 'srv_a',
                    servers: [],
                    knownAccountIds: ['acct_1'],
                },
            },
        });

        let resolveDiagnostics: ((value: unknown) => void) | null = null;
        const pendingDiagnostics = new Promise((resolve) => {
            resolveDiagnostics = resolve;
        });
        machineCollectBugReportDiagnosticsMock.mockReturnValueOnce(pendingDiagnostics);

        const hook = await renderHook(() => useMachineDoctorSnapshotCollection({
            machineDoctorSnapshotTargets: [target],
            enabled: false,
        }));

        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(hook.getCurrent().readMachineDoctorSnapshotState(target)).toEqual(expect.objectContaining({
            status: 'ready',
            cachedAt: 444,
            source: 'cache',
        }));

        await act(async () => {
            void hook.getCurrent().fetchMachineDoctorSnapshotForTarget(target);
            await Promise.resolve();
        });
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(hook.getCurrent().readMachineDoctorSnapshotState(target)).toEqual(expect.objectContaining({
            status: 'ready',
            cachedAt: 444,
            source: 'cache',
        }));

        await act(async () => {
            resolveDiagnostics?.(null);
            await pendingDiagnostics;
        });
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(hook.getCurrent().readMachineDoctorSnapshotState(target)).toEqual(expect.objectContaining({
            status: 'ready',
            cachedAt: 444,
            source: 'cache',
        }));
    });
});
