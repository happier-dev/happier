import { describe, expect, it, beforeEach, vi } from 'vitest';

import {
    clearCachedMachineDoctorSnapshot,
    readCachedMachineDoctorSnapshot,
    writeCachedMachineDoctorSnapshot,
} from './machineDoctorSnapshotCache';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';

const machineCollectBugReportDiagnosticsMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/machines', () => ({
    machineCollectBugReportDiagnostics: machineCollectBugReportDiagnosticsMock,
}));

const textMock = createTextModuleMock({ translate: (key: string) => key });
vi.mock('@/text', () => textMock);

describe('machine doctor snapshot helpers', () => {
    beforeEach(() => {
        machineCollectBugReportDiagnosticsMock.mockReset();
        clearCachedMachineDoctorSnapshot({ serverId: 'srv_1', machineId: 'machine_1' });
        clearCachedMachineDoctorSnapshot({ serverId: 'srv_1', machineId: 'machine_2' });
        clearCachedMachineDoctorSnapshot({ serverId: 'srv_2', machineId: 'machine_1' });
    });

    it('reads cached snapshots and seeds ready state from cache', async () => {
        const {
            buildMachineDoctorSnapshotCollectionKey,
            readMachineDoctorSnapshot,
            seedMachineDoctorSnapshotState,
        } = await import('./readMachineDoctorSnapshot');

        writeCachedMachineDoctorSnapshot({
            serverId: 'srv_1',
            machineId: 'machine_1',
            cachedAt: 123,
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

        const cached = readMachineDoctorSnapshot({ serverId: 'srv_1', machineId: 'machine_1' });
        expect(cached).not.toBeNull();
        expect(cached?.cachedAt).toBe(123);
        expect(cached?.snapshot.server.serverUrl).toBe('https://api.happier.dev');

        const seeded = seedMachineDoctorSnapshotState([
            {
                key: buildMachineDoctorSnapshotCollectionKey({ serverId: 'srv_1', machineId: 'machine_1' }),
                serverId: 'srv_1',
                machineId: 'machine_1',
            },
            {
                key: buildMachineDoctorSnapshotCollectionKey({ serverId: 'srv_1', machineId: 'machine_2' }),
                serverId: 'srv_1',
                machineId: 'machine_2',
            },
        ]);
        expect(seeded).toEqual({
            [buildMachineDoctorSnapshotCollectionKey({ serverId: 'srv_1', machineId: 'machine_1' })]: {
                status: 'ready',
                cachedAt: 123,
                source: 'cache',
                snapshot: expect.objectContaining({
                    server: expect.objectContaining({
                        serverUrl: 'https://api.happier.dev',
                    }),
                }),
            },
        });
    });

    it('keeps cached snapshots distinct when the same machine id exists on multiple servers', async () => {
        const {
            buildMachineDoctorSnapshotCollectionKey,
            seedMachineDoctorSnapshotState,
        } = await import('./readMachineDoctorSnapshot');

        writeCachedMachineDoctorSnapshot({
            serverId: 'srv_1',
            machineId: 'machine_1',
            cachedAt: 123,
            snapshot: {
                capturedAt: '2026-02-23T00:00:00.000Z',
                server: {
                    activeServerId: 'srv_1',
                    serverUrl: 'https://api.happier.dev/',
                    publicServerUrl: 'https://api.happier.dev/',
                    webappUrl: 'https://app.happier.dev/',
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
            cachedAt: 456,
            snapshot: {
                capturedAt: '2026-02-23T00:00:00.000Z',
                server: {
                    activeServerId: 'srv_2',
                    serverUrl: 'https://api-b.happier.dev/',
                    publicServerUrl: 'https://api-b.happier.dev/',
                    webappUrl: 'https://app-b.happier.dev/',
                },
                accountId: 'acct_b',
                settings: {
                    activeServerId: 'srv_2',
                    servers: [],
                    knownAccountIds: ['acct_b'],
                },
            },
        });

        const seeded = seedMachineDoctorSnapshotState([
            {
                key: buildMachineDoctorSnapshotCollectionKey({ serverId: 'srv_1', machineId: 'machine_1' }),
                serverId: 'srv_1',
                machineId: 'machine_1',
            },
            {
                key: buildMachineDoctorSnapshotCollectionKey({ serverId: 'srv_2', machineId: 'machine_1' }),
                serverId: 'srv_2',
                machineId: 'machine_1',
            },
        ]);

        expect(seeded).toEqual({
            [buildMachineDoctorSnapshotCollectionKey({ serverId: 'srv_1', machineId: 'machine_1' })]: expect.objectContaining({
                cachedAt: 123,
                snapshot: expect.objectContaining({
                    server: expect.objectContaining({ serverUrl: 'https://api.happier.dev' }),
                }),
            }),
            [buildMachineDoctorSnapshotCollectionKey({ serverId: 'srv_2', machineId: 'machine_1' })]: expect.objectContaining({
                cachedAt: 456,
                snapshot: expect.objectContaining({
                    server: expect.objectContaining({ serverUrl: 'https://api-b.happier.dev' }),
                }),
            }),
        });
    });

    it('fetches a doctor snapshot, sanitizes it, and stores it in cache', async () => {
        const { fetchMachineDoctorSnapshot } = await import('./readMachineDoctorSnapshot');

        machineCollectBugReportDiagnosticsMock.mockResolvedValue({
            doctorSnapshot: {
                capturedAt: '2026-02-23T00:00:00.000Z',
                server: {
                    activeServerId: 'cloud',
                    serverUrl: 'https://api.happier.dev/?token=secret',
                    publicServerUrl: 'https://api.happier.dev/?token=secret',
                    webappUrl: 'https://app.happier.dev/?token=secret',
                },
                accountId: 'acct_1',
                settings: {
                    activeServerId: 'cloud',
                    servers: [
                        {
                            id: 'cloud',
                            name: 'Happier Cloud',
                            serverUrl: 'https://api.happier.dev/?token=secret',
                            webappUrl: 'https://app.happier.dev/?token=secret',
                            createdAt: 0,
                            updatedAt: 0,
                            lastUsedAt: 0,
                        },
                    ],
                    knownAccountIds: ['acct_1'],
                },
            },
        });

        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(456);
        const result = await fetchMachineDoctorSnapshot({ machineId: 'machine_1', serverId: 'srv_1', timeoutMs: 4_000 });
        nowSpy.mockRestore();

        expect(machineCollectBugReportDiagnosticsMock).toHaveBeenCalledWith('machine_1', {
            timeoutMs: 4_000,
            serverId: 'srv_1',
        });
        expect(result).toEqual({
            status: 'ready',
            cachedAt: 456,
            source: 'rpc',
            snapshot: expect.objectContaining({
                server: expect.objectContaining({
                    serverUrl: 'https://api.happier.dev',
                }),
            }),
        });

        const cached = readCachedMachineDoctorSnapshot({ serverId: 'srv_1', machineId: 'machine_1' });
        expect(cached?.cachedAt).toBe(456);
        expect(cached?.snapshot.server.serverUrl).toBe('https://api.happier.dev');
    });

    it('returns an error and leaves cache empty for invalid doctor snapshots', async () => {
        const { fetchMachineDoctorSnapshot } = await import('./readMachineDoctorSnapshot');

        machineCollectBugReportDiagnosticsMock.mockResolvedValue({
            doctorSnapshot: { invalid: true },
        });

        const result = await fetchMachineDoctorSnapshot({ machineId: 'machine_1', serverId: 'srv_1', timeoutMs: 4_000 });

        expect(result).toEqual({
            status: 'error',
            detail: 'systemStatus.machine.fetchDoctorSnapshot.invalid',
        });
        expect(readCachedMachineDoctorSnapshot({ serverId: 'srv_1', machineId: 'machine_1' })).toBeNull();
    });

    it('returns unavailable when diagnostics transport fails before a snapshot is returned', async () => {
        const { fetchMachineDoctorSnapshot } = await import('./readMachineDoctorSnapshot');

        machineCollectBugReportDiagnosticsMock.mockResolvedValue(null);

        const result = await fetchMachineDoctorSnapshot({ machineId: 'machine_1', serverId: 'srv_1', timeoutMs: 4_000 });

        expect(result).toEqual({
            status: 'error',
            detail: 'common.unavailable',
        });
        expect(readCachedMachineDoctorSnapshot({ serverId: 'srv_1', machineId: 'machine_1' })).toBeNull();
    });

    it('reuses the cached snapshot when rpc returns no usable doctor snapshot', async () => {
        const { fetchMachineDoctorSnapshot } = await import('./readMachineDoctorSnapshot');

        writeCachedMachineDoctorSnapshot({
            serverId: 'srv_1',
            machineId: 'machine_1',
            cachedAt: 789,
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
                    servers: [],
                    knownAccountIds: ['acct_1'],
                },
            },
        });
        machineCollectBugReportDiagnosticsMock.mockResolvedValue(null);

        await expect(fetchMachineDoctorSnapshot({
            machineId: 'machine_1',
            serverId: 'srv_1',
            timeoutMs: 4_000,
        })).resolves.toEqual({
            status: 'ready',
            cachedAt: 789,
            source: 'cache',
            snapshot: expect.objectContaining({
                server: expect.objectContaining({
                    serverUrl: 'https://api.happier.dev',
                }),
            }),
        });
    });
});
