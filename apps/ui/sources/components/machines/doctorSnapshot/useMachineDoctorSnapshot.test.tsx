import { describe, expect, it, beforeEach, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { clearCachedMachineDoctorSnapshot, writeCachedMachineDoctorSnapshot } from './machineDoctorSnapshotCache';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';

const machineCollectBugReportDiagnosticsMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/machines', () => ({
    machineCollectBugReportDiagnostics: machineCollectBugReportDiagnosticsMock,
}));

const textMock = createTextModuleMock({ translate: (key: string) => key });
vi.mock('@/text', () => textMock);

describe('useMachineDoctorSnapshot', () => {
    beforeEach(() => {
        machineCollectBugReportDiagnosticsMock.mockReset();
        clearCachedMachineDoctorSnapshot({ serverId: 'srv_1', machineId: 'machine_1' });
        clearCachedMachineDoctorSnapshot({ serverId: 'srv_2', machineId: 'machine_1' });
    });

    it('returns stable read, seed, and fetch helpers across rerenders', async () => {
        const { useMachineDoctorSnapshot } = await import('./useMachineDoctorSnapshot');
        const hook = await renderHook(() => useMachineDoctorSnapshot());

        const first = hook.getCurrent();
        await hook.rerender();
        const second = hook.getCurrent();

        expect(first.readMachineDoctorSnapshot).toBe(second.readMachineDoctorSnapshot);
        expect(first.seedMachineDoctorSnapshotState).toBe(second.seedMachineDoctorSnapshotState);
        expect(first.fetchMachineDoctorSnapshot).toBe(second.fetchMachineDoctorSnapshot);
    });

    it('can seed cached snapshots through the shared helpers', async () => {
        const { useMachineDoctorSnapshot } = await import('./useMachineDoctorSnapshot');

        writeCachedMachineDoctorSnapshot({
            serverId: 'srv_1',
            machineId: 'machine_1',
            cachedAt: 987,
            snapshot: {
                capturedAt: '2026-02-23T00:00:00.000Z',
                server: {
                    activeServerId: 'cloud',
                    serverUrl: 'https://api.happier.dev/',
                    publicServerUrl: 'https://api.happier.dev/',
                    webappUrl: 'https://app.happier.dev/',
                },
                accountId: 'acct_1',
                settings: {
                    activeServerId: 'cloud',
                    servers: [
                        {
                            id: 'cloud',
                            name: 'Happier Cloud',
                            serverUrl: 'https://api.happier.dev/',
                            webappUrl: 'https://app.happier.dev/',
                            createdAt: 0,
                            updatedAt: 0,
                            lastUsedAt: 0,
                        },
                    ],
                    knownAccountIds: ['acct_1'],
                },
            },
        });

        const hook = await renderHook(() => useMachineDoctorSnapshot());
        const seeded = hook.getCurrent().seedMachineDoctorSnapshotState([
            { machineId: 'machine_1', serverId: 'srv_1' },
        ]);

        expect(seeded.srv_1__machine_1).toEqual(expect.objectContaining({
            status: 'ready',
            cachedAt: 987,
            source: 'cache',
        }));
    });

    it('seeds cached snapshots independently when the same machine id exists on multiple servers', async () => {
        const { useMachineDoctorSnapshot } = await import('./useMachineDoctorSnapshot');

        writeCachedMachineDoctorSnapshot({
            serverId: 'srv_1',
            machineId: 'machine_1',
            cachedAt: 111,
            snapshot: {
                capturedAt: '2026-02-23T00:00:00.000Z',
                server: {
                    activeServerId: 'srv_1',
                    serverUrl: 'https://srv-1.example.test/',
                    publicServerUrl: 'https://srv-1.example.test/',
                    webappUrl: 'https://app.example.test/',
                },
                accountId: 'acct_1',
                settings: {
                    activeServerId: 'srv_1',
                    servers: [],
                    knownAccountIds: ['acct_1'],
                },
            },
        });
        writeCachedMachineDoctorSnapshot({
            serverId: 'srv_2',
            machineId: 'machine_1',
            cachedAt: 222,
            snapshot: {
                capturedAt: '2026-02-23T00:00:00.000Z',
                server: {
                    activeServerId: 'srv_2',
                    serverUrl: 'https://srv-2.example.test/',
                    publicServerUrl: 'https://srv-2.example.test/',
                    webappUrl: 'https://app.example.test/',
                },
                accountId: 'acct_2',
                settings: {
                    activeServerId: 'srv_2',
                    servers: [],
                    knownAccountIds: ['acct_2'],
                },
            },
        });

        const hook = await renderHook(() => useMachineDoctorSnapshot());
        const seeded = hook.getCurrent().seedMachineDoctorSnapshotState([
            { machineId: 'machine_1', serverId: 'srv_1' },
            { machineId: 'machine_1', serverId: 'srv_2' },
        ]);

        expect(seeded.srv_1__machine_1).toEqual(expect.objectContaining({
            status: 'ready',
            cachedAt: 111,
            snapshot: expect.objectContaining({
                accountId: 'acct_1',
            }),
        }));
        expect(seeded.srv_2__machine_1).toEqual(expect.objectContaining({
            status: 'ready',
            cachedAt: 222,
            snapshot: expect.objectContaining({
                accountId: 'acct_2',
            }),
        }));
    });
});
