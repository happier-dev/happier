import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { selectActiveTestHomeForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';

import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useMachineResourceFleetAttention } from './useMachineResourceFleetAttention';

const before = storage.getState();
const transport = vi.hoisted(() => ({ rpc: vi.fn() }));
// Mounting this always-on selector must not contact the daemon transport.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: transport.rpc }));
afterEach(() => { standardCleanup(); storage.setState(before); transport.rpc.mockClear(); vi.useRealTimers(); vi.unstubAllEnvs(); });

function resourceMachine(id: string, level: 'calm' | 'look' | 'needs_you', overrides: Partial<Machine> = {}) {
    return createMachineFixture({ id, activeAt: Date.now(), daemonState: {
        resources: { v: 1, vitals: { state: 'reporting' },
            host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 },
            attention: { level, reasons: level === 'calm' ? [] : [{
                key: 'memory', metric: 'memory', kind: 'memory_pressure', since: 1, level,
                pressure: level === 'needs_you' ? 'critical' : 'elevated', swapping: false,
            }] },
        },
    }, ...overrides });
}

function setMachines(machines: Machine[]) {
    const serverId = getActiveServerSnapshot().serverId;
    storage.setState({ profileScope: { serverId, accountId: 'resource-account' }, machines: {}, machineListByServerId: { [serverId]: machines }, machineListStatusByServerId: { [serverId]: 'idle' } });
    return serverId;
}

describe('always-on Machine resource attention', () => {
    it('does no attention collection, parsing or naming for unchanged facts across 148 Machines', async () => {
        const fixture = Array.from({ length: 148 }, (_, index) => resourceMachine(`quiet-${index}`, index === 0 ? 'needs_you' : 'calm'));
        const serverId = setMachines(fixture);
        storage.getState().applyMachines(fixture, true, { sourceServerId: serverId });
        const collectors = await import('@/components/machines/attention/collectMachineAttention');
        const sentences = await import('@/components/machines/summary/machineResourceSentences');
        const machineNames = await import('@/utils/sessions/machineDisplayNames');
        const collect = vi.spyOn(collectors, 'collectMachineAttention');
        const parse = vi.spyOn(sentences, 'readMachinePublishedResources');
        const names = vi.spyOn(machineNames, 'resolveMachineDisplayNames');
        const hook = await renderHook(() => useMachineResourceFleetAttention());
        let rootPublications = 0;
        const stop = storage.subscribe(() => { rootPublications += 1; });
        try {
            expect(hook.getCurrent().needsYou).toEqual([{ serverId, machineId: fixture[0]!.id }]);
            const snapshot = hook.getCurrent();
            collect.mockClear(); parse.mockClear(); names.mockClear();
            for (let index = 1; index <= 20; index += 1) await act(async () => {
                const machine = storage.getState().machineListByServerId[serverId]!.find(row => row.id === fixture[0]!.id)!;
                storage.getState().applyMachineActivityUpdates([{ id: machine.id, active: true, activeAt: Date.now() + index }], { sourceServerId: serverId });
                storage.getState().applyMachines([{ ...machine, metadataVersion: machine.metadataVersion + 1,
                    metadata: { ...machine.metadata!, happyCliVersion: `unrelated-${index}` },
                }], false, { sourceServerId: serverId });
            });
            expect(rootPublications).toBeGreaterThanOrEqual(20);
            console.info('PERF_MACT_ATTENTION_COUNTS', JSON.stringify({ machines: fixture.length, arrivals: 20,
                rootPublications, collections: collect.mock.calls.length, parses: parse.mock.calls.length, names: names.mock.calls.length }));
            expect(collect).not.toHaveBeenCalled();
            expect(parse).not.toHaveBeenCalled();
            expect(names).not.toHaveBeenCalled();
            expect(hook.getCurrent()).toBe(snapshot);

            await act(async () => storage.getState().applyMachines([resourceMachine(fixture[0]!.id, 'calm')], false, { sourceServerId: serverId }));
            expect(collect).toHaveBeenCalledTimes(1);
            expect(hook.getCurrent().needsYou).toEqual([]);
            expect(names).not.toHaveBeenCalled();
            collect.mockClear();
            const { recordMachineRequestFailed } = await import('@/sync/domains/machines/reachability/machineReachability');
            await act(async () => recordMachineRequestFailed({ serverId, accountId: 'resource-account', machineId: fixture[1]!.id }));
            expect(collect).toHaveBeenCalledTimes(1);
            expect(hook.getCurrent().reportingMachineKeys).not.toContain(JSON.stringify([serverId, fixture[1]!.id]));
        } finally { stop(); await hook.unmount(); collect.mockRestore(); parse.mockRestore(); names.mockRestore(); }
    });

    it('keeps named attention quiet while preserving renamed Machines and action details', async () => {
        const fixtures = [resourceMachine('named-attention', 'needs_you'), resourceMachine('named-sibling', 'calm')];
        const serverId = setMachines(fixtures);
        storage.getState().applyMachines(fixtures, true, { sourceServerId: serverId });
        const { useMachineAttention } = await import('./useMachineAttention');
        const collectors = await import('@/components/machines/attention/collectMachineAttention');
        const namesModule = await import('@/utils/sessions/machineDisplayNames');
        const collect = vi.spyOn(collectors, 'collectMachineAttention');
        const names = vi.spyOn(namesModule, 'resolveMachineDisplayNames');
        const hook = await renderHook(() => useMachineAttention([{ serverId, accountScope: { serverId, accountId: 'resource-account' },
            serverName: '', status: 'idle', machines: storage.getState().machineListByServerId[serverId] ?? [],
        }]));
        try {
            expect(hook.getCurrent().entries).toHaveLength(2);
            const snapshot = hook.getCurrent();
            collect.mockClear(); names.mockClear();
            await act(async () => {
                const machine = storage.getState().machineListByServerId[serverId]![0]!;
                storage.getState().applyMachineActivityUpdates([{ id: machine.id, active: true, activeAt: Date.now() + 1 }], { sourceServerId: serverId });
                storage.getState().applyMachines([{ ...machine, metadataVersion: machine.metadataVersion + 1,
                    metadata: { ...machine.metadata!, happyCliVersion: 'unrelated-version' },
                }], false, { sourceServerId: serverId });
            });
            await hook.rerender();
            expect(hook.getCurrent()).toBe(snapshot);
            expect(collect).not.toHaveBeenCalled();
            expect(names).not.toHaveBeenCalled();
            await act(async () => {
                const machine = storage.getState().machineListByServerId[serverId]![0]!;
                storage.getState().applyMachines([{ ...machine, metadataVersion: machine.metadataVersion + 1,
                    metadata: { ...machine.metadata!, displayName: 'Renamed attention Machine' },
                    daemonState: { ...machine.daemonState, resources: { ...machine.daemonState.resources,
                        lastAutomaticAction: { at: 42, kind: 'stopped_service', entryId: 'acted', undoable: true,
                            facts: { rule: 'left_behind', count: 3 } },
                    } },
                }], false, { sourceServerId: serverId });
            });
            expect(collect).toHaveBeenCalledTimes(1);
            expect(names).toHaveBeenCalledTimes(1);
            expect(hook.getCurrent().entries.find(entry => entry.machineId === fixtures[0]!.id))
                .toMatchObject({ name: 'Renamed attention Machine', lastAutomaticAction: { at: 42, kind: 'stopped_service', facts: { count: 3 } } });
        } finally { await hook.unmount(); collect.mockRestore(); names.mockRestore(); }
    });

    it('withdraws attention when the active Account scope retires', async () => {
        const serverId = setMachines([resourceMachine('retired-attention', 'needs_you')]);
        const hook = await renderHook(() => useMachineResourceFleetAttention());
        try {
            expect(hook.getCurrent().needsYou).toEqual([{ serverId, machineId: 'retired-attention' }]);
            await act(async () => storage.setState({ profileScope: null }));
            expect(hook.getCurrent()).toMatchObject({ accountScope: null, needsYou: [], look: [], reportingMachineKeys: [] });
        } finally { await hook.unmount(); }
    });

    it('does not read active fleet resources for foreign Home arrivals', async () => {
        let resourceReads = 0;
        const fixture = Array.from({ length: 128 }, (_, index) => new Proxy(
            resourceMachine(`active-${index}`, index === 0 ? 'needs_you' : 'calm'),
            { get(target, property, receiver) {
                if (property === 'daemonState') resourceReads += 1;
                return Reflect.get(target, property, receiver);
            } },
        ));
        const serverId = setMachines(fixture);
        storage.getState().applyMachines(fixture, true, { sourceServerId: serverId });
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useMachineResourceFleetAttention(); });
        try {
            expect(resourceReads).toBeGreaterThan(0);
            const summary = hook.getCurrent();
            const beforeRenders = renders;
            resourceReads = 0;
            for (let index = 0; index < 8; index += 1) await act(async () => {
                storage.getState().applyMachines([resourceMachine(`foreign-${index}`, 'calm')], false,
                    { sourceServerId: 'foreign-home' });
            });
            console.info('PERF_D4_FLEET_COUNTS', JSON.stringify({ activeMachines: fixture.length, foreignArrivals: 8,
                resourceReads, renders: renders - beforeRenders }));
            expect(hook.getCurrent()).toBe(summary);
            expect(renders).toBe(beforeRenders);
            expect(resourceReads).toBe(0);
        } finally { await hook.unmount(); }
    });

    it('suppresses equal payloads at the canonical Machine producer', async () => {
        const fixture = Array.from({ length: 128 }, (_, index) => resourceMachine(`active-${index}`, 'calm'));
        const serverId = setMachines(fixture);
        storage.getState().applyMachines(fixture, true, { sourceServerId: serverId });
        const hook = await renderHook(() => useMachineResourceFleetAttention());
        let notifications = 0;
        const stop = storage.subscribe(() => { notifications += 1; });
        try {
            const summary = hook.getCurrent();
            for (let index = 0; index < 8; index += 1) await act(async () => {
                storage.getState().applyMachines(structuredClone(fixture), true, { sourceServerId: serverId });
            });
            expect(notifications).toBe(0);
            expect(hook.getCurrent()).toBe(summary);
        } finally { stop(); await hook.unmount(); }
    });

    it('holds the snapshot across repeated React reads until the server publishes offline presence', async () => {
        vi.useFakeTimers();
        const now = Date.now();
        vi.setSystemTime(now);
        const serverId = setMachines([resourceMachine('expires', 'needs_you', { activeAt: now - 59_500 })]);
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useMachineResourceFleetAttention(); });
        const snapshot = hook.getCurrent();
        expect(snapshot.needsYou).toEqual([{ serverId, machineId: 'expires' }]);
        // A busy browser can cross the lease between React's consistency reads,
        // before the queued shared-clock callback is allowed to run.
        vi.setSystemTime(now + 501);
        await hook.rerender();
        expect(hook.getCurrent()).toBe(snapshot);
        const settledRenders = renders;
        await act(async () => {
            for (let index = 0; index < 10; index += 1) storage.setState({ isDataReady: index % 2 === 0 });
        });
        expect(renders).toBe(settledRenders);
        await act(async () => { await vi.advanceTimersByTimeAsync(501); });
        expect(hook.getCurrent()).toBe(snapshot);
        await act(async () => storage.getState().applyMachineActivityUpdates([{ id: 'expires', active: false, activeAt: now }], { sourceServerId: serverId }));
        expect(hook.getCurrent().needsYou).toEqual([]);
        expect(hook.getCurrent()).not.toBe(snapshot);
        expect(renders).toBe(settledRenders + 1);
        await hook.unmount();
    });
    it('withdraws held attention on the exact offline push without another RPC', async () => {
        vi.useFakeTimers();
        const now = Date.now();
        vi.setSystemTime(now);
        const serverId = setMachines([resourceMachine('expires', 'needs_you', { activeAt: now - 59_500 })]);
        const hook = await renderHook(() => useMachineResourceFleetAttention());
        await vi.waitFor(() => expect(hook.getCurrent().needsYou).toEqual([{ serverId, machineId: 'expires' }]));
        await act(async () => { await vi.advanceTimersByTimeAsync(501); });
        expect(hook.getCurrent().needsYou).toEqual([{ serverId, machineId: 'expires' }]);
        await act(async () => storage.getState().applyMachineActivityUpdates([{ id: 'expires', active: false, activeAt: now }], { sourceServerId: serverId }));
        expect(hook.getCurrent().needsYou).toEqual([]);
        expect(hook.getCurrent().headline).toBeNull();
        expect(transport.rpc).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('reads published attention while excluding offline, revoked, replaced and another Home', async () => {
        const serverId = setMachines([
            resourceMachine('needs', 'needs_you'), resourceMachine('look', 'look'),
            resourceMachine('offline', 'needs_you', { active: false, activeAt: 1 }),
            resourceMachine('revoked', 'needs_you', { revokedAt: 1 }),
            resourceMachine('replaced', 'needs_you', { replacedByMachineId: 'needs' }),
            resourceMachine('locked', 'needs_you', { availability: { kind: 'locked', reason: 'decryption_failed' } }),
            resourceMachine('acted', 'calm', { daemonState: { resources: {
                ...resourceMachine('acted', 'calm').daemonState.resources,
                lastAutomaticAction: { at: 8, kind: 'stopped_session', entryId: 'entry', undoable: true,
                    facts: { rule: 'memory_guard', freedBytes: 20 } },
            } } }),
        ]);
        storage.setState(state => ({ machineListByServerId: { ...state.machineListByServerId, other: [resourceMachine('other', 'needs_you')] } }));
        const hook = await renderHook(() => useMachineResourceFleetAttention());
        await vi.waitFor(() => expect(hook.getCurrent().needsYou).toEqual([{ serverId, machineId: 'needs' }]));
        expect(hook.getCurrent().look).toEqual([{ machineKey: JSON.stringify([serverId, 'look']), reasonKey: 'memory' }]);
        expect(hook.getCurrent()).toMatchObject({ reportingMachineKeys: ['acted', 'look', 'needs'].map(id => JSON.stringify([serverId, id])) });
        expect(hook.getCurrent().lastAutomaticActionAt).toBe(8);
        expect(hook.getCurrent().headline?.machineKey).toEqual({ serverId, machineId: 'needs' });
        expect(transport.rpc).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('retains the summary identity on unrelated metadata and heartbeats, and follows reason changes', async () => {
        const machine = resourceMachine('needs', 'needs_you');
        setMachines([machine]);
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useMachineResourceFleetAttention(); });
        await vi.waitFor(() => expect(hook.getCurrent().needsYou).toHaveLength(1));
        const summary = hook.getCurrent();
        const previousRenders = renders;
        await act(async () => { setMachines([{ ...machine, metadataVersion: 2, activeAt: Date.now(), daemonState: structuredClone(machine.daemonState) }]); });
        expect(renders).toBe(previousRenders);
        expect(hook.getCurrent()).toBe(summary);
        await act(async () => { setMachines([resourceMachine('needs', 'calm')]); });
        expect(hook.getCurrent().needsYou).toEqual([]);
        expect(hook.getCurrent().headline).toBeNull();
        await hook.unmount();
    });

    it('reads published attention from a modern unavailable summary without invented host facts', async () => {
        const current = resourceMachine('no-host', 'needs_you');
        const serverId = setMachines([{ ...current, daemonState: { resources: { v: 1,
            vitals: { state: 'unavailable', reason: 'reader_failed', since: 1 },
            attention: current.daemonState.resources.attention } } }]);
        const hook = await renderHook(() => useMachineResourceFleetAttention());
        await vi.waitFor(() => expect(hook.getCurrent().needsYou).toEqual([{ serverId, machineId: 'no-host' }]));
        expect(hook.getCurrent().headline?.reason).toMatchObject({ kind: 'memory_pressure', pressure: 'critical' });
        expect(hook.getCurrent()).toMatchObject({ reportingMachineKeys: [] });
        expect(transport.rpc).not.toHaveBeenCalled();
        await hook.unmount();
    });
});

// P03-TESTKIT-SERVER: the unconfigured test build seeds no Home; select one through the real owner.
beforeEach(async () => { await selectActiveTestHomeForTests(); });
