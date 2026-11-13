import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { publishMachineActivity, readMachineActivity } from '@/sync/domains/machines/machineActivity';
import { captureMachinePresenceObservation, clearMachineRequestReachabilityForTest, recordMachineRequestFailed, withdrawMachinePresenceForScope } from '@/sync/domains/machines/reachability/machineReachability';

const home = createHomeGovernanceHarness();
const homeIdentityId = 'srv_counts';
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
const { useMachinePresenceCounts } = await import('@/sync/domains/state/storage');
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } =
    await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');

beforeEach(async () => {
    await loadSyncSingletonForTests();
    await home.reset();
    await home.addHome({ name: 'Counts Home', serverUrl: 'https://counts.example.test',
        serverIdentityId: homeIdentityId, accountId: 'account' });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    storage.setState({ profileScope: { serverId: homeIdentityId, accountId: 'account' },
        machines: {}, machineDisplayById: {}, machineListByServerId: {}, machineListStatusByServerId: {},
        machineRecordsByServerId: {},
        machinePresenceById: {}, machinePresenceByServerId: {},
    });
});

afterEach(async () => {
    clearMachineRequestReachabilityForTest();
    await standardCleanup();
    vi.useRealTimers();
    await home.reset();
});

const DAY_MS = 24 * 60 * 60 * 1000;

function machine(id: string, overrides: Partial<Machine> = {}): Machine {
    return {
        id,
        seq: 1,
        createdAt: 1000,
        updatedAt: 1000,
        active: true,
        activeAt: Date.now(),
        metadata: { host: id, platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
        revokedAt: null,
        presenceProtocolVersion: 1,
        // Presence follows presenceProtocolVersion; capabilities only distinguish a current daemon from a legacy one.
        operationProtocolCapabilities: { sessionMessageReply: { protocolVersions: [1] } },
        operationProtocolCapabilitiesRevision: 1,
        ...overrides,
    };
}

async function setHomeMachines(machines: readonly Machine[]) {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim() || 'server-active';
    await publishMachineInventoryForTest({ serverId: activeServerId, accountId: 'account' }, machines);
}

describe('useMachinePresenceCounts', () => {
    it('keeps mixed-version grace live until its exact boundary, including held heartbeats', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(100_000);
        const serverId = getActiveServerSnapshot().serverId;
        const options = { sourceServerId: serverId, sourceAccountId: 'account' };
        const legacy = machine('legacy', { operationProtocolCapabilities: null,
            operationProtocolCapabilitiesRevision: null });
        delete legacy.presenceProtocolVersion;
        storage.getState().applyMachines([legacy], true, options);
        storage.getState().markMachineListSettled(serverId);
        const hook = await renderHook(() => useMachinePresenceCounts());
        try {
            await act(async () => {
                vi.advanceTimersByTime(40_000);
                const state = storage.getState();
                publishMachineActivity(legacy, { active: true, activeAt: Date.now() },
                    [state.machines.legacy, ...(state.machineListByServerId[serverId] ?? [])]);
            });
            await act(async () => { vi.advanceTimersByTime(60_000); });
            expect(hook.getCurrent()).toEqual({ online: 1, offline: 0, unknown: 0 });
            await act(async () => { vi.advanceTimersByTime(1); });
            expect(hook.getCurrent()).toEqual({ online: 0, offline: 1, unknown: 0 });
        } finally { await hook.unmount(); }
    });
    it('keeps heartbeat clocks quiet and follows pushed inactivity instead of a client grace deadline', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(Date.now());
        const serverId = getActiveServerSnapshot().serverId;
        const options = { sourceServerId: serverId, sourceAccountId: 'account' };
        storage.getState().applyMachines([machine('laptop')], true, options);
        storage.getState().markMachineListSettled(serverId);
        let renders = 0;
        const hook = await renderHook(() => { renders++; return useMachinePresenceCounts(); });
        const before = renders;
        const root = vi.fn();
        const stopRoot = storage.subscribe(root);
        try {
            for (let tick = 0; tick < 4; tick++) {
                await act(async () => {
                    vi.advanceTimersByTime(20_000);
                    storage.getState().applyMachineActivityUpdates([{ id: 'laptop', active: true, activeAt: Date.now() }], options);
                });
                expect(hook.getCurrent()).toEqual({ online: 1, offline: 0, unknown: 0 });
            }
            expect(root).not.toHaveBeenCalled();
            expect(renders).toBe(before);
            await act(async () => { vi.advanceTimersByTime(60_000); });
            expect(hook.getCurrent()).toEqual({ online: 1, offline: 0, unknown: 0 });
            await act(async () => { vi.advanceTimersByTime(1); });
            expect(hook.getCurrent()).toEqual({ online: 1, offline: 0, unknown: 0 });
            expect(root).not.toHaveBeenCalled();
            await act(async () => { storage.getState().applyMachineActivityUpdates([
                { id: 'laptop', active: false, activeAt: Date.now() - 60_001 },
            ], options); });
            expect(hook.getCurrent()).toEqual({ online: 0, offline: 1, unknown: 0 });
        } finally { stopRoot(); await hook.unmount(); }
    });
    it('retains answered presence across socket withdrawal and follows only its scoped Machine publication', async () => {
        const rows = [machine('laptop'), machine('studio', { active: false, activeAt: Date.now() - 2 * DAY_MS })];
        await setHomeMachines(rows);
        let renders = 0;
        const hook = await renderHook(() => { renders++; return useMachinePresenceCounts(); });
        const scope = { serverId: homeIdentityId, accountId: 'account' };
        const initial = hook.getCurrent();
        const before = renders;
        try {
            expect(initial).toEqual({ online: 1, offline: 1, unknown: 0 });
            await act(async () => {
                withdrawMachinePresenceForScope(scope);
                captureMachinePresenceObservation({ ...scope, accountId: 'another-account' })(['laptop', 'studio']);
                captureMachinePresenceObservation({ ...scope, serverId: 'another-home' })(['laptop', 'studio']);
                captureMachinePresenceObservation(scope)(['laptop', 'studio']);
            });
            expect(hook.getCurrent()).toBe(initial);
            expect(renders).toBe(before);
            const update = { id: 'laptop', active: false, activeAt: rows[0]!.activeAt };
            await act(async () => {
                storage.getState().applyMachineActivityUpdates([update], { sourceServerId: scope.serverId, sourceAccountId: 'another-account' });
            });
            expect(hook.getCurrent()).toBe(initial);
            await act(async () => {
                storage.getState().applyMachineActivityUpdates([update], { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
            });
            expect(hook.getCurrent()).toEqual({ online: 0, offline: 2, unknown: 0 });
        } finally { await hook.unmount(); }
    });

    it('retains pushed inactivity without further arrivals or clock-driven renders', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(Date.now());
        const activeAt = Date.now();
        const options = { sourceServerId: getActiveServerSnapshot().serverId, sourceAccountId: 'account' };
        storage.getState().applyMachines([machine('laptop', { activeAt })], true, options);
        storage.getState().markMachineListSettled(options.sourceServerId);
        let renders = 0;
        const hook = await renderHook(() => { renders++; return useMachinePresenceCounts(); });
        try {
            await act(async () => { storage.getState().applyMachineActivityUpdates([
                { id: 'laptop', active: false, activeAt },
            ], options); });
            expect(hook.getCurrent()).toEqual({ online: 0, offline: 1, unknown: 0 });
            const offline = hook.getCurrent();
            const before = renders;
            await act(async () => { vi.advanceTimersByTime(2 * DAY_MS); });
            expect(hook.getCurrent()).toBe(offline);
            expect(renders).toBe(before);
        } finally { await hook.unmount(); }
    });

    it('recovers from pushed inactivity only on a newer heartbeat while preserving the earlier snapshot', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(Date.now());
        const serverId = getActiveServerSnapshot().serverId;
        storage.getState().applyMachines([machine('laptop')], true, { sourceServerId: serverId, sourceAccountId: 'account' });
        storage.getState().markMachineListSettled(serverId);
        const hook = await renderHook(() => useMachinePresenceCounts());
        try {
            expect(hook.getCurrent()).toEqual({ online: 1, offline: 0, unknown: 0 });
            const activeAt = Date.now();
            await act(async () => { storage.getState().applyMachineActivityUpdates([
                { id: 'laptop', active: false, activeAt },
            ], { sourceServerId: serverId, sourceAccountId: 'account' }); });
            expect(hook.getCurrent()).toEqual({ online: 0, offline: 1, unknown: 0 });
            const before = storage.getState();
            expect(readMachineActivity(before.machines.laptop)).toMatchObject({ active: false, activeAt });
            await act(async () => {
                storage.getState().applyMachineActivityUpdates([{ id: 'laptop', active: true, activeAt }],
                    { sourceServerId: serverId, sourceAccountId: 'account' });
            });
            expect(hook.getCurrent()).toEqual({ online: 0, offline: 1, unknown: 0 });
            expect(storage.getState()).toBe(before);
            await act(async () => {
                vi.advanceTimersByTime(1);
                storage.getState().applyMachines([machine('laptop')], false, { sourceServerId: serverId, sourceAccountId: 'account' });
            });
            expect(before.machines.laptop.active).toBe(true);
            expect(readMachineActivity(before.machines.laptop)).toMatchObject({ active: true, activeAt: activeAt + 1 });
            expect(hook.getCurrent()).toEqual({ online: 1, offline: 0, unknown: 0 });
        } finally { await hook.unmount(); }
    });

    it('moves a machine offline on a failed request and does not recover on a subsequent heartbeat', async () => {
        const previousState = storage.getState();
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const serverId = String(getActiveServerSnapshot().serverId ?? '').trim() || 'server-active';
        const now = Date.now();
        try {
            // Request observations belong to the authenticated Home; retain the real scope owners.
            publishAppliedActiveServerSnapshot({ ...getActiveServerSnapshot(), serverId });
            storage.setState({ profileScope: { serverId, accountId: 'account' } });
            await setHomeMachines([machine('laptop', { activeAt: now })]);
            const hook = await renderHook(() => useMachinePresenceCounts(), { flushOptions: { cycles: 1, turns: 4 } });
            expect(hook.getCurrent()).toEqual({ online: 1, offline: 0, unknown: 0 });

            await act(async () => {
                recordMachineRequestFailed({ serverId: homeIdentityId, accountId: 'account', machineId: 'laptop', observedAtMs: now + 1 });
            });
            expect(hook.getCurrent()).toEqual({ online: 0, offline: 1, unknown: 0 });
            await act(async () => {
                await setHomeMachines([machine('laptop', { activeAt: now + 2 })]);
            });
            expect(hook.getCurrent()).toEqual({ online: 0, offline: 1, unknown: 0 });
            await hook.unmount();
        } finally {
            storage.setState(previousState);
            publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
        }
    });

    it('counts the Home machines online and offline, leaving out revoked and replaced identities', async () => {
        const previousState = storage.getState();
        try {
            await setHomeMachines([
                machine('laptop'),
                machine('devbox'),
                machine('studio', { active: false, activeAt: Date.now() - 2 * DAY_MS }),
                machine('gone', { revokedAt: Date.now() }),
                // An identity replaced by a newer one (a reinstall) is not a machine that is offline.
                machine('old-laptop', { active: false, activeAt: Date.now() - 9 * DAY_MS, replacedByMachineId: 'laptop' }),
            ]);
            const hook = await renderHook(() => useMachinePresenceCounts(), { flushOptions: { cycles: 1, turns: 4 } });

            expect(hook.getCurrent()).toEqual({ online: 2, offline: 1, unknown: 0 });
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps the closed summary still while machines change without changing the counts, and follows a presence change', async () => {
        const previousState = storage.getState();
        try {
            await setHomeMachines([machine('laptop'), machine('studio', { active: false, activeAt: Date.now() - 2 * DAY_MS })]);
            let renders = 0;
            const hook = await renderHook(() => {
                renders += 1;
                return useMachinePresenceCounts();
            }, { flushOptions: { cycles: 1, turns: 4 } });
            const first = hook.getCurrent();
            const rendersBefore = renders;
            const options = { sourceServerId: getActiveServerSnapshot().serverId, sourceAccountId: 'account' };

            // A heartbeat and a metadata edit: every machine object is replaced, the counts are not.
            await act(async () => {
                storage.getState().applyMachines([
                    machine('laptop', { activeAt: Date.now(), metadataVersion: 2 }),
                    machine('studio', { active: false, activeAt: Date.now() - 2 * DAY_MS, updatedAt: 2000 }),
                ], true, options);
            });
            expect(renders).toBe(rendersBefore);
            expect(hook.getCurrent()).toBe(first);

            // Studio wakes up: the summary follows.
            await act(async () => {
                storage.getState().applyMachines([machine('laptop'), machine('studio')], true, options);
            });
            expect(hook.getCurrent()).toEqual({ online: 2, offline: 0, unknown: 0 });
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
