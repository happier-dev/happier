import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';

import { createMachinePoolsDomain, type MachinePoolsDomain } from './machinePools';

const POOL_ID = '00000000-0000-4000-8000-000000000001';
const scope = (serverId: string, accountId = 'account-a') => ({ sourceServerId: serverId, sourceAccountId: accountId });
const view = (name: string, revision: number) => ({
    pool: { id: POOL_ID, name, description: null, revision, createdAt: 1, updatedAt: revision, members: [] },
    availability: { state: 'known' as const, connectedCount: 0, enabledCount: 0 },
});

const viewWithMemberState = (state: 'connected' | 'offline') => ({
    pool: {
        id: POOL_ID,
        name: 'A',
        description: null,
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        members: [{ machineId: 'machine-a', priorityTier: 0, enabled: true, state }],
    },
    availability: { state: 'known' as const, connectedCount: state === 'connected' ? 1 : 0, enabledCount: 1 },
});

function harness() {
    const store = createStore<MachinePoolsDomain>()((set, get) => createMachinePoolsDomain({ set, get }));
    return { domain: store.getState(), get: store.getState, subscribe: store.subscribe };
}

describe('machine pool store domain', () => {
    it('does not notify subscribers for identical ready snapshots, including an empty list', () => {
        for (const pools of [[], [view('A', 1)]]) {
            const { domain, get, subscribe } = harness();
            domain.beginMachinePoolAccountScope('home-a', 'account-a');
            domain.replaceMachinePools(pools, scope('home-a'));
            const before = get();
            let notifications = 0;
            const unsubscribe = subscribe(() => notifications++);

            domain.replaceMachinePools(structuredClone(pools), { ...scope('home-a'), baseline: before.machinePoolListByServerId['home-a']! });
            domain.replaceMachinePools(structuredClone(pools), scope('home-a'));

            unsubscribe();
            expect(notifications).toBe(0);
            expect(get()).toBe(before);
        }
    });

    it('retains unchanged pool rows while settling a refresh with changed availability', () => {
        const { domain, get, subscribe } = harness();
        domain.beginMachinePoolAccountScope('home-a', 'account-a');
        const unchanged = { ...view('B', 1), pool: { ...view('B', 1).pool, id: 'pool-b' } };
        domain.replaceMachinePools([viewWithMemberState('connected'), unchanged], scope('home-a'));
        const before = get();
        domain.setMachinePoolListStatus('home-a', 'loading');
        let notifications = 0;
        const unsubscribe = subscribe(() => notifications++);

        domain.replaceMachinePools([viewWithMemberState('offline'), structuredClone(unchanged)], scope('home-a'));

        unsubscribe();
        expect(notifications).toBe(1);
        expect(get().machinePoolListStatusByServerId['home-a']).toBe('idle');
        expect(get().machinePoolListByServerId['home-a']?.[0]?.pool.members[0]?.state).toBe('offline');
        expect(get().machinePoolListByServerId['home-a']?.[1]).toBe(before.machinePoolListByServerId['home-a']?.[1]);
    });

    it('retires rows when the same Home begins serving a different Account', () => {
        const { domain, get } = harness();
        const scoped = domain as typeof domain & {
            beginMachinePoolAccountScope(serverId: string, accountId: string): void;
        };

        scoped.beginMachinePoolAccountScope('home-a', 'alice');
        domain.replaceMachinePools([view('Alice private pool', 1)], scope('home-a', 'alice'));
        domain.setMachinePoolListStatus('home-a', 'signedOut');

        scoped.beginMachinePoolAccountScope('home-a', 'bob');

        expect(get().machinePoolListByServerId['home-a']).toBeUndefined();
        expect(get().machinePoolListStatusByServerId['home-a']).toBeUndefined();
        expect(get().machinePoolAccountIdByServerId['home-a']).toBe('bob');
    });

    it('does not attribute an unscoped retained projection to the first observed Account', () => {
        const { domain, get } = harness();
        domain.setMachinePoolListStatus('home-a', 'signedOut');
        get().machinePoolListByServerId['home-a'] = [view('Unknown owner', 1)];

        domain.beginMachinePoolAccountScope('home-a', 'alice');

        expect(get().machinePoolListByServerId['home-a']).toBeUndefined();
        expect(get().machinePoolListStatusByServerId['home-a']).toBeUndefined();
        expect(get().machinePoolAccountIdByServerId['home-a']).toBe('alice');
    });

    it('keeps hydrated rows while refresh is pending and patches only the owning Home', () => {
        const { domain, get } = harness();
        domain.beginMachinePoolAccountScope('home-a', 'account-a');
        domain.beginMachinePoolAccountScope('home-b', 'account-a');
        domain.replaceMachinePools([view('A', 1)], scope('home-a'));
        const retained = get().machinePoolListByServerId['home-a'];
        domain.setMachinePoolListStatus('home-a', 'loading');
        expect(get().machinePoolListByServerId['home-a']).toBe(retained);

        domain.patchMachinePool(view('A2', 2), scope('home-a'));
        domain.replaceMachinePools([view('B', 1)], scope('home-b'));
        expect(get().machinePoolListByServerId['home-a']?.[0]?.pool.name).toBe('A2');
        expect(get().machinePoolListByServerId['home-b']?.[0]?.pool.name).toBe('B');
    });

    it('ignores an older revision and removes by Home-qualified identity', () => {
        const { domain, get } = harness();
        domain.beginMachinePoolAccountScope('home-a', 'account-a');
        domain.replaceMachinePools([view('New', 3)], scope('home-a'));
        domain.patchMachinePool(view('Old', 2), scope('home-a'));
        expect(get().machinePoolListByServerId['home-a']?.[0]?.pool.name).toBe('New');
        domain.removeMachinePool(POOL_ID, scope('home-a'));
        expect(get().machinePoolListByServerId['home-a']).toEqual([]);
    });

    it('refreshes member observations even when the saved revision is unchanged', () => {
        const { domain, get } = harness();
        domain.beginMachinePoolAccountScope('home-a', 'account-a');
        domain.replaceMachinePools([viewWithMemberState('connected')], scope('home-a'));
        domain.replaceMachinePools([viewWithMemberState('offline')], scope('home-a'));

        expect(get().machinePoolListByServerId['home-a']?.[0]?.pool.members[0]?.state).toBe('offline');
    });

    it('does not let a list response started before a local update replace the newer revision', () => {
        const { domain, get } = harness();
        domain.beginMachinePoolAccountScope('home-a', 'account-a');
        domain.replaceMachinePools([view('Before', 1)], scope('home-a'));
        const baseline = get().machinePoolListByServerId['home-a'];
        domain.patchMachinePool(view('After', 2), scope('home-a'));

        domain.replaceMachinePools([view('Before', 1)], { ...scope('home-a'), baseline });

        expect(get().machinePoolListByServerId['home-a']?.[0]?.pool.name).toBe('After');
    });

    it('preserves a local create and delete across an older in-flight list response', () => {
        const { domain, get } = harness();
        domain.beginMachinePoolAccountScope('home-a', 'account-a');
        domain.replaceMachinePools([view('Existing', 1)], scope('home-a'));
        const baseline = get().machinePoolListByServerId['home-a'];
        domain.removeMachinePool(POOL_ID, scope('home-a'));
        const created = {
            ...view('Created', 1),
            pool: { ...view('Created', 1).pool, id: '00000000-0000-4000-8000-000000000002' },
        };
        domain.patchMachinePool(created, scope('home-a'));

        domain.replaceMachinePools([view('Existing', 1)], { ...scope('home-a'), baseline });

        expect(get().machinePoolListByServerId['home-a']).toEqual([created]);
    });

    it('keeps the server order stable across refresh, update, create and delete', () => {
        const { domain, get } = harness();
        domain.beginMachinePoolAccountScope('home-a', 'account-a');
        const named = (id: string, name: string, revision = 1) => ({
            pool: { id, name, description: null, revision, createdAt: 1, updatedAt: revision, members: [] },
            availability: { state: 'known' as const, connectedCount: 0, enabledCount: 0 },
        });
        const ids = () => get().machinePoolListByServerId['home-a']?.map((item) => item.pool.id);
        const zulu = named('id-1', 'Zulu');
        const alpha = named('id-2', 'Alpha');

        domain.replaceMachinePools([zulu, alpha], scope('home-a'));
        expect(ids()).toEqual(['id-1', 'id-2']);

        // A background refresh returning the same server order must not reorder rows under the user.
        const baseline = get().machinePoolListByServerId['home-a'];
        domain.replaceMachinePools([zulu, alpha], { ...scope('home-a'), baseline });
        expect(ids()).toEqual(['id-1', 'id-2']);

        domain.patchMachinePool(named('id-1', 'Zulu renamed', 2), scope('home-a'));
        expect(ids()).toEqual(['id-1', 'id-2']);

        domain.patchMachinePool(named('id-3', 'Beta'), scope('home-a'));
        expect(ids()).toEqual(['id-1', 'id-2', 'id-3']);

        domain.removeMachinePool('id-1', scope('home-a'));
        expect(ids()).toEqual(['id-2', 'id-3']);
    });

    it('retires one Home pool projection without clearing other Homes', () => {
        const { domain, get } = harness();
        domain.beginMachinePoolAccountScope('home-a', 'account-a');
        domain.beginMachinePoolAccountScope('home-b', 'account-a');
        domain.replaceMachinePools([view('A', 1)], scope('home-a'));
        domain.replaceMachinePools([view('B', 1)], scope('home-b'));

        domain.clearMachinePoolsForServer('home-a');

        expect(get().machinePoolListByServerId['home-a']).toBeUndefined();
        expect(get().machinePoolListStatusByServerId['home-a']).toBeUndefined();
        expect(get().machinePoolListByServerId['home-b']?.[0]?.pool.name).toBe('B');
    });
});
