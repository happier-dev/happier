import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';

import { settingsDefaults } from '@/sync/domains/settings/settings';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';
import { createMachinesDomain, type MachinesDomain } from './machines';

type TestState = MachinesDomain & Pick<StorageState,
    'sessions' | 'sessionListRowsByServerId' | 'ordinarySessionListMembershipByServerId'
    | 'sessionListIndexByServerId' | 'settings'
> & { profile: { id: string } };

function createTestStore() {
    return createStore<TestState>()((set, get) => ({
        sessions: {},
        sessionListRowsByServerId: {},
        ordinarySessionListMembershipByServerId: {},
        sessionListIndexByServerId: {},
        settings: settingsDefaults,
        profile: { id: 'machine-stability-account' },
        ...createMachinesDomain<TestState>({ set, get }),
    }));
}

function machine(id: string, overrides: Partial<Machine> = {}): Machine {
    return {
        id, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        metadata: { host: id, platform: 'linux', happyCliVersion: '0.3', happyHomeDir: '/qa', homeDir: '/qa' },
        metadataVersion: 1, daemonState: null, daemonStateVersion: 0,
        ...overrides,
    };
}

describe('machine inventory reference stability through the real store', () => {
    for (const scope of ['active', 'other'] as const) {
        for (const replace of [false, true]) {
            it(`suppresses identical ${replace ? 'full' : 'incremental'} inventories for the ${scope} Home`, () => {
                const store = createTestStore();
                const serverId = scope === 'active' ? getActiveServerSnapshot().serverId : 'machine-stability-other-home';
                const options = { sourceServerId: serverId };
                const machines = [machine('one'), machine('two')];
                store.getState().applyMachines(machines, true, options);
                const before = store.getState();
                let notifications = 0;
                const unsubscribe = store.subscribe(() => notifications++);
                for (let i = 0; i < 3; i++) store.getState().applyMachines(structuredClone(machines), replace, options);
                unsubscribe();
                expect(notifications).toBe(0);
                expect(store.getState()).toBe(before);
            });
        }
    }

    it('reconciles full removals and changed rows while retaining unchanged records and displays', () => {
        const store = createTestStore();
        const options = { sourceServerId: getActiveServerSnapshot().serverId };
        const one = machine('one'), two = machine('two'), removed = machine('removed');
        const temporary = machine('temporary', { kind: 'ephemeral_session_runner' });
        store.getState().applyMachines([one, two, removed, temporary], true, options);
        const before = store.getState();
        let notifications = 0;
        const unsubscribe = store.subscribe(() => notifications++);
        store.getState().applyMachines([
            structuredClone(one),
            machine('two', { active: false, activeAt: 2, updatedAt: 2 }),
        ], true, options);
        unsubscribe();
        const after = store.getState();
        expect(notifications).toBe(1);
        expect(after.machines.one).toBe(before.machines.one);
        expect(after.machineDisplayById.one).toBe(before.machineDisplayById.one);
        expect(after.machines.two?.active).toBe(false);
        expect(after.machines.removed).toBeUndefined();
        expect(after.machines.temporary).toBe(before.machines.temporary);
        expect(after.machineListByServerId[options.sourceServerId!]?.map(row => row.id)).toEqual(['one', 'two', 'temporary']);
    });

    it('suppresses repeated warm-display snapshots and preserves newer presence', () => {
        const store = createTestStore();
        store.getState().applyMachines([machine('one', { activeAt: 3 })], true);
        const before = store.getState();
        const display = structuredClone(before.machineDisplayById.one!);
        let notifications = 0;
        const unsubscribe = store.subscribe(() => notifications++);
        for (let i = 0; i < 3; i++) {
            store.getState().replaceMachineDisplays([{ ...display, active: false, activeAt: 2 }]);
        }
        unsubscribe();
        expect(notifications).toBe(0);
        expect(store.getState()).toBe(before);
    });

    it('retains unaffected display references when a stale snapshot only admits current rows', () => {
        const store = createTestStore();
        store.getState().applyMachines([machine('one'), machine('two')], true);
        const before = store.getState();
        store.getState().replaceMachineDisplays([{ ...before.machineDisplayById.one!, active: false, activeAt: 2 }], { replace: false });
        expect(store.getState().machineDisplayById.two).toBe(before.machineDisplayById.two);
        expect(store.getState().machineDisplayById.one?.active).toBe(false);
    });
});
