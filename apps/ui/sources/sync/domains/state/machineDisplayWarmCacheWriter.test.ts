import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '@/sync/domains/state/storageTypes';

const boundary = vi.hoisted(() => ({
    previous: null as Record<string, unknown> | null,
    schedule: vi.fn(),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    resolveServerProfileScopeIdForIdentifier: (serverId: string) => (
        serverId === 'local-b' || serverId === 'legacy-b' ? 'srv_server_b' : serverId
    ),
}));

vi.mock('./warmCachePersistence', () => ({
    peekMachineDisplayWarmCacheEntries: () => boundary.previous,
    resolveWarmCacheAccountScope: (accountId: string) => accountId,
    scheduleMachineDisplayWarmCacheEntriesSave: (...args: unknown[]) => boundary.schedule(...args),
}));

function machine(input: Readonly<{
    metadata: Machine['metadata'];
    updatedAt: number;
}>): Machine {
    return {
        id: 'machine-b',
        seq: 1,
        createdAt: 1,
        updatedAt: input.updatedAt,
        active: false,
        activeAt: 0,
        revokedAt: 40,
        replacedByMachineId: 'machine-new',
        replacedAt: 41,
        replacementReason: 'rotated',
        metadata: input.metadata,
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
    };
}

describe('scheduleMachineListDisplayWarmCacheSave', () => {
    beforeEach(() => {
        boundary.previous = null;
        boundary.schedule.mockReset();
    });

    it('writes non-active inventories under canonical ServerProfile identity with tombstone facts', async () => {
        const { scheduleMachineListDisplayWarmCacheSave } = await import('./machineDisplayWarmCacheWriter');

        scheduleMachineListDisplayWarmCacheSave({
            serverId: 'local-b',
            accountId: 'account-1',
            machines: [machine({
                metadata: { displayName: 'Server B machine' } as Machine['metadata'],
                updatedAt: 50,
            })],
        });

        expect(boundary.schedule).toHaveBeenCalledWith('srv_server_b', 'account-1', {
            'machine-b': expect.objectContaining({
                machineId: 'machine-b',
                revokedAt: 40,
                replacedByMachineId: 'machine-new',
                replacedAt: 41,
                replacementReason: 'rotated',
                displayName: 'Server B machine',
            }),
        });
    });

    it('uses the pending/saved baseline when a later row is temporarily undecryptable', async () => {
        const { scheduleMachineListDisplayWarmCacheSave } = await import('./machineDisplayWarmCacheWriter');
        boundary.previous = {
            'machine-b': {
                machineId: 'machine-b',
                metadataVersion: 1,
                updatedAt: 40,
                active: false,
                activeAt: 0,
                revokedAt: null,
                displayName: 'Preserved name',
                host: 'b.local',
                homeDir: null,
            },
        };

        scheduleMachineListDisplayWarmCacheSave({
            serverId: 'legacy-b',
            accountId: 'account-1',
            machines: [machine({ metadata: null, updatedAt: 60 })],
        });

        expect(boundary.schedule).toHaveBeenCalledWith('srv_server_b', 'account-1', {
            'machine-b': expect.objectContaining({
                updatedAt: 60,
                displayName: 'Preserved name',
                host: 'b.local',
            }),
        });
    });
});
