import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import { selectActiveTestHomeForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import { readMachineActivity, subscribeMachineActivity } from '@/sync/domains/machines/machineActivity';
import { hasCurrentMachineContent } from '@/sync/domains/machines/resolveServerScopedMachines';
import { buildUpdatedMachineFromSocketUpdate } from '@/sync/engine/machines/syncMachines';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { useMachineActivity } from '@/hooks/machine/useMachineActivity';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

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
        id, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, presenceProtocolVersion: 1,
        metadata: { host: id, platform: 'linux', happyCliVersion: '0.3', happyHomeDir: '/qa', homeDir: '/qa' },
        metadataVersion: 1, daemonState: null, daemonStateVersion: 0,
        ...overrides,
    };
}

describe('machine inventory reference stability through the real store', () => {
    beforeEach(async () => { await selectActiveTestHomeForTests(); });

    it('publishes online/offline only to the affected presence leaf, preserving every inventory identity', async () => {
        const store = createTestStore();
        const options = { sourceServerId: getActiveServerSnapshot().serverId };
        store.getState().applyMachines(Array.from({ length: 128 }, (_, index) => machine(`transition-${index}`,
            { activeAt: Date.now(), presenceProtocolVersion: 1 })), true, options);
        const before = store.getState();
        const root = vi.fn();
        const stop = store.subscribe(root);
        const renders = { affected: 0, unrelated: 0, list: 0 };
        const affected = await renderHook(() => { renders.affected++; return useMachineActivity(before.machines['transition-0']); });
        const unrelated = await renderHook(() => { renders.unrelated++; return useMachineActivity(before.machines['transition-127']); });
        const list = await renderHook(() => { renders.list++; return useStore(store, state => state.machineListByServerId); });
        const initial = { ...renders };
        try {
            await act(async () => store.getState().applyMachineActivityUpdates([
                { id: 'transition-0', active: false, activeAt: Date.now() },
            ], options));
            expect(affected.getCurrent()?.active).toBe(false);
            expect(renders.affected - initial.affected).toBe(1);
            expect(renders.unrelated - initial.unrelated).toBe(0);
            expect(renders.list - initial.list).toBe(0);
            expect(root).not.toHaveBeenCalled();
            expect(store.getState()).toBe(before);
        } finally { stop(); await affected.unmount(); await unrelated.unmount(); await list.unmount(); }
    });
    it.each(['active', 'secondary'] as const)('commits a 171-clock arrival burst before one fleet wake on the %s Home', home => {
        for (const ingress of ['activity', 'row', 'material', 'display'] as const) {
            // Warm display ingress belongs only to the active Home projection.
            if (home === 'secondary' && ingress === 'display') continue;
            const store = createTestStore();
            const sourceServerId = home === 'active' ? getActiveServerSnapshot().serverId : 'burst-secondary';
            const options = { sourceServerId };
            const now = Date.now();
            const rows = Array.from({ length: 196 }, (_, index) => machine(`burst-${index}`, { activeAt: now }));
            store.getState().applyMachines(rows, true, options);
            store.getState().applyMachines(rows.map(row => ({ ...row, activeAt: now - 100 })), true,
                { sourceServerId: 'burst-foreign' });
            const retained = store.getState().machineListByServerId[sourceServerId]!;
            const foreign = store.getState().machineListByServerId['burst-foreign']!;
            const changed = retained.slice(0, 171);
            const latest = now + (ingress === 'material' ? 2 : 1);
            const updates = changed.map(row => ({ id: row.id, active: true, activeAt: latest }));
            const observations: Array<Array<number | null | undefined>> = [];
            const fleet = vi.fn(() => { observations.push(changed.map(row => readMachineActivity(row).activeAt)); });
            const exact = changed.map(() => vi.fn());
            const unaffected = vi.fn();
            const otherHome = vi.fn();
            const root = vi.fn();
            const stops = [store.subscribe(root),
                ...changed.map(row => subscribeMachineActivity(row, fleet)),
                ...changed.map((row, index) => subscribeMachineActivity(row, exact[index])),
                subscribeMachineActivity(retained[195], unaffected),
                ...foreign.map(row => subscribeMachineActivity(row, otherHome)),
            ];
            try {
                if (ingress === 'activity') store.getState().applyMachineActivityUpdates(updates, options);
                else if (ingress === 'display') store.getState().replaceMachineDisplays(changed.map(row =>
                    buildMachineDisplayRenderableFromMachine({ ...row, activeAt: latest })), { ...options, replace: false });
                else store.getState().applyMachines(changed.map(row => ({ ...row, activeAt: now + 1 })), false,
                    ingress === 'material' ? { ...options, activityUpdates: updates } : options);
                expect(fleet, ingress).toHaveBeenCalledTimes(1);
                expect(observations, ingress).toEqual([Array.from({ length: 171 }, () => latest)]);
                for (const row of exact) expect(row, ingress).toHaveBeenCalledTimes(1);
                expect(unaffected, ingress).not.toHaveBeenCalled();
                expect(otherHome, ingress).not.toHaveBeenCalled();
                expect(root, ingress).not.toHaveBeenCalled();
                fleet.mockClear();
                store.getState().applyMachineActivityUpdates(updates, options);
                store.getState().applyMachineActivityUpdates(updates.map(update => ({ ...update, activeAt: now })), options);
                if (home === 'active') store.getState().applyMachineActivityUpdates(
                    updates.map(update => ({ ...update, activeAt: latest + 1 })),
                    { ...options, sourceAccountId: 'different-account' });
                expect(fleet, ingress).not.toHaveBeenCalled();
                expect(otherHome, ingress).not.toHaveBeenCalled();
                expect(changed.map(row => readMachineActivity(row).activeAt)).toEqual(updates.map(update => update.activeAt));
            } finally { for (const stop of stops) stop(); }
        }
    });

    it('reconciles repeated Machine ids sequentially within an activity arrival burst', () => {
        const store = createTestStore();
        const now = Date.now();
        store.getState().applyMachines([machine('duplicate', { activeAt: now })], true);
        const row = store.getState().machines.duplicate;
        const notify = vi.fn();
        const stop = subscribeMachineActivity(row, notify);
        try {
            store.getState().applyMachineActivityUpdates([
                { id: row.id, active: true, activeAt: now + 2 },
                { id: row.id, active: true, activeAt: now + 1 },
                { id: row.id, active: true, activeAt: now + 3 },
            ]);
            expect(notify).toHaveBeenCalledTimes(1);
            expect(readMachineActivity(row).activeAt).toBe(now + 3);
        } finally { stop(); }
    });

    it('publishes only the changed decoded field on 128 Machines, with zero equal, activity or idle wakes', async () => {
        const store = createTestStore();
        const now = Date.now();
        const rows = Array.from({ length: 128 }, (_, index) => machine(`field-${index}`, {
            activeAt: now,
            metadata: { ...machine(`field-${index}`).metadata!, agentInventory: { checkedAt: 1, installedAgentIds: ['codex'] } },
            daemonStateVersion: 1,
            daemonState: { status: 'running', resources: { activeSessions: 1 }, managedActivity: { kind: 'idle', since: 1 } },
        }));
        store.getState().applyMachines(rows, true);
        const renders = { inventory: 0, resources: 0, activity: 0, other: 0 };
        const hooks = [
            await renderHook(() => { renders.inventory++; return useStore(store, state => state.machines['field-0'].metadata?.agentInventory); }),
            await renderHook(() => { renders.resources++; return useStore(store, state => state.machines['field-0'].daemonState?.resources); }),
            await renderHook(() => { renders.activity++; return useStore(store, state => state.machines['field-0'].daemonState?.managedActivity); }),
            await renderHook(() => { renders.other++; return useStore(store, state => state.machines['field-127'].metadata?.agentInventory); }),
        ];
        const root = vi.fn();
        const stop = store.subscribe(root);
        try {
            Object.keys(renders).forEach(key => { renders[key as keyof typeof renders] = 0; });
            for (let arrival = 0; arrival < 12; arrival++) {
                await act(async () => store.getState().applyMachines(structuredClone(rows), true));
            }
            expect(root).not.toHaveBeenCalled();
            const before = store.getState();
            await act(async () => {
                const changed = structuredClone(rows[0]);
                changed.daemonStateVersion++;
                changed.daemonState.resources.activeSessions = 2;
                store.getState().applyMachines([changed]);
            });
            expect(root).toHaveBeenCalledTimes(1);
            expect(renders).toEqual({ inventory: 0, resources: 1, activity: 0, other: 0 });
            expect(store.getState().machines['field-0'].metadata).toBe(before.machines['field-0'].metadata);
            expect(store.getState().machines['field-0'].daemonState.managedActivity).toBe(before.machines['field-0'].daemonState.managedActivity);
            expect(store.getState().machines['field-127']).toBe(before.machines['field-127']);
            await act(async () => {
                const changed = structuredClone(store.getState().machines['field-0']);
                changed.metadataVersion++;
                changed.metadata!.agentInventory!.installedAgentIds.push('claude');
                store.getState().applyMachines([changed]);
                store.getState().applyMachineActivityUpdates([{ id: changed.id, active: true, activeAt: now + 1 }]);
            });
            expect(renders).toEqual({ inventory: 1, resources: 1, activity: 0, other: 0 });
            root.mockClear();
            vi.useFakeTimers();
            await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
            expect(root).not.toHaveBeenCalled();
            expect(renders).toEqual({ inventory: 1, resources: 1, activity: 0, other: 0 });
        } finally {
            vi.useRealTimers();
            stop();
            for (const hook of hooks) await hook.unmount();
        }
    });

    it.each(['active', 'secondary'] as const)('publishes daemon revisions on the %s Home even when opened content matches', async home => {
        const store = createTestStore();
        const sourceServerId = home === 'active' ? getActiveServerSnapshot().serverId : 'activity-home';
        const options = { sourceServerId };
        const initial = machine('managed', { activeAt: Date.now(), storageMode: 'plain',
            keyBasis: { dataEncryptionKey: null, metadataVersion: 1, daemonStateVersion: 1 },
            daemonStateVersion: 1, daemonState: { status: 'running', managedActivity: { kind: 'idle', since: 1 } } });
        store.getState().applyMachines([initial], true, options);
        const before = store.getState();
        const receipt = vi.fn();
        const stopReceipt = subscribeMachineUpdates(receipt);
        let listChanges = 0;
        let stopPresence = () => {};
        const stop = store.subscribe((state, previous) => {
            if (state.machineListByServerId !== previous.machineListByServerId) listChanges++;
        });
        try {
            for (let version = 2; version <= 21; version++) {
                store.getState().applyMachines([{ ...initial, updatedAt: initial.updatedAt + version,
                    activeAt: initial.activeAt + version, daemonStateVersion: version,
                    keyBasis: { ...initial.keyBasis!, daemonStateVersion: version },
                    daemonState: structuredClone(initial.daemonState),
                }], false, options);
            }
            expect(listChanges).toBe(20);
            expect(store.getState().machineListByServerId).not.toBe(before.machineListByServerId);
            const retained = store.getState().machineListByServerId[sourceServerId]![0];
            expect(readMachineActivity(retained).activeAt).toBe(initial.activeAt + 21);
            expect(retained.daemonStateVersion).toBe(21);
            expect(retained.daemonState).toBe(initial.daemonState);
            expect(hasCurrentMachineContent(retained)).toBe(true);
            expect(receipt).toHaveBeenCalledTimes(20);
            const stale = await buildUpdatedMachineFromSocketUpdate({
                existingMachine: retained, updateSeq: 22, updateCreatedAt: Date.now(), getMachineEncryption: () => null,
                machineUpdate: { machineId: retained.id,
                    daemonState: { version: 20, value: encodePlainMachineStoredContent({ status: 'running', resources: { activeSessions: 99 } }) } },
            });
            expect(stale?.daemonStateVersion).toBe(21);
            expect(stale?.daemonState.resources).toBeUndefined();
            const observedPresence = vi.fn(() => readMachineActivity(retained));
            stopPresence = subscribeMachineActivity(retained, observedPresence);
            store.getState().applyMachineActivityUpdates([{ id: retained.id, active: false, activeAt: initial.activeAt + 22 }], options);
            const offline = store.getState().machineListByServerId[sourceServerId]![0];
            expect(offline).toBe(retained);
            expect(observedPresence).toHaveBeenCalledTimes(1);
            expect(observedPresence).toHaveLastReturnedWith(expect.objectContaining({ active: false, activeAt: initial.activeAt + 22 }));
            expect(offline.daemonStateVersion).toBe(21);
            expect(offline.daemonState).toBe(initial.daemonState);
            expect(listChanges).toBe(20);
            store.getState().applyMachines([{ ...offline, metadataVersion: 2,
                metadata: { ...offline.metadata!, host: 'renamed' } }], false, options);
            const renamed = store.getState().machineListByServerId[sourceServerId]![0];
            expect(renamed.daemonStateVersion).toBe(21);
            expect(renamed.daemonState).toBe(initial.daemonState);
            expect(listChanges).toBe(21);
            const pendingUpdate = await buildUpdatedMachineFromSocketUpdate({
                existingMachine: renamed, updateSeq: 23, updateCreatedAt: Date.now(), getMachineEncryption: () => null,
                machineUpdate: { machineId: retained.id },
                keyBasis: { ...renamed.keyBasis!, metadataVersion: 2, daemonStateVersion: 22 },
            });
            expect(pendingUpdate).not.toBeNull();
            store.getState().applyMachines([pendingUpdate!], false, options);
            const pending = store.getState().machineListByServerId[sourceServerId]![0];
            expect(hasCurrentMachineContent(pending)).toBe(false);
            expect(listChanges).toBe(22);
            store.getState().applyMachines([{ ...renamed, daemonStateVersion: 22,
                keyBasis: { ...renamed.keyBasis!, metadataVersion: 2, daemonStateVersion: 22 },
                daemonState: { status: 'running', resources: { activeSessions: 1 } },
            }], false, options);
            expect(listChanges).toBe(23);
            expect(store.getState().machineListByServerId[sourceServerId]![0].daemonState.resources.activeSessions).toBe(1);
            expect(hasCurrentMachineContent(store.getState().machineListByServerId[sourceServerId]![0])).toBe(true);
        } finally { stop(); stopReceipt(); stopPresence(); }
    });

    it.each(['active', 'secondary'] as const)('keeps the %s Home list snapshot stable for 44 equal/liveness arrivals and publishes real content', home => {
        const store = createTestStore();
        const activeServerId = getActiveServerSnapshot().serverId;
        const sourceServerId = home === 'active' ? activeServerId : 'secondary-home';
        const options = { sourceServerId };
        const now = Date.now();
        const rows = Array.from({ length: 171 }, (_, index) => machine(`snapshot-${index}`, { activeAt: now }));
        store.getState().applyMachines(rows, true, options);
        const before = store.getState();
        const originalList = before.machineListByServerId[sourceServerId]!;
        let listSnapshotChanges = 0;
        const stop = store.subscribe((state, previous) => {
            if (state.machineListByServerId !== previous.machineListByServerId) listSnapshotChanges++;
        });
        try {
            for (let tick = 1; tick <= 44; tick++) {
                if (tick % 3 === 0) {
                    store.getState().applyMachineActivityUpdates([{ id: rows[0].id, active: true, activeAt: now + tick }], options);
                } else {
                    const arrivals = structuredClone(rows);
                    if (tick % 3 === 1) {
                        arrivals[0].activeAt = now + tick;
                        arrivals[0].updatedAt = now + tick;
                    }
                    const replace = tick % 2 === 0;
                    store.getState().applyMachines(replace ? arrivals : arrivals.slice(0, 1), replace, options);
                }
            }
            expect(listSnapshotChanges).toBe(0);
            expect(store.getState().machineListByServerId).toBe(before.machineListByServerId);
            expect(store.getState().machineListByServerId[sourceServerId]).toBe(originalList);
            expect(readMachineActivity(originalList[0]).activeAt).toBe(now + 43);
            const changed = { ...structuredClone(rows[0]), metadataVersion: 2,
                metadata: { ...rows[0].metadata!, host: 'changed-content' } };
            store.getState().applyMachines([changed], false, options);
            expect(listSnapshotChanges).toBe(1);
            expect(store.getState().machineListByServerId[sourceServerId]![0].metadata?.host).toBe('changed-content');
            if (home === 'secondary') expect(store.getState().machines).toBe(before.machines);
        } finally { stop(); }
    });

    it.each(['row', 'activity'] as const)('keeps 20 continuing %s heartbeats and offline transitions off whole-root state for 137 Machines', publication => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(100_000);
        const store = createTestStore();
        const options = { sourceServerId: getActiveServerSnapshot().serverId };
        store.getState().applyMachines(Array.from({ length: 137 }, (_, index) => machine(`idle-${index}`, { activeAt: Date.now() })), true, options);
        const before = store.getState();
        const root = vi.fn();
        const receipt = vi.fn();
        const stopRoot = store.subscribe(root);
        const stopReceipt = subscribeMachineUpdates(receipt);
        const observedPresence = vi.fn(() => readMachineActivity(before.machineDisplayById['idle-0']));
        const stopPresence = subscribeMachineActivity(before.machineDisplayById['idle-0'], observedPresence);
        try {
            for (let tick = 1; tick <= 20; tick++) {
                vi.setSystemTime(100_000 + tick * 20_001);
                if (publication === 'row') {
                    const updated = { ...before.machines['idle-0'], activeAt: Date.now(), updatedAt: Date.now() };
                    const replace = tick % 2 === 0;
                    store.getState().applyMachines(replace
                        ? [updated, ...Object.values(before.machines).slice(1)] : [updated], replace, options);
                } else {
                    store.getState().applyMachineActivityUpdates([{ id: 'idle-0', active: true, activeAt: Date.now() }], options);
                }
            }
            expect(root).toHaveBeenCalledTimes(0);
            expect(store.getState()).toBe(before);
            expect(before.machines['idle-0'].activeAt).toBe(100_000);
            expect(readMachineActivity(before.machines['idle-0']).activeAt).toBe(Date.now());
            expect(readMachineActivity(before.machineDisplayById['idle-0']).activeAt).toBe(Date.now());
            expect(readMachineActivity(before.machinePresenceById['idle-0']).activeAt).toBe(Date.now());
            expect(isMachineOnline(before.machines['idle-0'])).toBe(true);
            expect(receipt).toHaveBeenCalledTimes(20);
            observedPresence.mockClear();
            store.getState().applyMachineActivityUpdates([{ id: 'idle-0', active: false, activeAt: Date.now() - 1 }], options);
            expect(root).toHaveBeenCalledTimes(0);
            expect(observedPresence).not.toHaveBeenCalled();
            store.getState().applyMachineActivityUpdates([{ id: 'idle-0', active: false, activeAt: Date.now() }], options);
            expect(root).not.toHaveBeenCalled();
            expect(store.getState()).toBe(before);
            expect(observedPresence).toHaveBeenCalledTimes(1);
            expect(observedPresence).toHaveLastReturnedWith(expect.objectContaining({ active: false, activeAt: Date.now() }));
            const offline = store.getState().machines['idle-0'];
            store.getState().applyMachines([{ ...offline, ...readMachineActivity(offline), activeAt: Date.now() + 1 }], false, options);
            expect(root).not.toHaveBeenCalled();
            expect(store.getState().machines['idle-0']).toBe(offline);
            expect(readMachineActivity(offline).activeAt).toBe(Date.now() + 1);
            store.getState().applyMachines([{ ...offline, ...readMachineActivity(offline), activeAt: Date.now() + 1, metadataVersion: 2,
                metadata: { ...offline.metadata!, host: 'renamed' } }], false, options);
            expect(root).toHaveBeenCalledTimes(1);
            expect(store.getState().machines['idle-0'].metadata?.host).toBe('renamed');
        } finally { stopRoot(); stopReceipt(); stopPresence(); vi.useRealTimers(); }
    });
    it.each(['row', 'activity'] as const)('keeps %s activity scoped to the admitted row and preserves latest freshness across content hydration', publication => {
        const store = createTestStore();
        const serverId = getActiveServerSnapshot().serverId;
        const now = Date.now();
        const current = machine('same-id', { activeAt: now });
        const other = machine('same-id', { activeAt: now - 1000 });
        store.getState().applyMachines([current], true, { sourceServerId: serverId });
        store.getState().applyMachines([other], true, { sourceServerId: 'different-home' });
        const foreign = store.getState().machineListByServerId['different-home']![0];
        const latest = now + 20_001;
        const ownActivity = vi.fn();
        const foreignActivity = vi.fn();
        const stopOwn = subscribeMachineActivity(store.getState().machines['same-id'], ownActivity);
        const stopForeign = subscribeMachineActivity(foreign, foreignActivity);
        try {
            if (publication === 'row') store.getState().applyMachines([{ ...current, activeAt: latest }], false, { sourceServerId: serverId });
            else store.getState().applyMachineActivityUpdates([{ id: 'same-id', active: true, activeAt: latest }], { sourceServerId: serverId });
            expect(ownActivity).toHaveBeenCalledTimes(1);
            expect(foreignActivity).not.toHaveBeenCalled();
            expect(readMachineActivity(foreign).activeAt).toBe(now - 1000);
            store.getState().applyMachines([{ ...current, metadataVersion: 2, metadata: { ...current.metadata!, host: 'renamed' } }], false, { sourceServerId: serverId });
            const hydrated = store.getState();
            expect(hydrated.machines['same-id'].activeAt).toBe(latest);
            expect(isMachineOnline(hydrated.machines['same-id'], latest + 59_000)).toBe(true);
            expect(isMachineOnline(hydrated.machineDisplayById['same-id'], latest + 59_000)).toBe(true);
            expect(hydrated.machineListByServerId[serverId]![0]).toBe(hydrated.machines['same-id']);
        } finally { stopOwn(); stopForeign(); }
    });
    it.each(['row', 'activity'] as const)('publishes immutable %s presence and renders only the changed Machine in a 128-machine fleet', async publication => {
        const store = createTestStore();
        const serverId = getActiveServerSnapshot().serverId;
        const options = { sourceServerId: serverId };
        store.getState().applyMachines(Array.from({ length: 128 }, (_, index) => machine(`fleet-${index}`)), true, options);
        const before = store.getState();
        const changedBefore = before.machines['fleet-0'];
        const presenceBefore = before.machinePresenceById['fleet-0'];
        const displayBefore = before.machineDisplayById['fleet-0'];
        const renders = { changed: 0, unaffected: 0 };
        const changed = await renderHook(() => {
            renders.changed++;
            const row = useStore(store, state => state.machines['fleet-0']);
            return { row, activity: useMachineActivity(row) };
        });
        const unaffected = await renderHook(() => { renders.unaffected++; return useStore(store, state => state.machines['fleet-127']); });
        const baseline = { ...renders };
        try {
            await act(async () => {
                if (publication === 'row') store.getState().applyMachines([machine('fleet-0', { activeAt: 2, updatedAt: 2 })], false, options);
                else store.getState().applyMachineActivityUpdates([{ id: 'fleet-0', active: true, activeAt: 2 }], options);
            });
            const after = store.getState();
            expect(changedBefore.activeAt).toBe(1);
            expect(displayBefore.activeAt).toBe(1);
            expect(presenceBefore.activeAt).toBe(1);
            expect(changed.getCurrent().row).toBe(changedBefore);
            expect(changed.getCurrent().activity?.activeAt).toBe(2);
            expect(renders.changed - baseline.changed).toBe(1);
            expect(renders.unaffected - baseline.unaffected).toBe(0);
            for (let index = 1; index < 128; index++) {
                const id = `fleet-${index}`;
                expect(after.machines[id]).toBe(before.machines[id]);
                expect(after.machineDisplayById[id]).toBe(before.machineDisplayById[id]);
                expect(after.machinePresenceById[id]).toBe(before.machinePresenceById[id]);
            }
            expect(after.machineListByServerId[serverId]?.[0]).toBe(after.machines['fleet-0']);
            expect(after.machinePresenceByServerId[serverId]?.['fleet-0']).toEqual(after.machinePresenceById['fleet-0']);
        } finally { await changed.unmount(); await unaffected.unmount(); }
    });
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
            expect(previous.machineDisplayById.display.activeAt).toBe(1);
            expect(notify).toHaveBeenCalledTimes(0);
            expect(readMachineActivity(store.getState().machineDisplayById.display).activeAt).toBe(2);
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
        expect(store.getState().machineListByServerId[options.sourceServerId!]?.[0]).toBe(updated);
        expect(updated.metadata).toBe(before.metadata);
        expect(updated.availability).toBe(before.availability);
        store.getState().applyMachines([{ ...updated, installationPublicKey: 'replacement', isShared: true }], false, options);
        expect(store.getState().machines.one.installationPublicKey).toBe('replacement');
        expect(store.getState().machines.one.isShared).toBe(true);
    });

    it('keeps retained display clocks current when real content arrives with newer liveness', async () => {
        const store = createTestStore();
        const options = { sourceServerId: getActiveServerSnapshot().serverId };
        const one = machine('content-clock', { activeAt: Date.now() });
        store.getState().applyMachines([one], true, options);
        const before = store.getState();
        const display = before.machineDisplayById[one.id];
        const hook = await renderHook(() => useMachineActivity(display));
        const root = vi.fn();
        const receipt = vi.fn();
        const stopRoot = store.subscribe(root);
        const stopReceipt = subscribeMachineUpdates(receipt);
        try {
            await act(async () => store.getState().applyMachines([{ ...one, activeAt: one.activeAt + 1,
                daemonStateVersion: 1, daemonState: { status: 'running' } }], false, options));
            expect(store.getState().machines[one.id]).not.toBe(before.machines[one.id]);
            expect(store.getState().machineDisplayById[one.id]).toBe(display);
            expect(hook.getCurrent()?.activeAt).toBe(one.activeAt + 1);
            expect(root).toHaveBeenCalledTimes(1);
            expect(receipt).toHaveBeenCalledExactlyOnceWith(options.sourceServerId, [one.id]);
        } finally { stopRoot(); stopReceipt(); await hook.unmount(); }
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
            expect(store.getState().machines.two).toBeUndefined();
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
    it.each(['row', 'activity'] as const)('keeps immutable rows stable while publishing %s presence changes through their activity subscriptions', publication => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(100_000);
        try {
            const store = createTestStore();
            const options = { sourceServerId: getActiveServerSnapshot().serverId };
            store.getState().applyMachines([machine('one', { activeAt: Date.now() })], true, options);
            const before = store.getState();
            const notify = vi.fn();
            const unsubscribe = store.subscribe(notify);
            const observedPresence = vi.fn(() => readMachineActivity(before.machines.one));
            const stopPresence = subscribeMachineActivity(before.machines.one, observedPresence);
            vi.setSystemTime(180_001);
            const publish = (active: boolean) => publication === 'row'
                ? store.getState().applyMachines([machine('one', { active, activeAt: Date.now(), updatedAt: Date.now() })], false, options)
                : store.getState().applyMachineActivityUpdates([{ id: 'one', active, activeAt: Date.now() }], options);
            publish(true);
            expect(notify).not.toHaveBeenCalled();
            expect(store.getState()).toBe(before);
            expect(readMachineActivity(before.machines.one).activeAt).toBe(180_001);
            expect(observedPresence).toHaveBeenCalledTimes(1);
            vi.setSystemTime(180_002);
            publish(false);
            expect(notify).not.toHaveBeenCalled();
            expect(isMachineOnline(store.getState().machines.one)).toBe(false);
            expect(before.machines.one.active).toBe(true);
            expect(observedPresence).toHaveBeenCalledTimes(2);
            expect(observedPresence).toHaveLastReturnedWith(expect.objectContaining({ active: false, activeAt: 180_002 }));
            vi.setSystemTime(180_003);
            publish(true);
            const recovered = store.getState();
            expect(notify).not.toHaveBeenCalled();
            expect(recovered).toBe(before);
            expect(recovered.machines.one).toBe(before.machines.one);
            expect(recovered.machines.one.metadata).toBe(before.machines.one.metadata);
            expect(recovered.machines.one.daemonState).toBe(before.machines.one.daemonState);
            expect(isMachineOnline(recovered.machines.one)).toBe(true);
            expect(observedPresence).toHaveBeenCalledTimes(3);
            expect(observedPresence).toHaveLastReturnedWith(expect.objectContaining({ active: true, activeAt: 180_003 }));
            expect(before.machines.one.activeAt).toBe(100_000);
            expect(before.machinePresenceById.one.activeAt).toBe(100_000);
            vi.setSystemTime(180_004);
            publish(true);
            expect(store.getState().machines.one).toBe(recovered.machines.one);
            expect(recovered.machines.one.activeAt).toBe(100_000);
            expect(readMachineActivity(store.getState().machines.one).activeAt).toBe(180_004);
            expect(observedPresence).toHaveBeenCalledTimes(4);
            expect(observedPresence).toHaveLastReturnedWith(expect.objectContaining({ active: true, activeAt: 180_004 }));
            expect(notify).not.toHaveBeenCalled();
            unsubscribe();
            stopPresence();
        } finally { vi.useRealTimers(); }
    });

    it('keeps Machine inventory and presence snapshots stable while publishing keyed heartbeat timestamps', () => {
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
        expect(after.machines.one.metadata).toBe(before.machines.one.metadata);
        expect(after.machineDisplayById.one.metadata).toBe(before.machineDisplayById.one.metadata);
        expect(before.machines.one.activeAt).toBe(1);
        expect(readMachineActivity(after.machinePresenceById.one)).toMatchObject({ active: true, activeAt: 2 });
        expect(readMachineActivity(after.machinePresenceByServerId[serverId]!.one)).toMatchObject({ active: true, activeAt: 2 });
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

    it.each(['active', 'secondary'] as const)('withdraws omitted live and offline rows from a current %s Home replacement', home => {
        const store = createTestStore();
        const sourceServerId = home === 'active' ? getActiveServerSnapshot().serverId : 'census-secondary';
        const options = { sourceServerId };
        const rows = Array.from({ length: 173 }, (_, index) => machine(`retained-${index}`, {
            active: index % 2 === 0, activeAt: Date.now(),
        }));
        store.getState().applyMachines(rows, true, options);
        const before = store.getState();
        const retained = before.machineListByServerId[sourceServerId]!;
        let publications = 0;
        const stop = store.subscribe(() => publications++);
        try {
            store.getState().applyMachines(retained.slice(1), true, options);
            const after = store.getState().machineListByServerId[sourceServerId]!;
            expect(after).toHaveLength(172);
            expect(publications).toBe(1);
            expect(after.every((row, index) => row === retained[index + 1])).toBe(true);
            if (home === 'active') {
                expect(store.getState().machines[retained[0]!.id]).toBeUndefined();
                expect(store.getState().machineDisplayById[retained[0]!.id]).toBeUndefined();
            } else {
                expect(store.getState().machines).toBe(before.machines);
            }
            store.getState().applyMachines([], true, options);
            expect(store.getState().machineListByServerId[sourceServerId]).toEqual([]);
            expect(publications).toBe(2);
        } finally { stop(); }
    });

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
        expect(after.machines.two).toBe(before.machines.two);
        expect(readMachineActivity(after.machines.two).active).toBe(false);
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

    it('recovers a retained offline display from a fresh live heartbeat without replacing content', () => {
        const store = createTestStore();
        const serverId = getActiveServerSnapshot().serverId;
        const options = { sourceServerId: serverId };
        store.getState().applyMachines([machine('one', { activeAt: 1 })], true, options);
        const row = store.getState().machines.one;
        store.getState().replaceMachineDisplays([{ ...store.getState().machineDisplayById.one!, active: false, activeAt: 2 }], { replace: false });
        expect(store.getState().machineDisplayById.one.active).toBe(false);
        const display = store.getState().machineDisplayById.one;
        const observedPresence = vi.fn(() => readMachineActivity(display));
        const stopPresence = subscribeMachineActivity(display, observedPresence);
        try {
            store.getState().applyMachineActivityUpdates([{ id: row.id, active: true, activeAt: 3 }], options);
            expect(store.getState().machines.one).toBe(row);
            expect(store.getState().machines.one.metadata).toBe(row.metadata);
            expect(store.getState().machineDisplayById.one).toBe(display);
            expect(observedPresence).toHaveBeenCalledTimes(1);
            expect(observedPresence).toHaveLastReturnedWith(expect.objectContaining({ active: true, activeAt: 3 }));
        } finally { stopPresence(); }
    });
});
