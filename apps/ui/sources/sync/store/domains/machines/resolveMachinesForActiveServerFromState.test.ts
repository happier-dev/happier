import { beforeEach, describe, expect, it } from 'vitest';
import { adoptHomeProfile, setActiveServerId } from '@/sync/domains/server/serverProfiles';

import type { Machine } from '@/sync/domains/state/storageTypes';

let homeId: string;
const identity = 'srv_active_inventory_owner';

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
    it('excludes temporary computers from selection while preserving exact lookup', async () => {
        const selectors = await import('./resolveMachinesForActiveServerFromState');
        const persistent = createMachine({ id: 'persistent' });
        const temporary = { ...createMachine({ id: 'temporary' }), kind: 'ephemeral_session_runner' as const };
        const state = { machineListByServerId: { [homeId]: [persistent, temporary] } };

        expect(selectors.resolveVisibleMachinesForActiveServerFromState(state)).toEqual([persistent]);
        expect(selectors.resolveMachineForActiveServerFromState(state, temporary.id)).toBe(temporary);
    });

    beforeEach(async () => {
        const profile = await adoptHomeProfile({ descriptor: {
            v: 1, homeServerIdentityId: identity, canonicalServerUrl: 'https://active-inventory-owner.example.test',
            revision: 1, endpoints: [{ kind: 'https', url: 'https://active-inventory-owner.example.test' }],
        }, source: 'manual' });
        homeId = profile.id;
        expect(homeId).not.toBe(identity);
        await setActiveServerId(homeId);
    });

    it('resolves a single visible machine for the active server by trimmed id', async () => {
        const selectors = await import('./resolveMachinesForActiveServerFromState');
        const state = {
            machineListByServerId: {
                [homeId]: [
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
                [homeId]: [
                    createMachine({ id: 'machine-a', revokedAt: 10 }),
                ],
            },
        };

        expect(selectors.resolveMachineForActiveServerFromState(state, 'machine-a')).toBeNull();
        expect(selectors.resolveMachineForActiveServerFromState(state, 'missing')).toBeNull();
    });

    it('does not leak a stale global machine when the active server inventory has settled empty', async () => {
        const selectors = await import('./resolveMachinesForActiveServerFromState');
        const state = {
            machines: {
                'machine-stale': createMachine({ id: 'machine-stale', createdAt: 99 }),
            },
            machineListByServerId: {
                [homeId]: [],
                'server-b': [
                    createMachine({ id: 'machine-b', createdAt: 20 }),
                ],
            },
            machineListStatusByServerId: { [homeId]: 'idle' as const },
        };

        expect(selectors.resolveMachineForActiveServerFromState(state, 'machine-stale')).toBeNull();
        expect(selectors.resolveVisibleMachinesForActiveServerFromState(state)).toEqual([]);
    });

    it('uses an equivalent scoped machine cache when active server id is an alias', async () => {
        const selectors = await import('./resolveMachinesForActiveServerFromState');
        const machine = createMachine({ id: 'machine-relay', createdAt: 10 });
        const state = {
            machines: {},
            machineListByServerId: {
                [homeId]: [],
                [identity]: [machine],
            },
        };

        expect(selectors.resolveMachineForActiveServerFromState(state, 'machine-relay')).toMatchObject({
            id: 'machine-relay',
        });
        expect(selectors.resolveVisibleMachinesForActiveServerFromState(state)).toEqual([machine]);
    });
    it.each([true, false])('uses canonical settled absence/rows for active lookup and launch lists, contains machine = %s', async (containsMachine) => {
        const selectors = await import('./resolveMachinesForActiveServerFromState');
        const machine = createMachine({ id: 'machine-conflict' });
        const state = {
            machines: { [machine.id]: machine },
            machineListByServerId: { [identity]: containsMachine ? [machine] : [], [homeId]: containsMachine ? [] : [machine] },
            machineListStatusByServerId: { [identity]: 'idle' as const, [homeId]: 'idle' as const },
        };
        for (const serverId of [identity, homeId]) {
            expect(selectors.resolveMachineForActiveServerFromState(state, machine.id, { serverId })).toBe(containsMachine ? machine : null);
            expect(selectors.resolveVisibleMachinesForActiveServerFromState(state, { serverId })).toEqual(containsMachine ? [machine] : []);
        }
    });

    it('does not borrow the active inventory for an explicit foreign Home scope', async () => {
        const selectors = await import('./resolveMachinesForActiveServerFromState');
        const machine = createMachine({ id: 'machine-active' });
        expect(selectors.resolveVisibleMachinesForActiveServerFromState({
            machines: { [machine.id]: machine }, machineListByServerId: { 'foreign-home': null },
            machineListStatusByServerId: { 'foreign-home': 'loading' },
        }, { serverId: 'foreign-home' })).toEqual([]);
    });
});
