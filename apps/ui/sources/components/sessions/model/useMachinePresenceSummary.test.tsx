import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import * as serverProfiles from '@/sync/domains/server/serverProfiles';
import {
    clearMachineRequestReachabilityForTest,
    recordMachineRequestFailed,
    recordMachineRequestSucceeded,
    withdrawMachinePresenceForScope,
    captureMachinePresenceObservation,
    resolveMachineReachability,
} from '@/sync/domains/machines/reachability/machineReachability';
const home = createHomeGovernanceHarness();
const serverId = 'srv_presence';
installHomeGovernanceBoundaries(home);
const { storage } = await import('@/sync/domains/state/storageStore');
const { useMachinePresenceSummary, useMachinePresenceSummaries, useMachinePresenceMembership, useMachinePresenceSnapshot } = await import('@/sync/domains/machines/reachability/useMachinePresenceSummary');
const { useServerCredentialAccountScopeBinding, useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');

beforeEach(async () => {
    await home.reset();
    await home.addHome({ name: 'Presence Home', serverUrl: 'https://presence.example.test',
        serverIdentityId: serverId, accountId: 'account-a' });
});

afterEach(async () => {
    clearMachineRequestReachabilityForTest();
    standardCleanup();
    vi.useRealTimers();
    await home.reset();
});

describe('reactive Machine presence', () => {
    it('does not derive a selected Machine summary for another row or Home', async () => {
        let nameReads = 0;
        const selected = createMachineFixture({ id: 'selected', activeAt: Date.now() });
        const name = selected.metadata!.displayName;
        selected.metadata = new Proxy(selected.metadata!, { get(target, property, receiver) {
            if (property === 'displayName') nameReads += 1;
            return Reflect.get(target, property, receiver);
        } });
        const neighbors = Array.from({ length: 127 }, (_, index) => createMachineFixture({ id: `neighbor-${index}`, activeAt: Date.now() }));
        storage.getState().applyMachines([...neighbors, selected], true, { sourceServerId: serverId });
        let rowVisits = 0;
        const inventory = storage.getState().machineListByServerId[serverId]!;
        const measuredInventory = new Proxy(inventory, { get(target, property, receiver) {
            if (typeof property === 'string' && /^\d+$/.test(property)) rowVisits += 1;
            return Reflect.get(target, property, receiver);
        } });
        storage.setState(state => ({
            machineListByServerId: { ...state.machineListByServerId, [serverId]: measuredInventory },
            machineListStatusByServerId: { ...state.machineListStatusByServerId, [serverId]: 'idle' },
        }));
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useMachinePresenceSummary(serverId, selected.id); });
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().reachability).toBe('reachable'));
            expect(nameReads).toBeGreaterThan(0);
            expect(rowVisits).toBeGreaterThan(0);
            const summary = hook.getCurrent();
            const beforeRenders = renders;
            nameReads = 0;
            rowVisits = 0;
            for (let index = 0; index < 8; index += 1) await act(async () => {
                storage.getState().applyMachines([createMachineFixture({ id: `foreign-${index}` })], false, { sourceServerId: 'foreign-home' });
            });
            const foreignRowVisits = rowVisits;
            for (let index = 0; index < 8; index += 1) await act(async () => {
                storage.getState().applyMachines([{ ...neighbors[index]!, metadataVersion: 2,
                    metadata: { ...neighbors[index]!.metadata!, displayName: `Changed neighbor ${index}` } }], false, { sourceServerId: serverId });
            });
            await act(async () => { recordMachineRequestFailed({ serverId: 'foreign-home', accountId: 'foreign-account', machineId: 'foreign-0' }); });
            expect(foreignRowVisits).toBe(0);
            expect(hook.getCurrent()).toBe(summary);
            expect(renders).toBe(beforeRenders);
            expect(nameReads).toBe(0);
            await act(async () => {
                storage.getState().applyMachines([{ ...selected, metadataVersion: 3,
                    metadata: { ...selected.metadata!, displayName: `${name} updated` } }], false, { sourceServerId: serverId });
            });
            expect(hook.getCurrent().name).toBe(`${name} updated`);
        } finally { await hook.unmount(); }
    });

    it('keeps a whitespace-normalized target current for row and request changes', async () => {
        const machine = createMachineFixture({ id: 'trimmed-target', activeAt: Date.now(), presenceProtocolVersion: 1 });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        const hook = await renderHook(() => useMachinePresenceSummary(serverId, ` ${machine.id} `));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().reachability).toBe('reachable'));
            await act(async () => storage.getState().applyMachines([{ ...machine, metadataVersion: 2,
                metadata: { ...machine.metadata!, displayName: 'Trimmed target renamed' } }], false, { sourceServerId: serverId }));
            expect(hook.getCurrent().name).toBe('Trimmed target renamed');
            await act(async () => { recordMachineRequestFailed({ serverId, accountId: 'account-a', machineId: machine.id }); });
            expect(hook.getCurrent().reachability).toBe('unreachable');
            expect(hook.getCurrent().lastSeenAt).toBeNull();
            await act(async () => storage.getState().applyMachineActivityUpdates([
                { id: machine.id, active: false, activeAt: machine.activeAt },
            ], { sourceServerId: serverId }));
            expect(hook.getCurrent().lastSeenAt).toBe(machine.activeAt);
        } finally { await hook.unmount(); }
    });

    it('withdraws the active-Home fallback when selection moves without a Machine publication', async () => {
        const otherHome = await home.addHome({ name: 'Other fallback Home', serverUrl: 'https://fallback-other.example.test',
            serverIdentityId: 'srv_other_fallback', accountId: 'account-b', active: false });
        const machine = createMachineFixture({ id: 'active-only', activeAt: Date.now() });
        storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: {}, machineListStatusByServerId: {} });
        const hook = await renderHook(() => useMachinePresenceSummary(serverId, machine.id));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().reachability).toBe('reachable'));
            const before = storage.getState();
            await act(async () => { await serverProfiles.setActiveServerId(otherHome, { scope: 'device' }); });
            expect(storage.getState().machines).toBe(before.machines);
            expect(storage.getState().machineListByServerId).toBe(before.machineListByServerId);
            expect(hook.getCurrent()).toMatchObject({ name: null, reachability: 'unknown', machineIsKnown: false });
        } finally { await hook.unmount(); }
    });

    it.each(['request', 'deadline'] as const)('catches a %s transition between the initial read and subscription', async transition => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const now = Date.now();
        vi.setSystemTime(now);
        const machine = createMachineFixture({ id: 'subscription-race', activeAt: now });
        const scope = { serverId, accountId: 'account-a' };
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        const targets = [{ serverId, machineIds: [machine.id] }];
        const readMachines = () => [machine];
        const readSnapshot = (at: number) => resolveMachineReachability(scope, machine, at);
        const hook = await renderHook(() => {
            React.useLayoutEffect(() => {
                if (transition === 'request') recordMachineRequestFailed({ ...scope, machineId: machine.id });
                else vi.setSystemTime(now + 100_000);
            }, []);
            return useMachinePresenceSnapshot(readMachines, readSnapshot, targets);
        });
        try { expect(hook.getCurrent()).toBe('unreachable'); }
        finally { await hook.unmount(); }
    });

    it('shares withdrawn unknown presence and fresh offline recovery with membership without losing identity', async () => {
        const scope = { serverId, accountId: 'account-a' };
        const now = Date.now();
        const machine = createMachineFixture({ id: 'reconnecting-machine', active: true, activeAt: now });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        const hook = await renderHook(() => ({
            summary: useMachinePresenceSummary(serverId, machine.id),
            membership: useMachinePresenceMembership(serverId),
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().summary.reachability).toBe('reachable'));
        const name = hook.getCurrent().summary.name;
        try {
            await act(async () => { withdrawMachinePresenceForScope(scope); });
            expect(hook.getCurrent().summary).toMatchObject({ name, reachability: 'unknown', lastSeenAt: null });
            expect(hook.getCurrent().membership.onlineMachineIds).toEqual([]);
            expect(hook.getCurrent().membership.selectableMachineIds).toEqual([]);
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(now + 97_000);
            await act(async () => {
                storage.getState().applyMachines([{ ...machine, active: false, activeAt: now + 1 }], false, { sourceServerId: serverId });
                captureMachinePresenceObservation(scope)([machine.id]);
            });
            expect(hook.getCurrent().summary).toMatchObject({ name, reachability: 'unreachable', lastSeenAt: now + 1 });
            expect(hook.getCurrent().membership.onlineMachineIds).toEqual([]);
            await act(async () => {
                storage.getState().applyMachines([{ ...machine, activeAt: Date.now() }], false, { sourceServerId: serverId });
            });
            expect(hook.getCurrent().summary.reachability).toBe('reachable');
            expect(hook.getCurrent().membership.onlineMachineIds).toEqual([machine.id]);
        } finally { await hook.unmount(); }
    });
    it('does not reacquire the profile resolver per Machine in presence snapshots', async () => {
        const rows = Array.from({ length: 100 }, (_, index) => createMachineFixture({ id: `perf-b3-${index}`, activeAt: Date.now() }));
        storage.getState().applyMachines(rows, true, { sourceServerId: serverId });
        const ids = rows.map(row => row.id);
        const owner = await renderHook(() => useServerCredentialAccountScopeBinding(serverId));
        await waitForHomeGovernance(() => expect(owner.getCurrent().binding).not.toBeNull());
        const lifetime = owner.getCurrent().binding!;
        const hook = await renderHook(() => ({
            membership: useMachinePresenceMembership(serverId, lifetime),
            summaries: useMachinePresenceSummaries(serverId, ids),
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().summaries.every(row => row.reachability === 'reachable')).toBe(true));
        const resolve = vi.spyOn(serverProfiles, 'resolveServerProfileScopeIdForIdentifier');
        try {
            for (let index = 0; index < 3; index++) await act(async () => {
                storage.setState(state => ({ machineListByServerId: { ...state.machineListByServerId } }));
            });
            expect(resolve).not.toHaveBeenCalled();
            expect(hook.getCurrent().membership.onlineMachineIds).toHaveLength(100);
        } finally { resolve.mockRestore(); await hook.unmount(); await owner.unmount(); }
    });

    it('selects a full Home in linear inventory visits when an observed row changes', async () => {
        const rows = Array.from({ length: 100 }, (_, index) => createMachineFixture({ id: `bulk-presence-${index}`, activeAt: Date.now() }));
        storage.getState().applyMachines(rows, true, { sourceServerId: serverId });
        storage.setState(state => ({ machineListStatusByServerId: { ...state.machineListStatusByServerId, [serverId]: 'idle' } }));
        const ids = rows.map(row => row.id);
        const hook = await renderHook(() => useMachinePresenceSummaries(serverId, ids));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().every(row => row.reachability === 'reachable')).toBe(true));
            const firstName = hook.getCurrent()[0]!.name;
            const current = storage.getState().machineListByServerId[serverId]!;
            const changed = current.map((row, index) => index === 99 ? { ...row, metadataVersion: 2,
                metadata: { ...row.metadata!, displayName: 'Changed last Machine' } } : row);
            let rowVisits = 0;
            const measured = new Proxy(changed, { get(target, property, receiver) {
                if (typeof property === 'string' && /^\d+$/.test(property)) rowVisits += 1;
                return Reflect.get(target, property, receiver);
            } });
            await act(async () => storage.setState(state => ({ machineListByServerId: { ...state.machineListByServerId, [serverId]: measured } })));
            expect(hook.getCurrent()[99]!.name).toBe('Changed last Machine');
            // One changed-Home publication needs the selected input, deadline and
            // presentation passes; none may search the entire array per requested ID.
            expect(rowVisits).toBeLessThanOrEqual(3 * rows.length);
            await act(async () => storage.setState(state => ({ machineListByServerId: { ...state.machineListByServerId,
                [serverId]: [...changed, { ...changed[0]!, metadata: { ...changed[0]!.metadata!, displayName: 'Later duplicate must not win' } }],
            } })));
            expect(hook.getCurrent()[0]!.name).toBe(firstName);
        } finally { await hook.unmount(); }
    });
    it('observes only the requested Machine name/home and remains inert without a retained target', async () => {
        const previous = storage.getState();
        const machine = createMachineFixture({ id: 'machine', activeAt: Date.now(), metadata: {
            ...createMachineFixture().metadata!, displayName: 'Retained computer', homeDir: '/home/retained',
        } });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        let renders = 0;
        const hook = await renderHook((id: string | null) => {
            renders++;
            return useMachinePresenceSummary(serverId, id);
        }, { initialProps: null as string | null });
        try {
            const inactive = renders;
            await act(async () => storage.getState().applyMachines([createMachineFixture({ id: 'other' })], false, { sourceServerId: serverId }));
            expect(renders).toBe(inactive);
            expect(await hook.rerender('machine')).toMatchObject({ name: 'Retained computer', homeDir: '/home/retained' });
            const admitted = hook.getCurrent(), active = renders;
            await act(async () => storage.getState().applyMachines([createMachineFixture({ id: 'other', updatedAt: 2 })], false, { sourceServerId: serverId }));
            expect(renders).toBe(active);
            expect(hook.getCurrent()).toBe(admitted);
            await act(async () => storage.getState().applyMachines([{ ...machine, metadata: { ...machine.metadata!,
                displayName: 'Renamed retained computer', homeDir: '/home/renamed',
            } }], false, { sourceServerId: serverId }));
            expect(hook.getCurrent()).toMatchObject({ name: 'Renamed retained computer', homeDir: '/home/renamed' });
            expect(await hook.rerender(null)).toMatchObject({ name: null, homeDir: null });
        } finally {
            await hook.unmount();
            storage.setState(previous, true);
        }
    });
    it('publishes membership immediately from an already admitted exact Home Account lifetime', async () => {
        const previous = storage.getState();
        storage.getState().applyMachines([createMachineFixture({ id: 'machine', activeAt: Date.now() })], true,
            { sourceServerId: serverId });
        try {
            const owner = await renderHook(() => useServerCredentialAccountScopeBinding(serverId));
            await waitForHomeGovernance(() => expect(owner.getCurrent().binding).not.toBeNull());
            const lifetime = owner.getCurrent().binding!;
            const publications: ReturnType<typeof useMachinePresenceMembership>[] = [];
            const hook = await renderHook(() => {
                const membership = useMachinePresenceMembership(serverId, lifetime);
                publications.push(membership);
                return membership;
            });
            expect(publications[0]).toEqual({ onlineMachineIds: ['machine'], selectableMachineIds: ['machine'], counts: { online: 1, offline: 0, unknown: 0 } });
            await hook.unmount();
            await owner.unmount();
        } finally { storage.setState(previous); }
    });

    it('keeps an explicitly missing, mismatched or retired supplied Account owner inert without routed fallback', async () => {
        const previous = storage.getState();
        await home.addHome({ name: 'Other Home', serverUrl: 'https://other-presence.example.test',
            serverIdentityId: 'srv_other_presence', accountId: 'account-b' });
        storage.getState().applyMachines([createMachineFixture({ id: 'machine', activeAt: Date.now() })], true,
            { sourceServerId: serverId });
        try {
            const owners = await renderHook(() => useServerCredentialAccountScopeBindings([serverId, 'srv_other_presence']));
            await waitForHomeGovernance(() => expect(owners.getCurrent().size).toBe(2));
            const lifetime = [...owners.getCurrent().values()].find(value => value.scope.accountId === 'account-a')!;
            const foreignLifetime = [...owners.getCurrent().values()].find(value => value.scope.accountId === 'account-b')!;
            expect(lifetime.isCurrent()).toBe(true);
            expect(foreignLifetime.isCurrent()).toBe(true);
            let supplied: ServerAccountScopeLifetime | null = null;
            const hook = await renderHook(() => useMachinePresenceMembership(serverId, supplied));
            expect(hook.getCurrent()).toEqual({ onlineMachineIds: [], selectableMachineIds: [], counts: { online: 0, offline: 0, unknown: 1 } });
            supplied = lifetime;
            await hook.rerender();
            expect(hook.getCurrent().onlineMachineIds).toEqual(['machine']);
            supplied = foreignLifetime;
            await hook.rerender();
            expect(hook.getCurrent()).toEqual({ onlineMachineIds: [], selectableMachineIds: [], counts: { online: 0, offline: 0, unknown: 1 } });
            supplied = lifetime;
            await hook.rerender();
            expect(hook.getCurrent().onlineMachineIds).toEqual(['machine']);
            await act(async () => { await home.switchAccount(serverId, 'account-c'); });
            expect(lifetime.isCurrent()).toBe(false);
            expect(hook.getCurrent()).toEqual({ onlineMachineIds: [], selectableMachineIds: [], counts: { online: 0, offline: 0, unknown: 1 } });
            await hook.unmount();
            await owners.unmount();
        } finally { storage.setState(previous); }
    });

    it('keeps the captured presence snapshot until a source or the shared deadline clock advances', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const now = Date.now();
        vi.setSystemTime(now);
        const previous = storage.getState();
        const machine = createMachineFixture({ id: 'machine', activeAt: now });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        try {
            const hook = await renderHook(() => ({
                membership: useMachinePresenceMembership(serverId),
                summary: useMachinePresenceSummary(serverId, 'machine'),
            }));
            const captured = hook.getCurrent();
            expect(captured.membership.onlineMachineIds).toEqual(['machine']);
            expect(captured.summary.reachability).toBe('reachable');

            // A delayed renderer can cross a lease deadline between React's two
            // snapshot reads before the subscribed clock callback gets to run.
            vi.setSystemTime(now + 60_001);
            await hook.rerender();
            expect(hook.getCurrent().membership).toBe(captured.membership);
            expect(hook.getCurrent().summary).toBe(captured.summary);

            await act(async () => {
                vi.advanceTimersByTime(60_001);
            });
            expect(hook.getCurrent().membership.onlineMachineIds).toEqual([]);
            expect(hook.getCurrent().summary.reachability).toBe('unreachable');

            await act(async () => {
                storage.getState().applyMachines([{ ...machine, activeAt: Date.now() }], false, { sourceServerId: serverId });
            });
            expect(hook.getCurrent().membership.onlineMachineIds).toEqual(['machine']);
            expect(hook.getCurrent().summary.reachability).toBe('reachable');
            await hook.unmount();
        } finally { storage.setState(previous); }
    });
    it('keeps locked machines in presence inventory without admitting them to the selectable fleet', async () => {
        const previous = storage.getState();
        const machine = createMachineFixture({ id: 'locked-machine', active: true, activeAt: Date.now(),
            availability: { kind: 'locked', reason: 'encryption_material_unavailable' } });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        try {
            const hook = await renderHook(() => useMachinePresenceMembership(serverId));
            expect(hook.getCurrent()).toEqual({ onlineMachineIds: ['locked-machine'], selectableMachineIds: [], counts: { online: 1, offline: 0, unknown: 0 } });
            await hook.unmount();
        } finally { storage.setState(previous); }
    });
    it('keeps app membership stable across presentation and heartbeat changes, but reacts to expiry and request recovery', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(Date.now());
        const previous = storage.getState();
        const machine = createMachineFixture({ id: 'machine', activeAt: Date.now() });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        try {
            let renders = 0;
            const hook = await renderHook(() => {
                renders += 1;
                return useMachinePresenceMembership(serverId);
            });
            const admitted = hook.getCurrent();
            const rendersAfterAdmission = renders;
            expect(admitted).toEqual({ onlineMachineIds: ['machine'], selectableMachineIds: ['machine'], counts: { online: 1, offline: 0, unknown: 0 } });
            await act(async () => {
                vi.advanceTimersByTime(20_000);
                storage.getState().applyMachines([{ ...machine, activeAt: Date.now(), metadata: {
                    ...machine.metadata!, displayName: 'Renamed computer',
                } }], false, { sourceServerId: serverId });
            });
            expect(hook.getCurrent()).toBe(admitted);
            expect(renders).toBe(rendersAfterAdmission);
            await act(async () => { vi.advanceTimersByTime(40_001); });
            expect(hook.getCurrent()).toBe(admitted);
            expect(renders).toBe(rendersAfterAdmission);

            await act(async () => {
                recordMachineRequestFailed({ serverId, accountId: 'account-a', machineId: 'machine' });
            });
            expect(hook.getCurrent()).toEqual({ onlineMachineIds: [], selectableMachineIds: [], counts: { online: 0, offline: 1, unknown: 0 } });
            await act(async () => { vi.advanceTimersByTime(20_000); });
            expect(hook.getCurrent()).toEqual({ onlineMachineIds: [], selectableMachineIds: [], counts: { online: 0, offline: 1, unknown: 0 } });
            await act(async () => {
                storage.getState().applyMachines([{ ...machine, activeAt: Date.now() }], false, { sourceServerId: serverId });
            });
            expect(hook.getCurrent()).toEqual({ onlineMachineIds: [], selectableMachineIds: [], counts: { online: 0, offline: 1, unknown: 0 } });
            await act(async () => {
                recordMachineRequestSucceeded({ serverId, accountId: 'account-a', machineId: 'machine' });
            });
            expect(hook.getCurrent()).toEqual({ onlineMachineIds: ['machine'], selectableMachineIds: ['machine'], counts: { online: 1, offline: 0, unknown: 0 } });
            await act(async () => { storage.getState().applyMachines([], true, { sourceServerId: serverId }); });
            expect(hook.getCurrent()).toEqual({ onlineMachineIds: [], selectableMachineIds: [], counts: { online: 0, offline: 0, unknown: 0 } });
            await hook.unmount();
        } finally { storage.setState(previous); }
    });

    it('expires without another store notification and recovers on a heartbeat, while unknown is not offline', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(Date.now());
        const previous = storage.getState();
        const machine = createMachineFixture({ id: 'machine', activeAt: Date.now() });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        try {
            const hook = await renderHook(() => useMachinePresenceSummary(serverId, 'machine'));
            expect(hook.getCurrent().reachability).toBe('reachable');
            const admitted = hook.getCurrent();
            await act(async () => {
                vi.advanceTimersByTime(20_000);
                const heartbeat = { ...machine, activeAt: Date.now() };
                storage.getState().applyMachines([heartbeat], false, { sourceServerId: serverId });
            });
            expect(hook.getCurrent()).toBe(admitted);
            await act(async () => { vi.advanceTimersByTime(40_001); });
            expect(hook.getCurrent().reachability).toBe('reachable');
            await act(async () => { vi.advanceTimersByTime(20_000); });
            expect(hook.getCurrent().reachability).toBe('unreachable');
            const refreshed = { ...machine, activeAt: Date.now() };
            await act(async () => { storage.getState().applyMachines([refreshed], false, { sourceServerId: serverId }); });
            expect(hook.getCurrent().reachability).toBe('reachable');
            await act(async () => { storage.getState().applyMachines([], true, { sourceServerId: serverId }); });
            expect(hook.getCurrent().reachability).toBe('unknown');
            await hook.unmount();
        } finally { storage.setState(previous); }
    });

    it('keeps a present machine unreachable after a heartbeat until a request succeeds', async () => {
        const now = Date.now();
        const previous = storage.getState();
        const machine = createMachineFixture({ id: 'machine', activeAt: now });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        try {
            const hook = await renderHook(() => useMachinePresenceSummary(serverId, 'machine'));
            expect(hook.getCurrent().reachability).toBe('reachable');

            await act(async () => {
                recordMachineRequestFailed({ serverId, accountId: 'account-a', machineId: 'machine', observedAtMs: now + 1 });
            });

            expect(hook.getCurrent().reachability).toBe('unreachable');

            await act(async () => {
                const heartbeat = { ...machine, activeAt: now + 2 };
                storage.getState().applyMachines([heartbeat], false, { sourceServerId: serverId });
            });
            expect(hook.getCurrent().reachability).toBe('unreachable');

            await act(async () => {
                recordMachineRequestSucceeded({ serverId, accountId: 'account-a', machineId: 'machine', observedAtMs: now + 3 });
            });
            expect(hook.getCurrent().reachability).toBe('reachable');
            await hook.unmount();
        } finally {
            storage.setState(previous);
        }
    });
});
