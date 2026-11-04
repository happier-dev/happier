import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { act } from 'react';
import { renderHook } from '@/dev/testkit';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

import { settingsDefaults } from '@/sync/domains/settings/settings';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { buildMachineDisplayRenderableFromMachine } from '@/sync/domains/machines/machineDisplayRenderable';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';
import { createMachinesDomain, subscribeMachineUpdates, type MachinesDomain } from './machines';

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
    it('uses the same display publication policy for list snapshots and Machine updates', () => {
        const store = createTestStore();
        const initial = buildMachineDisplayRenderableFromMachine(machine('display', { availability: { kind: 'available' } }));
        store.getState().replaceMachineDisplays([initial]);
        const previous = store.getState();
        const notify = vi.fn();
        const off = store.subscribe(notify);
        try {
            store.getState().replaceMachineDisplays([{ ...structuredClone(initial), updatedAt: 2, activeAt: 2 }]);
            expect(store.getState()).toBe(previous);
            expect(notify).not.toHaveBeenCalled();
            expect(store.getState().machineDisplayById.display.activeAt).toBe(2);
            store.getState().replaceMachineDisplays([{ ...structuredClone(initial), metadataVersion: 2 }]);
            expect(store.getState().machineDisplayById.display.metadata).toBe(initial.metadata);
            expect(store.getState().machineDisplayById.display.availability).toBe(initial.availability);
            expect(notify).toHaveBeenCalledTimes(1);
        } finally { off(); }
    });

    it('retains unchanged Machine slices when daemon resources change and publishes installation changes', () => {
        const store = createTestStore();
        const options = { sourceServerId: getActiveServerSnapshot().serverId };
        const one = machine('one', { installationPublicKey: 'first', daemonStateVersion: 1,
            daemonState: { resources: { activeSessions: 1 } }, availability: { kind: 'available' } });
        store.getState().applyMachines([one], true, options);
        const before = store.getState().machines.one;
        store.getState().applyMachines([{ ...structuredClone(one), daemonStateVersion: 2,
            daemonState: { resources: { activeSessions: 2 } } }], false, options);
        const updated = store.getState().machines.one;
        expect(updated).not.toBe(before);
        expect(updated.metadata).toBe(before.metadata);
        expect(updated.availability).toBe(before.availability);
        store.getState().applyMachines([{ ...updated, installationPublicKey: 'replacement', isShared: true }], false, options);
        expect(store.getState().machines.one.installationPublicKey).toBe('replacement');
        expect(store.getState().machines.one.isShared).toBe(true);
    });

    it('notifies receipt readers only for changed Machine observations, including heartbeats', () => {
        const store = createTestStore();
        const options = { sourceServerId: getActiveServerSnapshot().serverId };
        const one = machine('one'), two = machine('two');
        store.getState().applyMachines([one, two], true, options);
        const notify = vi.fn();
        const unsubscribe = subscribeMachineUpdates(notify);
        try {
            store.getState().applyMachines(structuredClone([one, two]), true, options);
            expect(notify).not.toHaveBeenCalled();
            store.getState().applyMachines([structuredClone(one), machine('two', { activeAt: 2, updatedAt: 2 })], false, options);
            expect(notify).toHaveBeenCalledExactlyOnceWith(options.sourceServerId, ['two']);
            store.getState().applyMachines([structuredClone(one)], true, options);
            expect(notify).toHaveBeenLastCalledWith(options.sourceServerId, ['two']);
            expect(notify).toHaveBeenCalledTimes(2);
        } finally { unsubscribe(); }
    });

    it('does not rerender project-grouped lists for unrelated machine metadata but does publish a rename', async () => {
        const store = createTestStore();
        const serverId = getActiveServerSnapshot().serverId;
        const options = { sourceServerId: serverId };
        const metadata = { path: '/qa/repo', host: 'one', machineId: 'one', homeDir: '/qa' };
        store.setState({
            sessions: { s1: createSessionFixture({ id: 's1', metadata }) },
            sessionListRowsByServerId: { [serverId]: { s1: createSessionListRenderableSessionFixture({ id: 's1', metadata }) } },
            ordinarySessionListMembershipByServerId: { [serverId]: ['s1'] },
            settings: { ...settingsDefaults, sessionListLayoutV1: 'projects' },
        });
        const initial = machine('one');
        store.getState().applyMachines([initial], true, options);
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useStore(store, state => state.sessionListIndexByServerId); });
        try {
            const before = renders;
            const previous = hook.getCurrent();
            await act(async () => store.getState().applyMachines([
                machine('one', { metadataVersion: 2, metadata: { ...initial.metadata!, happyCliVersion: '0.3.1' } }),
            ], false, options));
            expect(store.getState().machines.one.metadataVersion).toBe(2);
            expect(renders - before).toBe(0);
            expect(hook.getCurrent()).toBe(previous);
            await act(async () => store.getState().applyMachines([
                machine('one', { metadataVersion: 3, metadata: { ...initial.metadata!, displayName: 'New reading desk' } }),
            ], false, options));
            expect(renders).toBeGreaterThan(before);
            expect(hook.getCurrent()).not.toBe(previous);
        } finally { await hook.unmount(); }
    });
    it('publishes freshness recovery for the active Home without replacing semantic rows or notifying on subsequent heartbeats', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(100_000);
        try {
            const store = createTestStore();
            const options = { sourceServerId: getActiveServerSnapshot().serverId };
            store.getState().applyMachines([machine('one', { activeAt: Date.now() })], true, options);
            const before = store.getState();
            const notify = vi.fn();
            const unsubscribe = store.subscribe(notify);
            vi.setSystemTime(180_001);
            store.getState().applyMachines([machine('one', { activeAt: Date.now(), updatedAt: Date.now() })], false, options);
            const recovered = store.getState();
            expect(notify).toHaveBeenCalledTimes(1);
            expect(recovered.machines).toBe(before.machines);
            expect(recovered.machineDisplayById).toBe(before.machineDisplayById);
            expect(recovered.machineListByServerId).toBe(before.machineListByServerId);
            vi.setSystemTime(180_002);
            store.getState().applyMachines([machine('one', { activeAt: Date.now(), updatedAt: Date.now() })], false, options);
            expect(store.getState()).toBe(recovered);
            expect(notify).toHaveBeenCalledTimes(1);
            unsubscribe();
        } finally { vi.useRealTimers(); }
    });

    it('keeps semantic machine projections stable when an online heartbeat only advances timestamps', () => {
        const store = createTestStore();
        const serverId = getActiveServerSnapshot().serverId;
        const options = { sourceServerId: serverId };
        store.getState().applyMachines([machine('one')], true, options);
        const before = store.getState();
        let notifications = 0;
        const unsubscribe = store.subscribe(() => notifications++);

        store.getState().applyMachines([
            machine('one', { activeAt: 2, updatedAt: 2 }),
        ], false, options);
        unsubscribe();

        const after = store.getState();
        expect(notifications).toBe(0);
        expect(after).toBe(before);
        expect(after.machines).toBe(before.machines);
        expect(after.machines.one).toBe(before.machines.one);
        expect(after.machineDisplayById).toBe(before.machineDisplayById);
        expect(after.machineDisplayById.one).toBe(before.machineDisplayById.one);
        expect(after.machineListByServerId).toBe(before.machineListByServerId);
        expect(after.machineListByServerId[serverId]).toBe(before.machineListByServerId[serverId]);
        expect(after.machinePresenceById.one).toEqual({ active: true, activeAt: 2, updatedAt: 2 });
        expect(after.machinePresenceByServerId[serverId]?.one).toEqual({ active: true, activeAt: 2, updatedAt: 2 });
        expect(after.machinePresenceById).toBe(before.machinePresenceById);
        expect(after.machinePresenceByServerId[serverId]).toBe(before.machinePresenceByServerId[serverId]);
    });

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
