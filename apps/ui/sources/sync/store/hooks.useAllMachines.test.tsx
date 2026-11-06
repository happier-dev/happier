import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { MachinePublishedResourceSummaryV1Schema } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';

import {
    useAllMachines,
    useLaunchSelectionMachines,
    useMachineListByServerId,
    useMachineRecordListsByServerId,
    useMachineListForServer,
    useMachineListStatusForServer,
    useSessionForkSupportSource,
    useSessionChatFooterState,
} from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { readMachineOnlineGraceMsFromEnv } from '@/utils/sessions/machineUtils';
import { readMachineActivity } from '@/sync/domains/machines/machineActivity';

afterEach(() => {
    standardCleanup();
});

describe('useAllMachines', () => {
    it('refreshes launch admission when daemon content catches up to its published key basis', async () => {
        const previousState = storage.getState();
        const serverId = getActiveServerSnapshot().serverId;
        const machine = createMachineFixture({ metadataVersion: 1, daemonStateVersion: 1,
            keyBasis: { dataEncryptionKey: 'fixture-envelope', metadataVersion: 1, daemonStateVersion: 2 } });
        try {
            storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
            const hook = await renderHook(() => ({ machines: useLaunchSelectionMachines(), lists: useMachineListByServerId(true, 'launch') }));
            const held = hook.getCurrent();
            const caughtUp = { ...machine, daemonStateVersion: 2 };
            await act(async () => storage.setState({ machines: { [machine.id]: caughtUp }, machineListByServerId: { [serverId]: [caughtUp] } }));
            expect(hook.getCurrent()).not.toBe(held);
            expect(hook.getCurrent().machines[0]).toEqual(caughtUp);
            expect(hook.getCurrent().lists[serverId]?.[0]).toEqual(caughtUp);
            const ready = hook.getCurrent();
            const pending = { ...caughtUp, keyBasis: { ...caughtUp.keyBasis!, daemonStateVersion: 3 } };
            await act(async () => storage.setState({ machines: { [machine.id]: pending }, machineListByServerId: { [serverId]: [pending] } }));
            expect(hook.getCurrent()).not.toBe(ready);
            expect(hook.getCurrent().machines[0]).toEqual(pending);
            expect(hook.getCurrent().lists[serverId]?.[0]).toEqual(pending);
            const waiting = hook.getCurrent();
            const opened = { ...pending, daemonStateVersion: 3 };
            await act(async () => storage.setState({ machines: { [machine.id]: opened }, machineListByServerId: { [serverId]: [opened] } }));
            expect(hook.getCurrent()).not.toBe(waiting);
            expect(hook.getCurrent().machines[0]).toEqual(opened);
            expect(hook.getCurrent().lists[serverId]?.[0]).toEqual(opened);
            await hook.unmount();
        } finally { storage.setState(previousState); }
    });
    it('keeps visible launch inputs stable across resource versions while observing launch changes', async () => {
        const previousState = storage.getState();
        const serverId = getActiveServerSnapshot().serverId;
        const now = 1_800_000_000_000;
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        const machine = createMachineFixture({ activeAt: now, daemonStateVersion: 1,
            keyBasis: { dataEncryptionKey: 'owner-envelope', metadataVersion: 1, daemonStateVersion: 1 },
            daemonState: { contributionRegistryProjectionRevision: 1 } });
        let renders = 0;
        try {
            storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
            const hook = await renderHook(() => {
                renders += 1;
                return { machines: useLaunchSelectionMachines(), lists: useMachineListByServerId(true, 'launch') };
            });
            const held = hook.getCurrent();
            const before = renders;
            const full = await renderHook(() => useMachineRecordListsByServerId());
            let latest = machine;
            for (let tick = 1; tick <= 5; tick += 1) {
                const at = now + tick * readMachineOnlineGraceMsFromEnv() / 2;
                clock.mockReturnValue(at);
                latest = { ...latest, seq: latest.seq + 1, daemonStateVersion: tick + 1, activeAt: at, updatedAt: at,
                    keyBasis: { ...latest.keyBasis!, daemonStateVersion: tick + 1 },
                    daemonState: { ...latest.daemonState, resources: MachinePublishedResourceSummaryV1Schema.parse({
                        v: 1, vitals: { state: 'unavailable', since: tick, reason: 'reader_failed' }, attention: { level: 'calm', reasons: [] },
                    }) } };
                await act(async () => storage.getState().applyMachines([latest], false, { sourceServerId: serverId }));
                expect(hook.getCurrent()).toBe(held);
                // The real writer retains its current row on a heartbeat. A launch projection
                // held across the preceding resource replacement must follow that row too.
                latest = { ...latest, activeAt: at + 1, updatedAt: at + 1 };
                await act(async () => storage.getState().applyMachines([latest], false, { sourceServerId: serverId }));
                expect(readMachineActivity(held.machines[0]!).activeAt).toBe(at + 1);
                expect(readMachineActivity(held.lists[serverId]![0]!).activeAt).toBe(at + 1);
            }
            expect(renders - before).toBe(0);
            expect(hook.getCurrent()).toBe(held);
            expect(full.getCurrent()[serverId]?.[0]?.daemonStateVersion).toBe(latest.daemonStateVersion);
            for (const change of [
                { keyBasis: { ...latest.keyBasis!, dataEncryptionKey: 'new-owner-envelope' } },
                { dataEncryptionKey: 'new-recipient-envelope' },
                { access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'use' as const,
                    resourceMode: 'e2ee' as const, accessState: 'key_pending' as const } },
                { metadata: { ...latest.metadata!, homeDir: '/new-home' }, metadataVersion: latest.metadataVersion + 1 },
                { daemonState: { ...latest.daemonState, contributionRegistryProjectionRevision: 2 } },
                { availability: { kind: 'locked' as const, reason: 'encryption_material_unavailable' as const } },
            ]) {
                latest = { ...latest, ...change, daemonStateVersion: latest.daemonStateVersion + 1 };
                await act(async () => storage.getState().applyMachines([latest], false, { sourceServerId: serverId }));
                expect(hook.getCurrent().machines[0]).toEqual(storage.getState().machines[machine.id]);
                expect(hook.getCurrent().lists[serverId]?.[0]).toEqual(storage.getState().machines[machine.id]);
            }
            const beforeRecovery = hook.getCurrent();
            clock.mockReturnValue(latest.activeAt + 1);
            await act(async () => storage.getState().applyMachines([{ ...latest, active: false, activeAt: Date.now(), updatedAt: Date.now() }], false,
                { sourceServerId: serverId }));
            expect(hook.getCurrent()).toBe(beforeRecovery);
            expect(readMachineActivity(hook.getCurrent().machines[0]!).active).toBe(false);
            expect(readMachineActivity(hook.getCurrent().lists[serverId]![0]!).active).toBe(false);
            await full.unmount();
            await hook.unmount();
        } finally { clock.mockRestore(); storage.setState(previousState); }
    });
    it('retains hidden launch inventory across resource publications and catches up on presentation', async () => {
        const previousState = storage.getState();
        const serverId = getActiveServerSnapshot().serverId;
        const machine = createMachineFixture({ activeAt: Date.now() });
        let renders = 0;
        try {
            storage.setState({ profileScope: { serverId, accountId: 'retained-launch-a' }, machines: { [machine.id]: machine },
                machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' } });
            const hook = await renderHook(({ presented }) => {
                renders += 1;
                return { machines: useLaunchSelectionMachines(presented), lists: useMachineListByServerId(presented) };
            }, { initialProps: { presented: true } });
            await hook.rerender({ presented: false });
            const held = hook.getCurrent();
            const before = renders;
            let latest = machine;
            for (let tick = 1; tick <= 5; tick += 1) {
                latest = { ...machine, daemonStateVersion: tick, daemonState: { resources: MachinePublishedResourceSummaryV1Schema.parse({
                    v: 1, vitals: { state: 'unavailable', since: tick, reason: 'reader_failed' }, attention: { level: 'calm', reasons: [] },
                }) } };
                await act(async () => storage.setState({ machines: { [machine.id]: latest },
                    machineListByServerId: { [serverId]: [latest] } }));
            }
            expect(renders - before).toBe(0);
            expect(hook.getCurrent()).toBe(held);
            await hook.rerender({ presented: true });
            expect(hook.getCurrent().machines[0]).toEqual(latest);
            expect(hook.getCurrent().lists[serverId]?.[0]).toBe(latest);
            await hook.rerender({ presented: false });
            await act(async () => storage.setState({ profileScope: null, machines: {}, machineListByServerId: {} }));
            expect(hook.getCurrent().machines).toEqual([]);
            expect(hook.getCurrent().lists).toEqual({});
            await hook.unmount();
        } finally { storage.setState(previousState); }
    });

    it('keeps concurrent launch snapshots stable when presence ages without an inventory change', async () => {
        const previousState = storage.getState();
        const now = 1_800_000_000_000;
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        const machine = createMachineFixture({ activeAt: now });
        const serverId = getActiveServerSnapshot().serverId;
        try {
            storage.setState({ machines: { [machine.id]: machine },
                machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' } });
            const first = await renderHook(() => useLaunchSelectionMachines());
            const firstSnapshot = first.getCurrent();
            const second = await renderHook(() => useLaunchSelectionMachines());
            const secondSnapshot = second.getCurrent();
            clock.mockReturnValue(now + readMachineOnlineGraceMsFromEnv() + 1);
            await second.rerender();
            await first.rerender();
            expect(first.getCurrent()).toBe(firstSnapshot);
            expect(second.getCurrent()).toBe(secondSnapshot);
            const replacement = { ...machine, metadata: { ...machine.metadata!, homeDir: '/new-home' } };
            await act(async () => storage.setState({ machines: { [machine.id]: replacement },
                machineListByServerId: { [serverId]: [replacement] } }));
            expect(first.getCurrent()[0]).toEqual(replacement);
            expect(second.getCurrent()[0]).toEqual(replacement);
            await first.unmount();
            await second.unmount();
        } finally {
            clock.mockRestore();
            storage.setState(previousState);
        }
    });
    it.each(['shared', 'exclusive'] as const)('retires and restores %s footer control through the real store', async (topology) => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 's-control-lifecycle', active: true,
            agentState: { controlledByUser: topology === 'exclusive', ...(topology === 'shared' ? {
                localControl: { attached: true, topology, remoteWritable: true, canDetach: true },
            } : {}) },
        });
        try {
            storage.setState((state) => ({ sessions: { ...state.sessions, [session.id]: session } }));
            const hook = await renderHook(() => useSessionChatFooterState(session.id), { flushOptions: { cycles: 1, turns: 4 } });
            const attached = hook.getCurrent();
            expect(attached?.localControl?.attached).toBe(true);
            expect(attached?.controlledByUser).toBe(topology === 'exclusive');
            await act(async () => {
                storage.setState((state) => ({ sessions: { ...state.sessions, [session.id]: {
                    ...session, updatedAt: session.updatedAt + 1,
                } } }));
            });
            expect(hook.getCurrent()).toBe(attached);
            await act(async () => {
                storage.setState((state) => ({ sessions: { ...state.sessions, [session.id]: { ...session, active: false } } }));
            });
            expect(hook.getCurrent()).toMatchObject({ controlledByUser: false, localControl: null });
            await act(async () => {
                storage.setState((state) => ({ sessions: { ...state.sessions, [session.id]: session } }));
            });
            expect(hook.getCurrent()).toEqual(attached);
            await act(async () => {
                storage.setState((state) => ({ sessions: { ...state.sessions, [session.id]: {
                    ...session, metadataLayoutVersion: 1, metadata: null, ownerMetadataView: { ...session.metadata!, terminal: {
                        mode: 'herdr', controlServiceabilityV1: { v: 1, attachmentId: 'retired-host', observedAt: 20,
                            state: 'unknown', retired: true },
                    } },
                } } }));
            });
            expect(hook.getCurrent()).toMatchObject({ controlledByUser: false, localControl: null });
            await act(async () => {
                storage.setState((state) => ({ sessions: { ...state.sessions, [session.id]: {
                    ...session, metadataLayoutVersion: 1, metadata: null, ownerMetadataView: { ...session.metadata!, terminal: {
                        mode: 'herdr', controlServiceabilityV1: { v: 1, attachmentId: 'preserved-host', observedAt: 21,
                            state: 'recoverable_unservable' },
                    } },
                } } }));
            });
            expect(hook.getCurrent()).toMatchObject({ controlledByUser: false, localControl: null });
            await act(async () => {
                storage.setState((state) => ({ sessions: { ...state.sessions, [session.id]: session } }));
            });
            expect(hook.getCurrent()).toEqual(attached);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('uses the exact Home row for fork support when duplicate ids are present', async () => {
        const previousState = storage.getState();
        try {
            const directHomeSession = createSessionFixture({
                id: 's-duplicate-fork',
                serverId: 'home-a',
                metadata: { path: '/repo-a', host: 'home-a', flavor: 'a' },
            });
            const requestedHomeSession = createSessionFixture({
                id: 's-duplicate-fork',
                serverId: 'home-b',
                metadata: { path: '/repo-b', host: 'home-b', flavor: 'b' },
            });
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { ...state.sessions, [directHomeSession.id]: directHomeSession },
                sessionListRowsByServerId: {
                    ...state.sessionListRowsByServerId,
                    'home-b': {
                        ...(state.sessionListRowsByServerId['home-b'] ?? {}),
                        [requestedHomeSession.id]: buildSessionListRenderableFromSession(requestedHomeSession),
                    },
                },
            }));

            const hook = await renderHook(
                () => useSessionForkSupportSource('s-duplicate-fork', 'home-b'),
                { flushOptions: { cycles: 1, turns: 4 } },
            );

            expect(hook.getCurrent()).toMatchObject({
                serverId: 'home-b',
                metadata: { path: '/repo-b', flavor: 'b' },
            });
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps one Home machine slices stable across unrelated Home updates', async () => {
        const previousState = storage.getState();
        const machineA = {
            id: 'machine-a',
            seq: 1,
            active: true,
            activeAt: 1000,
            createdAt: 1000,
            updatedAt: 1000,
            metadata: {
                host: 'home-a',
                platform: 'darwin',
                happyCliVersion: '1',
                happyHomeDir: '.happy',
                homeDir: '/home/a',
            },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 1,
            revokedAt: null,
        } satisfies Machine;
        const machineB = {
            id: 'machine-b',
            seq: 1,
            active: true,
            activeAt: 1000,
            createdAt: 1000,
            updatedAt: 1000,
            metadata: {
                host: 'home-b',
                platform: 'darwin',
                happyCliVersion: '1',
                happyHomeDir: '.happy',
                homeDir: '/home/b',
            },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 1,
            revokedAt: null,
        } satisfies Machine;
        let renderCount = 0;

        try {
            storage.setState((state) => ({
                ...state,
                machineListByServerId: {
                    'home-a': [machineA],
                    'home-b': [machineB],
                },
                machineListStatusByServerId: {
                    'home-a': 'idle',
                    'home-b': 'idle',
                },
            }));
            const hook = await renderHook(() => {
                renderCount += 1;
                return {
                    machines: useMachineListForServer('home-a'),
                    status: useMachineListStatusForServer('home-a'),
                };
            }, { flushOptions: { cycles: 1, turns: 4 } });
            const firstSnapshot = hook.getCurrent();
            const firstRenderCount = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    machineListByServerId: {
                        ...state.machineListByServerId,
                        'home-b': [{ ...machineB, activeAt: 2000 }],
                    },
                    machineListStatusByServerId: {
                        ...state.machineListStatusByServerId,
                        'home-b': 'loading',
                    },
                }));
            });

            expect(renderCount).toBe(firstRenderCount);
            expect(hook.getCurrent()).toBe(firstSnapshot);

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    machineListByServerId: {
                        ...state.machineListByServerId,
                        'home-a': [{ ...machineA, activeAt: 3000 }],
                    },
                    machineListStatusByServerId: {
                        ...state.machineListStatusByServerId,
                        'home-a': 'loading',
                    },
                }));
            });

            expect(renderCount).toBeGreaterThan(firstRenderCount);
            expect(hook.getCurrent()).not.toBe(firstSnapshot);
            expect(hook.getCurrent()).toMatchObject({ status: 'loading' });
            expect(hook.getCurrent().machines?.[0]?.activeAt).toBe(3000);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('returns cached machines even when bootstrap is not fully ready (avoids empty flicker)', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: false,
                machines: {
                    'm-cached': {
                        id: 'm-cached',
                        seq: 1,
                        createdAt: 1000,
                        updatedAt: 1000,
                        active: true,
                        activeAt: 1000,
                        metadata: { host: 'cached', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                    },
                },
            }));

            const hook = await renderHook(() => useAllMachines(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent().map((machine) => machine.id)).toEqual(['m-cached']);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps the active-server machine cache visible while bootstrap is still hydrating', async () => {
        const previousState = storage.getState();
        try {
            const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim() || 'server-active';
            storage.setState((state) => ({
                ...state,
                isDataReady: false,
                machines: {},
                machineListByServerId: {
                    [activeServerId]: [
                        {
                            id: 'm-scoped',
                            seq: 1,
                            createdAt: 1000,
                            updatedAt: 1000,
                            active: true,
                            activeAt: 1000,
                            metadata: { host: 'scoped', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                            metadataVersion: 1,
                            daemonState: null,
                            daemonStateVersion: 0,
                            revokedAt: null,
                        } as any,
                    ],
                },
            }));

            const hook = await renderHook(() => useAllMachines(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent().map((machine) => machine.id)).toEqual(['m-scoped']);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('does not rerender semantic and launch-selection consumers for an online heartbeat', async () => {
        const previousState = storage.getState();
        try {
            const activeAt = Date.now();
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machines: {},
                machineDisplayById: {},
                machinePresenceById: {},
                machinePresenceByServerId: {},
                machineListByServerId: {},
            }));

            const onlineMachine = {
                id: 'm-online',
                seq: 1,
                createdAt: activeAt,
                updatedAt: activeAt,
                active: true,
                activeAt,
                metadata: { host: 'online', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                revokedAt: null,
            } satisfies Machine;
            storage.getState().applyMachines([onlineMachine], true, { sourceServerId: getActiveServerSnapshot().serverId });

            let semanticRenders = 0;
            let launchRenders = 0;
            const hook = await renderHook(() => {
                semanticRenders += 1;
                const semanticMachines = useAllMachines();
                launchRenders += 1;
                const launchMachines = useLaunchSelectionMachines();
                return { semanticMachines, launchMachines };
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const first = hook.getCurrent();
            const firstSemanticRenders = semanticRenders;
            const firstLaunchRenders = launchRenders;

            await act(async () => {
                storage.getState().applyMachines([
                    { ...onlineMachine, updatedAt: activeAt + 1000, activeAt: activeAt + 1000 },
                ], false, { sourceServerId: getActiveServerSnapshot().serverId });
            });

            expect(semanticRenders).toBe(firstSemanticRenders);
            expect(launchRenders).toBe(firstLaunchRenders);
            expect(hook.getCurrent()).toBe(first);
            expect(hook.getCurrent().semanticMachines[0]?.activeAt).toBe(activeAt + 1000);
            expect(hook.getCurrent().launchMachines[0]?.activeAt).toBe(activeAt + 1000);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps launch selection stable while authoritative activity changes remain current', async () => {
        const previousState = storage.getState();
        try {
            const staleActiveAt = Date.now() - 10 * 60_000;
            const machine = createMachineFixture({ id: 'm-online', active: true, activeAt: staleActiveAt, presenceProtocolVersion: 1 });
            const options = { sourceServerId: getActiveServerSnapshot().serverId };
            storage.getState().applyMachines([machine], true, options);

            const hook = await renderHook(() => useLaunchSelectionMachines(), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const firstMachines = hook.getCurrent();
            const freshActiveAt = Date.now();

            await act(async () => {
                storage.getState().applyMachineActivityUpdates([{ id: machine.id, active: true, activeAt: freshActiveAt }], options);
            });

            expect(hook.getCurrent()).toBe(firstMachines);
            expect(readMachineActivity(firstMachines[0]!).activeAt).toBe(freshActiveAt);
            await act(async () => storage.getState().applyMachineActivityUpdates([
                { id: machine.id, active: false, activeAt: freshActiveAt + 1 },
            ], options));
            expect(hook.getCurrent()).toBe(firstMachines);
            expect(readMachineActivity(hook.getCurrent()[0]!).active).toBe(false);
            expect(firstMachines[0]?.active).toBe(true);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('does not fall back to another server cached machine list while the active server cache is empty during bootstrap', async () => {
        const previousState = storage.getState();
        try {
            const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim() || 'server-active';
            storage.setState((state) => ({
                ...state,
                isDataReady: false,
                // The real machine-list writer marks a successful empty read idle,
                // independently of the containing Account bootstrap state.
                machineListStatusByServerId: { [activeServerId]: 'idle' },
                machines: {
                    'm-stale-global': {
                        id: 'm-stale-global',
                        seq: 1,
                        createdAt: 900,
                        updatedAt: 900,
                        active: true,
                        activeAt: 900,
                        metadata: { host: 'stale-global', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                    } as any,
                },
                machineListByServerId: {
                    [activeServerId]: [],
                    'server-cached': [
                        {
                            id: 'm-cached-server',
                            seq: 1,
                            createdAt: 1000,
                            updatedAt: 1000,
                            active: true,
                            activeAt: 1000,
                            metadata: { host: 'cached-server', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                            metadataVersion: 1,
                            daemonState: null,
                            daemonStateVersion: 0,
                        } as any,
                    ],
                },
            }));

            const hook = await renderHook(() => useAllMachines(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toEqual([]);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps transcript fork support source stable when only metadata freshness fields change', async () => {
        const previousState = storage.getState();
        try {
            const metadata = {
                path: '/repo',
                host: 'mac',
                codexSessionId: 'codex-session',
                sessionModesV1: {
                    v: 1 as const,
                    agentId: 'codex',
                    updatedAt: 100,
                    currentModeId: 'default',
                    availableModes: [{ id: 'default', name: 'Default' }],
                },
                summary: { text: 'Summary', updatedAt: 100 },
            };
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: {
                    ...state.sessions,
                    's-active': {
                        id: 's-active',
                        serverId: 'server-a',
                        seq: 10,
                        createdAt: 1000,
                        updatedAt: 1000,
                        active: true,
                        activeAt: 1000,
                        metadata,
                        metadataVersion: 1,
                        agentState: null,
                        agentStateVersion: 1,
                        thinking: false,
                        thinkingAt: 0,
                        presence: 'online',
                    },
                },
            }));

            const hook = await renderHook(() => useSessionForkSupportSource('s-active'), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const firstSource = hook.getCurrent();

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: {
                        ...state.sessions,
                        's-active': {
                            ...state.sessions['s-active']!,
                            metadataVersion: 2,
                            metadata: {
                                ...metadata,
                                sessionModesV1: {
                                    ...metadata.sessionModesV1,
                                    updatedAt: 200,
                                },
                                summary: { text: 'Summary', updatedAt: 200 },
                            },
                        },
                    },
                }));
            });

            expect(hook.getCurrent()).toBe(firstSource);
            expect(hook.getCurrent()).toEqual({ metadata, serverId: 'server-a' });

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('refreshes transcript fork support source when permission mode timestamp changes', async () => {
        const previousState = storage.getState();
        try {
            const metadata = {
                path: '/repo',
                host: 'mac',
                codexSessionId: 'codex-session',
                permissionMode: 'yolo' as const,
                permissionModeUpdatedAt: 100,
            };
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: {
                    ...state.sessions,
                    's-active': {
                        id: 's-active',
                        serverId: 'server-a',
                        seq: 10,
                        createdAt: 1000,
                        updatedAt: 1000,
                        active: true,
                        activeAt: 1000,
                        metadata,
                        metadataVersion: 1,
                        agentState: null,
                        agentStateVersion: 1,
                        thinking: false,
                        thinkingAt: 0,
                        presence: 'online',
                    },
                },
            }));

            const hook = await renderHook(() => useSessionForkSupportSource('s-active'), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const firstSource = hook.getCurrent();

            const refreshedMetadata = {
                ...metadata,
                permissionModeUpdatedAt: 200,
            };
            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: {
                        ...state.sessions,
                        's-active': {
                            ...state.sessions['s-active']!,
                            metadataVersion: 2,
                            metadata: refreshedMetadata,
                        },
                    },
                }));
            });

            expect(hook.getCurrent()).not.toBe(firstSource);
            expect(hook.getCurrent()).toEqual({ metadata: refreshedMetadata, serverId: 'server-a' });

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('includes offline machines and sorts online machines first', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machineListByServerId: {},
                machineListStatusByServerId: {},
                machines: {
                    'm-online': {
                        id: 'm-online',
                        seq: 1,
                        createdAt: 1000,
                        updatedAt: 1000,
                        active: true,
                        activeAt: 1000,
                        metadata: { host: 'online', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                    },
                    'm-offline': {
                        id: 'm-offline',
                        seq: 1,
                        createdAt: 2000,
                        updatedAt: 2000,
                        active: false,
                        activeAt: 2000,
                        metadata: { host: 'offline', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                    },
                },
            }));

            const hook = await renderHook(() => useAllMachines(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent().map((machine) => machine.id)).toEqual(['m-online', 'm-offline']);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('excludes revoked machines from visible machine lists', async () => {
        const previousState = storage.getState();
        try {
            const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim() || 'server-active';
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machines: {
                    'm-online': {
                        id: 'm-online',
                        seq: 1,
                        createdAt: 1000,
                        updatedAt: 1000,
                        active: true,
                        activeAt: 1000,
                        metadata: { host: 'online', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                        revokedAt: null,
                    },
                    'm-revoked': {
                        id: 'm-revoked',
                        seq: 1,
                        createdAt: 1200,
                        updatedAt: 1200,
                        active: false,
                        activeAt: 1200,
                        metadata: { host: 'revoked', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                        revokedAt: 1700000000000,
                    },
                },
                machineListByServerId: {
                    [activeServerId]: [
                        { id: 'm-online', active: true, activeAt: 1000, createdAt: 1000, updatedAt: 1000, metadata: { host: 'online' }, revokedAt: null } as any,
                        { id: 'm-revoked', active: false, activeAt: 1200, createdAt: 1200, updatedAt: 1200, metadata: { host: 'revoked' }, revokedAt: 1700000000000 } as any,
                    ],
                },
            }));

            const allMachinesHook = await renderHook(() => useAllMachines(), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const byServerHook = await renderHook(() => useMachineListByServerId(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(allMachinesHook.getCurrent().map((machine) => machine.id)).toEqual(['m-online']);
            expect((byServerHook.getCurrent()[activeServerId] ?? []).map((machine) => machine.id)).toEqual(['m-online']);

            await allMachinesHook.unmount();
            await byServerHook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('retains revoked records for administration-only tombstone presentation', async () => {
        const storageModule = await import('@/sync/domains/state/storage') as unknown as Readonly<{
            useMachineRecordListsByServerId?: () => Record<string, Array<{ id: string } | null> | null>;
        }>;
        const previousState = storage.getState();
        try {
            const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim() || 'server-active';
            storage.setState((state) => ({
                ...state,
                machineListByServerId: {
                    [activeServerId]: [
                        { id: 'm-online', active: true, activeAt: 1000, createdAt: 1000, updatedAt: 1000, metadata: { host: 'online' }, revokedAt: null } as any,
                        { id: 'm-revoked', active: false, activeAt: 1200, createdAt: 1200, updatedAt: 1200, metadata: { host: 'revoked' }, revokedAt: 1700000000000 } as any,
                    ],
                },
            }));

            expect(typeof storageModule.useMachineRecordListsByServerId).toBe('function');
            const hook = await renderHook(() => storageModule.useMachineRecordListsByServerId!(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect((hook.getCurrent()[activeServerId] ?? []).map((machine) => machine?.id)).toEqual([
                'm-online',
                'm-revoked',
            ]);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('prefers the active-server machine cache over global machine map entries', async () => {
        const previousState = storage.getState();
        try {
            const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim() || 'server-active';
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machineListStatusByServerId: { [activeServerId]: 'idle' },
                machines: {
                    'm-active': {
                        id: 'm-active',
                        seq: 1,
                        createdAt: 1000,
                        updatedAt: 1000,
                        active: true,
                        activeAt: 1000,
                        metadata: { host: 'active', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                        revokedAt: null,
                    },
                    'm-stale': {
                        id: 'm-stale',
                        seq: 1,
                        createdAt: 900,
                        updatedAt: 900,
                        active: true,
                        activeAt: 900,
                        metadata: { host: 'stale', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                        revokedAt: null,
                    },
                },
                machineListByServerId: {
                    [activeServerId]: [
                        {
                            id: 'm-active',
                            seq: 1,
                            createdAt: 1000,
                            updatedAt: 1000,
                            active: true,
                            activeAt: 1000,
                            metadata: { host: 'active', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                            metadataVersion: 1,
                            daemonState: null,
                            daemonStateVersion: 0,
                            revokedAt: null,
                        } as any,
                    ],
                },
            }));

            const hook = await renderHook(() => useAllMachines(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent().map((machine) => machine.id)).toEqual(['m-active']);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
