import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Machine } from '@/sync/domains/state/storageTypes';

const getActiveServerSnapshotMock = vi.hoisted(() => vi.fn(() => ({ serverId: 'server-a' })));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => getActiveServerSnapshotMock(),
}));

function createMachine(input: Readonly<{
    id: string;
    active?: boolean;
    createdAt?: number;
    revokedAt?: number | null;
}>): Machine {
    return {
        id: input.id,
        seq: 1,
        createdAt: input.createdAt ?? 1,
        updatedAt: input.createdAt ?? 1,
        active: input.active ?? true,
        activeAt: input.active === false ? 0 : 1,
        revokedAt: input.revokedAt ?? null,
        metadata: null,
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
    };
}

describe('resolveMachinesForActiveServerFromState', () => {
    beforeEach(() => {
        getActiveServerSnapshotMock.mockReturnValue({ serverId: 'server-a' });
    });

    it('resolves a single visible machine for the active server by trimmed id', async () => {
        const selectors = await import('./resolveMachinesForActiveServerFromState');
        const state = {
            machineListByServerId: {
                'server-a': [
                    createMachine({ id: 'machine-a', createdAt: 10 }),
                    createMachine({ id: 'machine-b', createdAt: 20 }),
                ],
            },
        };

        expect(typeof selectors.resolveMachineForActiveServerFromState).toBe('function');
        expect(selectors.resolveMachineForActiveServerFromState(state, '  machine-b  ')).toMatchObject({
            id: 'machine-b',
        });
    });

    it('returns null for revoked or missing machines', async () => {
        const selectors = await import('./resolveMachinesForActiveServerFromState');
        const state = {
            machineListByServerId: {
                'server-a': [
                    createMachine({ id: 'machine-a', revokedAt: 10 }),
                ],
            },
        };

        expect(selectors.resolveMachineForActiveServerFromState(state, 'machine-a')).toBeNull();
        expect(selectors.resolveMachineForActiveServerFromState(state, 'missing')).toBeNull();
    });

    it('does not leak a stale global machine when the active server cache is empty during bootstrap', async () => {
        const selectors = await import('./resolveMachinesForActiveServerFromState');
        const state = {
            machines: {
                'machine-stale': createMachine({ id: 'machine-stale', createdAt: 99 }),
            },
            machineListByServerId: {
                'server-a': [],
                'server-b': [
                    createMachine({ id: 'machine-b', createdAt: 20 }),
                ],
            },
        };

        expect(selectors.resolveMachineForActiveServerFromState(state, 'machine-stale')).toBeNull();
        expect(selectors.resolveVisibleMachinesForActiveServerFromState(state)).toEqual([]);
    });
});
