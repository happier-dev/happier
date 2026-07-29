import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Machine } from '@/sync/domains/state/storageTypes';

const getActiveServerSnapshotMock = vi.hoisted(() => vi.fn(() => ({ serverId: 'server-a' })));
const areServerProfileIdentifiersEquivalentMock = vi.hoisted(() => vi.fn((left: string | null | undefined, right: string | null | undefined) => left === right));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => getActiveServerSnapshotMock(),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    areServerProfileIdentifiersEquivalent: (
        left: string | null | undefined,
        right: string | null | undefined,
    ) => areServerProfileIdentifiersEquivalentMock(left, right),
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
        areServerProfileIdentifiersEquivalentMock.mockImplementation((left, right) => left === right);
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

    it('uses an equivalent scoped machine cache when active server id is an alias', async () => {
        getActiveServerSnapshotMock.mockReturnValue({ serverId: 'localhost-49598' });
        areServerProfileIdentifiersEquivalentMock.mockImplementation((left, right) => {
            const ids = new Set([left, right]);
            return ids.has('localhost-49598') && ids.has('srv_local_relay');
        });

        const selectors = await import('./resolveMachinesForActiveServerFromState');
        const machine = createMachine({ id: 'machine-relay', createdAt: 10 });
        const state = {
            machines: {},
            machineListByServerId: {
                'localhost-49598': [],
                srv_local_relay: [machine],
            },
        };

        expect(selectors.resolveMachineForActiveServerFromState(state, 'machine-relay')).toMatchObject({
            id: 'machine-relay',
        });
        expect(selectors.resolveVisibleMachinesForActiveServerFromState(state)).toEqual([machine]);
    });
});
