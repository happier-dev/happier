import { beforeEach, describe, expect, it, vi } from 'vitest';

const projectionDescribeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    machineContributionRegistryProjectionDescribe: projectionDescribeMock,
}));

function daemonProjection(generation: number) {
    return {
        v: 2 as const,
        generation,
        installedPackagesById: {},
        agentsById: {},
        backendsById: {},
        actionsById: {},
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        settingsById: {},
        familiesById: {},
        diagnostics: [],
    };
}

describe('loadDaemonMergedProjectionCacheEntry', () => {
    beforeEach(async () => {
        projectionDescribeMock.mockReset();
        const { clearDaemonMergedProjectionCacheForTests } = await import('./loadDaemonMergedProjectionInputs');
        clearDaemonMergedProjectionCacheForTests();
    });

    it('retains the last ready projection as inert cached metadata after a transport error', async () => {
        projectionDescribeMock
            .mockResolvedValueOnce({
                supported: true,
                projection: daemonProjection(7),
            })
            .mockResolvedValueOnce({
                supported: false,
                reason: 'error',
            });
        const {
            loadDaemonMergedProjectionCacheEntry,
            readCachedDaemonMergedProjectionCacheEntry,
        } = await import('./loadDaemonMergedProjectionInputs');

        await loadDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-1',
        });
        await loadDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-1',
        });

        expect(readCachedDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-1',
        })).toMatchObject({
            kind: 'error',
            inputs: {
                pluginProjectionV2: {
                    generation: 7,
                },
            },
        });
    });

    it('does not let an older in-flight response replace a newer authoritative generation', async () => {
        let resolveOlder!: (value: unknown) => void;
        let resolveNewer!: (value: unknown) => void;
        projectionDescribeMock
            .mockImplementationOnce(async () => await new Promise((resolve) => {
                resolveOlder = resolve;
            }))
            .mockImplementationOnce(async () => await new Promise((resolve) => {
                resolveNewer = resolve;
            }));
        const {
            loadDaemonMergedProjectionCacheEntry,
            readCachedDaemonMergedProjectionCacheEntry,
        } = await import('./loadDaemonMergedProjectionInputs');

        const older = loadDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-1',
        });
        const newer = loadDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-1',
        });

        resolveNewer({
            supported: true,
            projection: daemonProjection(9),
        });
        await newer;
        resolveOlder({
            supported: true,
            projection: daemonProjection(8),
        });
        await older;

        expect(readCachedDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-1',
        })).toMatchObject({
            kind: 'ready',
            inputs: {
                pluginProjectionV2: {
                    generation: 9,
                },
            },
        });
    });
});
