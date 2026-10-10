import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createMachineFixture, createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { useSessionMachineReachability, useSessionReachableMachineTarget } from './useSessionMachineReachability';

const initialStorage = getStorage().getState();
let serverId: string;
beforeEach(async () => {
    const home = await upsertServerProfile({ name: 'reachability', serverUrl: 'https://reachability.example.test' });
    serverId = home.id;
    await setActiveServerId(serverId, { scope: 'device' });
    const machine = createMachineFixture({ id: 'm1', activeAt: Date.now() });
    const session = createSessionFixture({ id: 's1', serverId, active: true, metadata: { machineId: 'm1', path: '/repo', host: 'host-1' } });
    getStorage().setState({ sessions: { s1: session }, machines: { m1: machine }, machineListByServerId: { [serverId]: [machine] } });
});
afterEach(() => { standardCleanup(); vi.useRealTimers(); getStorage().setState(initialStorage, true); });

describe('useSessionMachineReachability', () => {
    it('normalizes session ids before resolving the reachable machine target', async () => {
        const hook = await renderHook(() => useSessionReachableMachineTarget('  s1  ', serverId));
        expect(hook.getCurrent()).toEqual({ machineId: 'm1', basePath: '/repo' });
    });

    it('normalizes session ids and observes offline status even when no RPC target is available', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const hook = await renderHook(() => useSessionMachineReachability('  s1  ', serverId));
        expect(hook.getCurrent()).toEqual({ machineReachable: true, machineOnline: true,
            machineRpcTargetAvailable: true, machineReachability: 'reachable' });
        await act(async () => { vi.advanceTimersByTime(60_001); });
        expect(hook.getCurrent()).toEqual({ machineReachable: false, machineOnline: false,
            machineRpcTargetAvailable: false, machineReachability: 'unreachable' });
        const refreshed = { ...getStorage().getState().machines.m1!, activeAt: Date.now() };
        await act(async () => getStorage().setState({ machines: { m1: refreshed }, machineListByServerId: { [serverId]: [refreshed] } }));
        expect(hook.getCurrent()).toEqual({ machineReachable: true, machineOnline: true,
            machineRpcTargetAvailable: true, machineReachability: 'reachable' });
        const machine = getStorage().getState().machines.m1!;
        const offline = { ...machine, active: false, activeAt: 1 };
        await act(async () => getStorage().setState({ machines: { m1: offline }, machineListByServerId: { [serverId]: [offline] } }));
        expect(hook.getCurrent()).toEqual({ machineReachable: false, machineOnline: false,
            machineRpcTargetAvailable: false, machineReachability: 'unreachable' });
    });

    it('does not update visible reachability when an unrelated background session changes', async () => {
        const seen: Array<ReturnType<typeof useSessionMachineReachability>> = [];
        await renderHook(() => {
            const value = useSessionMachineReachability('s1', serverId);
            React.useEffect(() => { seen.push(value); }, [value]);
            return value;
        });
        await act(async () => getStorage().setState({ sessions: { ...getStorage().getState().sessions,
            background: createSessionFixture({ id: 'background', serverId, active: true, metadata: { machineId: 'm1', path: '/other-repo', host: 'host-1' } }) } }));
        expect(seen).toHaveLength(1);
    });

    it('does not update visible reachability when only the machine heartbeat changes', async () => {
        const seen: Array<ReturnType<typeof useSessionMachineReachability>> = [];
        await renderHook(() => {
            const value = useSessionMachineReachability('s1', serverId);
            React.useEffect(() => { seen.push(value); }, [value]);
            return value;
        });
        const machine = getStorage().getState().machines.m1!;
        const heartbeat = { ...machine, activeAt: machine.activeAt + 1 };
        await act(async () => getStorage().setState({ machines: { m1: heartbeat }, machineListByServerId: { [serverId]: [heartbeat] } }));
        expect(seen).toHaveLength(1);
    });
});
