import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createMachineFixture, createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { clearMachineRequestReachabilityForTest } from '@/sync/domains/machines/reachability/machineReachability';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { getStorage, useServerScopedMachine } = await import('@/sync/domains/state/storage');
const { useSessionMachineReachability, useSessionReachableMachineTarget } = await import('./useSessionMachineReachability');

const initialStorage = getStorage().getState();
const serverId = 'srv_session_reach';
beforeEach(async () => {
    await home.reset();
    const homeId = await home.addHome({ name: 'Reachability Home', serverUrl: 'https://reachability.example.test',
        serverIdentityId: serverId, accountId: 'account' });
    getStorage().getState().activateProfileScope({ serverId: homeId, accountId: 'account' });
    const machine = createMachineFixture({ id: 'm1', activeAt: Date.now(), presenceProtocolVersion: 1 });
    const session = createSessionFixture({ id: 's1', serverId, active: true, metadata: { machineId: 'm1', path: '/repo', host: 'host-1' } });
    getStorage().setState({ sessions: { s1: session } });
    getStorage().getState().applyMachines([machine], true, { sourceServerId: serverId, sourceAccountId: 'account' });
});
afterEach(async () => { standardCleanup(); clearMachineRequestReachabilityForTest(); vi.useRealTimers(); getStorage().setState(initialStorage, true); await home.reset(); });

describe('useSessionMachineReachability', () => {
    it('renders the member Session header, Board card and Machine rail once for the same pushed native Start', async () => {
        const { buildUpdatedMachineFromSocketUpdate } = await import('@/sync/engine/machines/syncMachines');
        const { buildBoardCards } = await import('@/components/boards/model/boardCards');
        const { useMachineCollection } = await import('@/components/settings/machines/collection/useMachineCollection');
        const { buildWorkBoardItemKeyV1 } = await import('@happier-dev/protocol/boards/workBoardV1');
        const { t } = await import('@/text');
        const store = getStorage();
        const guest = createMachineFixture({ ...store.getState().machines.m1!, active: false, presenceProtocolVersion: 1,
            isShared: true, storageMode: 'plain', availability: { kind: 'available' },
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'use', resourceMode: 'plain', accessState: 'ready' },
            managedInputRuntime: { nativeReady: false, wakeState: null, state: 'asleep' } });
        const source = { sourceServerId: serverId, sourceAccountId: 'account' };
        const scope = { serverId, accountId: 'account' };
        await act(async () => store.getState().applyMachines([guest], true, source));
        const ref = { kind: 'machine', qualifiedId: { serverId, id: guest.id } } as const;
        const members = [{ key: buildWorkBoardItemKeyV1(ref), ref, picked: true, sourced: false, available: true }];
        let sessionRenders = 0;
        let boardRenders = 0;
        let railRenders = 0;
        const header = await renderHook(() => {
            sessionRenders++;
            return useSessionMachineReachability('s1', serverId).machinePower;
        });
        const board = await renderHook(() => {
            boardRenders++;
            const machine = useServerScopedMachine(serverId, guest.id);
            return buildBoardCards(members, { nowMs: Date.now(), session: () => null, workflowRun: () => null,
                workflow: () => null, machine: () => machine, machineScope: () => scope,
                machineSessionCounts: new Map(), accountScopedHome: () => true })[0]?.status.word;
        });
        const rail = await renderHook(() => {
            railRenders++;
            const machine = useServerScopedMachine(serverId, guest.id);
            const groups = React.useMemo(() => [{ serverId, serverName: 'Reachability Home', accountScope: scope,
                status: 'idle' as const, machines: machine ? [machine] : [] }], [machine]);
            return useMachineCollection({ groups, groupedByHome: false }).sections[0]?.rows[0]?.presenceWord;
        });
        try {
            const asleep = t('managedPower.asleep');
            await waitForHomeGovernance(() => {
                expect(header.getCurrent()?.word).toBe(asleep);
                expect(board.getCurrent()).toBe(asleep);
                expect(rail.getCurrent()).toBe(asleep);
            });
            const before = { sessionRenders, boardRenders, railRenders };
            const starting = await buildUpdatedMachineFromSocketUpdate({
                machineUpdate: { t: 'update-machine', machineId: guest.id,
                    managedInputRuntime: { nativeReady: false, wakeState: null, state: 'starting' } },
                updateSeq: 2, updateCreatedAt: Date.now(), existingMachine: store.getState().machines.m1,
                getMachineEncryption: () => null,
            });
            if (!starting) throw new Error('Expected the member Machine push to open');
            await act(async () => store.getState().applyMachines([starting], false, source));
            expect(header.getCurrent()?.word).toBe(t('managedWake.starting', { machine: header.getCurrent()?.machineName ?? '' }));
            expect(board.getCurrent()).toBe(header.getCurrent()?.word);
            expect(rail.getCurrent()).toBe(header.getCurrent()?.word);
            expect(sessionRenders - before.sessionRenders).toBe(1);
            expect(boardRenders - before.boardRenders).toBe(1);
            expect(railRenders - before.railRenders).toBe(1);
        } finally {
            await rail.unmount();
            await board.unmount();
            await header.unmount();
        }
    });

    it('does not admit retained unobserved presence through the invisible shared-Machine exception', async () => {
        const store = getStorage();
        const retained = createMachineFixture({ id: 'm1', activeAt: Date.now(), presenceProtocolVersion: 1 });
        store.setState({ machines: { m1: retained }, machineListByServerId: { [serverId]: [retained] } });
        const hook = await renderHook(() => useSessionMachineReachability('s1', serverId));
        expect(hook.getCurrent()).toMatchObject({ machineReachability: 'unknown', machineOnline: false,
            machineReachable: false, machineRpcTargetAvailable: false, machineLastSeenAt: null });
        await act(async () => store.getState().applyMachines([retained], false, { sourceServerId: serverId, sourceAccountId: 'account' }));
        expect(hook.getCurrent()).toMatchObject({ machineReachability: 'reachable', machineReachable: true });
    });
    it('normalizes session ids before resolving the reachable machine target', async () => {
        const hook = await renderHook(() => useSessionReachableMachineTarget('  s1  ', serverId));
        expect(hook.getCurrent()).toEqual({ machineId: 'm1', basePath: '/repo' });
    });

    it('keeps pushed presence until an authoritative offline fact and recovers on a newer observation', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const hook = await renderHook(() => useSessionMachineReachability('  s1  ', serverId));
        const lastHeartbeat = getStorage().getState().machines.m1!.activeAt;
        expect(hook.getCurrent()).toEqual({ machineReachable: true, machineOnline: true,
            machineRpcTargetAvailable: true, machineReachability: 'reachable', machineLastSeenAt: null, machinePower: null });
        await act(async () => { vi.advanceTimersByTime(60_001); });
        // The server owns the deadline. A client's clock does not contradict
        // its pushed fact; expiry arrives with the last admitted heartbeat.
        expect(hook.getCurrent()).toEqual({ machineReachable: true, machineOnline: true,
            machineRpcTargetAvailable: true, machineReachability: 'reachable', machineLastSeenAt: null, machinePower: null });
        const source = { sourceServerId: serverId, sourceAccountId: 'account' };
        await act(async () => getStorage().getState().applyMachineActivityUpdates([
            { id: 'm1', active: false, activeAt: lastHeartbeat },
        ], source));
        expect(hook.getCurrent()).toEqual({ machineReachable: false, machineOnline: false,
            machineRpcTargetAvailable: false, machineReachability: 'unreachable', machineLastSeenAt: lastHeartbeat, machinePower: null });
        await act(async () => getStorage().getState().applyMachineActivityUpdates([
            { id: 'm1', active: true, activeAt: Date.now() },
        ], source));
        expect(hook.getCurrent()).toEqual({ machineReachable: true, machineOnline: true,
            machineRpcTargetAvailable: true, machineReachability: 'reachable', machineLastSeenAt: null, machinePower: null });
    });

    it('does not update visible reachability when an unrelated background session changes', async () => {
        const seen: Array<ReturnType<typeof useSessionMachineReachability>> = [];
        const hook = await renderHook(() => {
            const value = useSessionMachineReachability('s1', serverId);
            React.useEffect(() => { seen.push(value); }, [value]);
            return value;
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().machineOnline).toBe(true));
        const settledUpdates = seen.length;
        await act(async () => getStorage().setState({ sessions: { ...getStorage().getState().sessions,
            background: createSessionFixture({ id: 'background', serverId, active: true, metadata: { machineId: 'm1', path: '/other-repo', host: 'host-1' } }) } }));
        expect(seen).toHaveLength(settledUpdates);
    });

    it('does not update visible reachability when only the machine heartbeat changes', async () => {
        const seen: Array<ReturnType<typeof useSessionMachineReachability>> = [];
        const hook = await renderHook(() => {
            const value = useSessionMachineReachability('s1', serverId);
            React.useEffect(() => { seen.push(value); }, [value]);
            return value;
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().machineOnline).toBe(true));
        const settledUpdates = seen.length;
        const machine = getStorage().getState().machines.m1!;
        const heartbeat = { ...machine, activeAt: machine.activeAt + 1 };
        await act(async () => getStorage().setState({ machines: { m1: heartbeat }, machineListByServerId: { [serverId]: [heartbeat] } }));
        expect(seen).toHaveLength(settledUpdates);
    });
});
