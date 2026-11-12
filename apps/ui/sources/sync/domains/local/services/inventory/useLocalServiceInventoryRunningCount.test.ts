import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { createMachineFixture, createSessionFixture, renderHook, renderScreen } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(rpc);
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { useLocalServiceInventoryHasRunningServices, useLocalServiceInventoryRunningCount } = await import('./useLocalServiceInventoryRunningCount');
const { SessionServicesRailBadge } = await import('@/components/sessions/panes/SessionResourceRailBadge');
const { resetLocalServiceInventoryStoreForTests } = await import('./sharedStore');
const { storage } = await import('@/sync/domains/state/storageStore');
const before = storage.getState();

afterEach(async () => { resetLocalServiceInventoryStoreForTests(); storage.setState(before); rpc.mockReset(); await homes.reset(); });

it('renders exact received Services counts in the passive rail badge and overflow signal', async () => {
    const serverId = await homes.addHome({ name: 'Service badges', serverUrl: 'https://service-badges.example.test', accountId: 'owner', currentAccount: true });
    storage.setState({ profileScope: { serverId, accountId: 'owner' } });
    const machine = createMachineFixture({ id: 'machine-a', storageMode: 'plain', daemonStateVersion: 1,
        daemonState: { status: 'running', pid: 12, localServices: { v: 1, state: 'ready', runningCount: 1 } } });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [machine]);
    const props = { serverId, machineId: machine.id, sessionId: 'session-a', enabled: false };
    const renderSignal = vi.fn(() => null);
    const badge = await renderScreen(React.createElement(SessionServicesRailBadge, props));
    const signal = await renderScreen(React.createElement(SessionServicesRailBadge, { ...props, renderSignal }));
    try {
        expect(badge.findHostByTestId('session-action-rail:services:badge')).not.toBeNull();
        expect(badge.getTextContent()).toBe('1');
        expect(renderSignal).toHaveBeenLastCalledWith({ kind: 'count', value: 1, tone: 'neutral' });
        renderSignal.mockClear();
        await act(async () => storage.getState().applyMachines([{ ...machine, daemonStateVersion: 2,
            daemonState: { ...machine.daemonState, pid: 13, localServices: { v: 1, state: 'ready', runningCount: 1 } } }], false,
        { sourceServerId: serverId, sourceAccountId: 'owner' }));
        expect(badge.getTextContent()).toBe('1');
        expect(renderSignal).not.toHaveBeenCalled();
        expect(rpc).not.toHaveBeenCalled();
        await act(async () => storage.getState().applyMachines([{ ...machine, daemonStateVersion: 3,
            daemonState: { ...machine.daemonState, localServices: { v: 1, state: 'ready', runningCount: 5 } } }], false,
        { sourceServerId: serverId, sourceAccountId: 'owner' }));
        expect(badge.getTextContent()).toBe('5');
        expect(renderSignal).toHaveBeenLastCalledWith({ kind: 'count', value: 5, tone: 'neutral' });
        await act(async () => storage.getState().applyMachines([{ ...machine, daemonStateVersion: 4,
            daemonState: { ...machine.daemonState, localServices: { v: 1, state: 'ready', runningCount: 0 } } }], false,
        { sourceServerId: serverId, sourceAccountId: 'owner' }));
        expect(badge.findHostByTestId('session-action-rail:services:badge')).toBeNull();
        expect(renderSignal).toHaveBeenLastCalledWith(null);
        expect(rpc).not.toHaveBeenCalled();
    } finally { await signal.unmount(); await badge.unmount(); }
});

it('passively reads received Machine summaries and does not render layout for positive count changes', async () => {
    const serverId = await homes.addHome({ name: 'Service counts', serverUrl: 'https://service-counts.example.test', accountId: 'owner', currentAccount: true });
    const machine = createMachineFixture({ id: 'machine-a', storageMode: 'plain', daemonStateVersion: 1,
        daemonState: { status: 'running', pid: 12, localServices: { v: 1, state: 'ready', runningCount: 1 } } });
    const otherMachines = Array.from({ length: 138 }, (_, index) => createMachineFixture({ id: `other-${index}`, storageMode: 'plain' }));
    storage.setState({ profileScope: { serverId, accountId: 'owner' } });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [machine, ...otherMachines]);
    let renders = 0;
    let countRenders = 0;
    const hook = await renderHook(() => { renders += 1; return useLocalServiceInventoryHasRunningServices({ serverId, machineId: machine.id, sessionId: 'session-a' }); });
    const count = await renderHook(() => { countRenders += 1; return useLocalServiceInventoryRunningCount({ serverId, machineId: machine.id, sessionId: 'session-a', enabled: false }); });
    try {
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toBe(true));
        expect(count.getCurrent()).toBe(1);
        renders = 0;
        countRenders = 0;
        const sessions = Array.from({ length: 1_000 }, (_, index) => createSessionFixture({ id: `unrelated-session-${index}` }));
        await act(async () => storage.getState().applySessions(sessions));
        expect(renders).toBe(0);
        expect(countRenders).toBe(0);
        expect(rpc).not.toHaveBeenCalled();
        await act(async () => storage.getState().applyMachines(otherMachines.map(other => ({ ...other, daemonStateVersion: 2,
            daemonState: { status: 'running', localServices: { v: 1, state: 'ready', runningCount: 7 } } })), false,
        { sourceServerId: serverId, sourceAccountId: 'owner' }));
        expect(renders).toBe(0);
        expect(countRenders).toBe(0);
        expect(rpc).not.toHaveBeenCalled();
        await act(async () => storage.getState().applyMachines([{ ...machine, daemonStateVersion: 2,
            daemonState: { ...machine.daemonState, localServices: { v: 1, state: 'ready', runningCount: 5 } } }], false, { sourceServerId: serverId, sourceAccountId: 'owner' }));
        expect(renders).toBe(0);
        expect(count.getCurrent()).toBe(5);
        expect(countRenders).toBe(1);
        expect(rpc).not.toHaveBeenCalled();
        await act(async () => storage.getState().applyMachines([{ ...machine, daemonStateVersion: 3,
            daemonState: { ...machine.daemonState, localServices: { v: 1, state: 'ready', runningCount: 0 } } }], false, { sourceServerId: serverId, sourceAccountId: 'owner' }));
        expect(hook.getCurrent()).toBe(false);
        expect(renders).toBe(1);
        expect(count.getCurrent()).toBe(0);
        expect(countRenders).toBe(2);
        expect(rpc).not.toHaveBeenCalled();
    } finally { await count.unmount(); await hook.unmount(); }
});

it('spends one missing-summary read across repeated renders and enabled changes in a mounted Session', async () => {
    const serverId = await homes.addHome({ name: 'Missing service count', serverUrl: 'https://missing-service-count.example.test', accountId: 'owner', currentAccount: true });
    rpc.mockResolvedValue({ summary: { v: 1, state: 'unknown' } });
    const hook = await renderHook(({ enabled }: { enabled: boolean }) => useLocalServiceInventoryHasRunningServices({
        serverId, machineId: 'machine-a', sessionId: 'session-a', enabled,
    }), { initialProps: { enabled: true } });
    try {
        await waitForHomeGovernance(() => expect(rpc).toHaveBeenCalledTimes(1));
        for (let render = 0; render < 10; render += 1) await hook.rerender({ enabled: true });
        await hook.rerender({ enabled: false });
        await hook.rerender({ enabled: true });
        expect(rpc).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent()).toBeNull();
    } finally { await hook.unmount(); }
});
