import { describe, expect, it, vi } from 'vitest';

let activeServerId = 'server-a';

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: activeServerId, serverUrl: `https://${activeServerId}.example.test`, generation: 1 }),
}));

describe('resolveMachinesForActiveServerFromState', () => {
    it('returns an empty active server list instead of falling back to global machines', async () => {
        activeServerId = 'server-b';
        const { resolveVisibleMachinesForActiveServerFromState } = await import('./resolveMachinesForActiveServerFromState');

        const machines = resolveVisibleMachinesForActiveServerFromState({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    active: true,
                    createdAt: 1,
                    revokedAt: null,
                },
            },
            machineListByServerId: {
                'server-b': [],
            },
        });

        expect(machines).toEqual([]);
    });

    it('rejects direct machine lookups outside the active server machine list', async () => {
        activeServerId = 'server-b';
        const { resolveMachineForActiveServerFromState } = await import('./resolveMachinesForActiveServerFromState');

        const machine = resolveMachineForActiveServerFromState({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    active: true,
                    createdAt: 1,
                    revokedAt: null,
                },
            },
            machineListByServerId: {
                'server-b': [{
                    id: 'machine-b',
                    active: true,
                    createdAt: 2,
                    revokedAt: null,
                }],
            },
        }, 'machine-a');

        expect(machine).toBe(null);
    });
});
