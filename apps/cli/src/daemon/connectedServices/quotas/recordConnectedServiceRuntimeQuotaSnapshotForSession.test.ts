import { describe, expect, it, vi } from 'vitest';

import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { recordConnectedServiceRuntimeQuotaSnapshotForSession } from './recordConnectedServiceRuntimeQuotaSnapshotForSession';

describe('recordConnectedServiceRuntimeQuotaSnapshotForSession', () => {
    it('records group runtime quota state for the selected group', async () => {
        const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
        const result = await recordConnectedServiceRuntimeQuotaSnapshotForSession({
            getChildren: () => [{
                startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_1',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'group-1',
                                profileId: 'fallback',
                            },
                        },
                    },
                },
            }],
            quotaCoordinator: null,
            runtimeQuotaSnapshots,
            sessionId: 'sess_1',
            serviceId: 'openai-codex',
            snapshot: {
                v: 1,
                serviceId: 'openai-codex',
                profileId: 'primary',
                fetchedAt: 1_000,
                staleAfterMs: 300_000,
                planLabel: null,
                accountLabel: null,
                meters: [],
            },
        });

        expect(result).toEqual({
            status: 'recorded',
            groupRuntimeStateRecorded: true,
            quotaStateRecorded: false,
        });
        expect(runtimeQuotaSnapshots.buildMemberStates({
            serviceId: 'openai-codex',
            groupId: 'group-1',
            capturedAtMs: 1_000,
        }).get('primary')?.quotaSnapshot).toEqual(expect.objectContaining({
            capturedAtMs: 1_000,
        }));
    });

    it('records group runtime quota state before durable quota persistence settles', async () => {
        const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
        let resolvePersistence!: () => void;
        const persistence = new Promise<void>((resolve) => {
            resolvePersistence = resolve;
        });
        const quotaCoordinator = {
            recordInBandQuotaSnapshot: async () => {
                await persistence;
            },
        };
        const run = recordConnectedServiceRuntimeQuotaSnapshotForSession({
            getChildren: () => [{
                startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_1',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'group-1',
                                profileId: 'fallback',
                            },
                        },
                    },
                },
            }],
            quotaCoordinator,
            runtimeQuotaSnapshots,
            sessionId: 'sess_1',
            serviceId: 'openai-codex',
            snapshot: {
                v: 1,
                serviceId: 'openai-codex',
                profileId: 'primary',
                fetchedAt: 1_000,
                staleAfterMs: 300_000,
                planLabel: null,
                accountLabel: null,
                meters: [],
            },
        });

        await Promise.resolve();
        expect(runtimeQuotaSnapshots.buildMemberStates({
            serviceId: 'openai-codex',
            groupId: 'group-1',
            capturedAtMs: 1_000,
        }).get('primary')?.quotaSnapshot).toEqual(expect.objectContaining({
            capturedAtMs: 1_000,
        }));

        resolvePersistence();
        await expect(run).resolves.toEqual({
            status: 'recorded',
            groupRuntimeStateRecorded: true,
            quotaStateRecorded: true,
        });
    });

    it('keeps group runtime quota state when durable quota persistence fails', async () => {
        const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
        const result = await recordConnectedServiceRuntimeQuotaSnapshotForSession({
            getChildren: () => [{
                startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_1',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'group-1',
                                profileId: 'fallback',
                            },
                        },
                    },
                },
            }],
            quotaCoordinator: {
                recordInBandQuotaSnapshot: async () => {
                    throw new Error('server unavailable');
                },
            },
            runtimeQuotaSnapshots,
            sessionId: 'sess_1',
            serviceId: 'openai-codex',
            snapshot: {
                v: 1,
                serviceId: 'openai-codex',
                profileId: 'primary',
                fetchedAt: 1_000,
                staleAfterMs: 300_000,
                planLabel: null,
                accountLabel: null,
                meters: [],
            },
        });

        expect(result).toEqual({
            status: 'recorded',
            groupRuntimeStateRecorded: true,
            quotaStateRecorded: false,
        });
        expect(runtimeQuotaSnapshots.buildMemberStates({
            serviceId: 'openai-codex',
            groupId: 'group-1',
            capturedAtMs: 1_000,
        }).get('primary')?.quotaSnapshot).toEqual(expect.objectContaining({
            capturedAtMs: 1_000,
        }));
    });

    it('rejects snapshots whose embedded service id does not match the write key before runtime or durable writes', async () => {
        const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
        const recordInBandQuotaSnapshot = vi.fn(async () => ({ status: 'enqueued', enqueue: 'accepted' as const }));
        const result = await recordConnectedServiceRuntimeQuotaSnapshotForSession({
            getChildren: () => [{
                startedBy: 'daemon',
                pid: 111,
                happySessionId: 'sess_1',
                spawnOptions: {
                    directory: '/tmp/project',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': {
                                source: 'connected',
                                selection: 'group',
                                groupId: 'group-1',
                                profileId: 'fallback',
                            },
                        },
                    },
                },
            }],
            quotaCoordinator: { recordInBandQuotaSnapshot },
            runtimeQuotaSnapshots,
            sessionId: 'sess_1',
            serviceId: 'openai-codex',
            snapshot: {
                v: 1,
                serviceId: 'openai',
                profileId: 'primary',
                fetchedAt: 1_000,
                staleAfterMs: 300_000,
                planLabel: null,
                accountLabel: null,
                meters: [],
            },
        });

        expect(result).toEqual({ status: 'service_id_mismatch' });
        expect(recordInBandQuotaSnapshot).not.toHaveBeenCalled();
        expect(runtimeQuotaSnapshots.buildMemberStates({
            serviceId: 'openai-codex',
            groupId: 'group-1',
            capturedAtMs: 1_000,
        }).size).toBe(0);
    });
});
