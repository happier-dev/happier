import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, flushHookEffects, renderHook } from '@/dev/testkit';
import type { createReactNativeAppStateEmitter } from '@/dev/testkit/mocks/reactNative';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const boundary = vi.hoisted(() => ({
    rpc: vi.fn<(input: { method: string; payload: unknown; serverId?: string | null; machineId?: string; signal?: AbortSignal; onDispatched?: () => void }) => Promise<unknown>>(),
    appState: null as ReturnType<typeof createReactNativeAppStateEmitter> | null,
    focused: true,
    presented: true,
    visibility: 'visible',
}));
const documentBoundary = new EventTarget();
Object.defineProperty(documentBoundary, 'visibilityState', { get: () => boundary.visibility });
// Visibility is the DOM boundary under test; this native harness has no mounted web root.
Object.defineProperty(documentBoundary, 'getElementById', { value: () => null });
vi.mock('react-native', async () => {
    const { createReactNativeAppStateEmitter, createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    boundary.appState = createReactNativeAppStateEmitter('active');
    return createReactNativeWebMock({ AppState: boundary.appState.appState });
});
// The real encrypted/scoped RPC transport is the external boundary; all subscription logic stays real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (input: Parameters<typeof boundary.rpc>[0]) => {
        const reply = boundary.rpc(input);
        input.onDispatched?.();
        return reply;
    },
}));
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return { ...createReactNavigationNativeMock(), useIsFocused: () => boundary.focused };
});

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
let homeA = '';
let homeB = '';

describe('machine resource visibility and demand', () => {
    beforeEach(async () => {
        await homes.reset();
        await loadSyncSingletonForTests();
        homeA = await homes.addHome({ name: 'Home A', serverUrl: 'https://resource-home-a.test', accountId: 'owner', currentAccount: true });
        homeB = await homes.addHome({ name: 'Home B', serverUrl: 'https://resource-home-b.test', accountId: 'owner-b', currentAccount: true });
        boundary.visibility = 'visible';
        boundary.presented = true;
        vi.stubGlobal('document', documentBoundary);
        await import('./machineRpc');
        boundary.appState?.emit('active');
    });
    afterEach(async () => {
        const { machineResourceStore } = await import('./machineResourceStore');
        machineResourceStore.reset();
        boundary.rpc.mockReset();
        boundary.appState?.emit('active');
        boundary.focused = true;
        const { storage } = await import('@/sync/domains/state/storageStore');
        storage.setState({ machines: {}, machineListByServerId: {}, machineListStatusByServerId: {} });
        await homes.reset();
        vi.unstubAllGlobals();
    });

    it('bounds mounted row demand through the physical viewport and withdraws it when scrolled away', async () => {
        const { MachineResourceLiveDemand } = await import('./useMachineResourceLiveDemand');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { PluginUiScrollActivityProvider } = await import('@happier-dev/plugin-ui/advanced');
        const { createNearViewportTracker } = await import('@/components/widgets/nearViewport');
        const root = { getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, width: 400, height: 100 }) };
        const row = { current: { getBoundingClientRect: () => ({ x: 0, y: 500, left: 0, top: 500, width: 400, height: 40 }) } };
        const tracker = createNearViewportTracker({ quantum: 40, initialViewportHeight: 100, readContentNode: () => root });
        const pending = createDeferred<unknown>();
        let watchSignal: AbortSignal | undefined;
        boundary.rpc.mockImplementation(async input => {
            if (input.method === 'daemon.vitals.watch') { watchSignal = input.signal; return pending.promise; }
            return { state: 'reporting', sample: null, series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } };
        });
        const screen = await renderScreen(React.createElement(PluginUiScrollActivityProvider, { tracker },
            React.createElement(MachineResourceLiveDemand, {
                machineKeys: [{ serverId: homeA, machineId: 'machine-a' }], detail: 'summary', viewportRef: row,
            })));
        try {
            await flushHookEffects({ cycles: 20 });
            expect(boundary.rpc).not.toHaveBeenCalled();
            // The DOM boundary fixture supplies only the scroll fields this native event adapter reads.
            await act(async () => tracker.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 480 } } } as never));
            await waitForHomeGovernance(() => expect(watchSignal).toBeDefined());
            expect(boundary.rpc.mock.calls.filter(([input]) => input.method === 'machines.vitals.get')).toHaveLength(1);
            await act(async () => tracker.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 0 } } } as never));
            expect(watchSignal?.aborted).toBe(true);
            const count = boundary.rpc.mock.calls.length;
            await flushHookEffects({ cycles: 20 });
            expect(boundary.rpc).toHaveBeenCalledTimes(count);
        } finally { pending.resolve({ changed: false }); await screen.unmount(); }
    });

    it('remeasures a live meter when its row moves without changing the scroll extent', async () => {
        const { MachineResourceLiveDemand } = await import('./useMachineResourceLiveDemand');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { PluginUiScrollActivityProvider } = await import('@happier-dev/plugin-ui/advanced');
        const { createNearViewportTracker } = await import('@/components/widgets/nearViewport');
        let top = 0;
        const root = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 100 }) };
        const row = { current: { getBoundingClientRect: () => ({ left: 0, top, width: 400, height: 40 }) } };
        const tracker = createNearViewportTracker({ quantum: 40, initialViewportHeight: 100, readContentNode: () => root });
        const pending = createDeferred<unknown>();
        let watchSignal: AbortSignal | undefined;
        let onLayout = () => {};
        boundary.rpc.mockImplementation(async input => {
            if (input.method === 'daemon.vitals.watch') { watchSignal = input.signal; return pending.promise; }
            return { state: 'reporting', sample: null, series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } };
        });
        const screen = await renderScreen(<PluginUiScrollActivityProvider tracker={tracker}>
            <MachineResourceLiveDemand machineKeys={[{ serverId: homeA, machineId: 'machine-a' }]} detail="summary" viewportRef={row}>
                {measure => { onLayout = measure; return null; }}
            </MachineResourceLiveDemand>
        </PluginUiScrollActivityProvider>);
        try {
            await waitForHomeGovernance(() => expect(watchSignal).toBeDefined());
            await act(async () => { top = 500; onLayout(); });
            expect(watchSignal?.aborted).toBe(true);
            const count = boundary.rpc.mock.calls.length;
            await flushHookEffects({ cycles: 20 });
            expect(boundary.rpc).toHaveBeenCalledTimes(count);
        } finally { pending.resolve({ changed: false }); await screen.unmount(); }
    });

    it('keeps the session chooser passive when it presents published machine presence', async () => {
        const { NewSessionMachineSelectionContent } = await import('@/components/sessions/new/components/NewSessionMachineSelectionContent');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const machine = { ...createMachineFixture({ id: 'chooser-machine', active: true, activeAt: Date.now() }),
            serverId: homeA, serverName: 'Home A' };
        storage.setState({ machineListByServerId: { [homeA]: [machine] }, machineListStatusByServerId: { [homeA]: 'idle' } });
        const pending = createDeferred<unknown>();
        boundary.rpc.mockImplementation(async input => input.method === 'daemon.vitals.watch' ? pending.promise
            : { state: 'reporting', sample: null, series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } });
        const screen = await renderScreen(<NewSessionMachineSelectionContent
            groups={[{ serverId: homeA, serverName: 'Home A', loading: false, signedOut: false, machines: [machine] }]}
            selectedMachine={machine} selectedServerId={homeA} recentMachines={[]} favoriteMachines={[]}
            onSelectMachine={() => {}} onSelectScopedMachine={() => {}} serverId={homeA} onToggleFavorite={() => {}}
            showCliGlyphs={false} autoDetectCliGlyphs={false} showSearch={false} />);
        try {
            await flushHookEffects({ cycles: 20 });
            expect(boundary.rpc).not.toHaveBeenCalled();
        } finally { pending.resolve({ changed: false }); await screen.unmount(); }
    });

    it('reads row-local published availability without creating value reads or live demand', async () => {
        const { useMachineResourceSummary } = await import('./useMachineResourceSummary');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const machine = createMachineFixture({ id: 'machine-a', active: true, activeAt: Date.now(), daemonStateVersion: 1, daemonState: {
            resources: { v: 1, vitals: { state: 'reporting' }, host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 }, attention: { level: 'calm', reasons: [] } },
        } });
        storage.setState({ machineListByServerId: { [homeA]: [machine] }, machineListStatusByServerId: { [homeA]: 'idle' } });
        const hook = await renderHook(() => useMachineResourceSummary({ serverId: homeA, machineId: 'machine-a' }));
        expect(hook.getCurrent()).toEqual({ kind: 'reporting', summary: null, freshness: 'live', attention: { level: 'calm', reasons: [] } });
        await act(async () => {
            storage.setState({ machineListByServerId: { [homeA]: [{ ...machine, daemonStateVersion: 2, daemonState: {} }] } });
        });
        expect(hook.getCurrent()).toBeNull();
        await act(async () => {
            storage.setState({ machineListByServerId: { [homeA]: [{ ...machine, daemonStateVersion: 3, daemonState: {
                resources: { v: 1, vitals: { state: 'unavailable', reason: 'helper_missing' }, host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 }, attention: { level: 'calm', reasons: [] } },
            } }] } });
        });
        expect(hook.getCurrent()).toEqual({ kind: 'not_reported', reason: 'unsupported' });
        expect(boundary.rpc).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('observes retained-summary revalidation without acquiring its own demand', async () => {
        const { useMachineResourceRefreshing } = await import('./useMachineResourceSummary');
        const { machineResourceStore } = await import('./machineResourceStore');
        const sampledAt = Date.now();
        const snapshot = { state: 'reporting', sample: { v: 1, sampledAt, intervalMs: 15_000,
            cpu: { reported: true, busyPct: 20 }, memory: { reported: true, totalBytes: 100, availableBytes: 80, usedBytes: 20, pressure: { level: 'calm', source: 'psi' } },
            disk: { reported: true, volumes: [] }, network: { reported: true, rxBps: 12, txBps: 3 } },
            series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } };
        boundary.rpc.mockResolvedValue(snapshot);
        const key = { serverId: homeA, machineId: 'machine-a', expectedAccountId: 'owner', view: 'summary' as const };
        await machineResourceStore.read(key);
        const cached = machineResourceStore.getState(key);
        const reads = boundary.rpc.mock.calls.length;
        const keys = [key];
        const hook = await renderHook(() => useMachineResourceRefreshing(keys));
        const pending = createDeferred<unknown>();
        let refresh: Promise<void> | undefined;
        try {
            expect(hook.getCurrent()).toBe(false);
            expect(boundary.rpc).toHaveBeenCalledTimes(reads);
            boundary.rpc.mockReturnValueOnce(pending.promise);
            await act(async () => { refresh = machineResourceStore.read(key); });
            expect(hook.getCurrent()).toBe(true);
            expect(machineResourceStore.getState(key)).toBe(cached);
            await act(async () => { pending.resolve(snapshot); await refresh; });
            expect(hook.getCurrent()).toBe(false);
            expect(machineResourceStore.getState(key)).toBe(cached);
            expect(boundary.rpc).toHaveBeenCalledTimes(reads + 1);
        } finally { pending.resolve(snapshot); await refresh; await hook.unmount(); }
    });

    it('projects a missing vitals method into the row older-Happier state', async () => {
        const { useMachineResourceLiveDemand } = await import('./useMachineResourceLiveDemand');
        const { useMachineResourceSummary } = await import('./useMachineResourceSummary');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const machine = createMachineFixture({ id: 'machine-a', activeAt: Date.now(), daemonStateVersion: 1, daemonState: {
            resources: { v: 1, vitals: { state: 'reporting' }, host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 }, attention: { level: 'calm', reasons: [] } },
        } });
        storage.setState({ machineListByServerId: { [homeA]: [machine] }, machineListStatusByServerId: { [homeA]: 'idle' } });
        boundary.rpc.mockRejectedValue(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND));
        const keys = [{ serverId: homeA, machineId: 'machine-a' }];
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const Presentation = ({ children }: React.PropsWithChildren) => React.createElement(PluginSurfaceFocusEligibilityProvider, {
            active: boundary.presented, presentationActive: boundary.presented, children,
        });
        const hook = await renderHook(() => {
            useMachineResourceLiveDemand(keys, { detail: 'summary' });
            return useMachineResourceSummary(keys[0]!);
        }, { wrapper: Presentation });
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(hook.getCurrent()).toEqual({ kind: 'not_reported', reason: 'older_happier' });
        const reads = boundary.rpc.mock.calls.length;
        boundary.presented = false;
        await hook.rerender();
        boundary.presented = true;
        await hook.rerender();
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(boundary.rpc).toHaveBeenCalledTimes(reads);
        await act(async () => { storage.setState({ machineListByServerId: { [homeA]: [{ ...machine, daemonStateVersion: 2 }] } }); });
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(boundary.rpc).toHaveBeenCalledTimes(reads + 1);
        await hook.unmount();
    });

    it('recovers standalone Overview after daemon version changes without retrying an unchanged unsupported daemon', async () => {
        const { useMachineVitalsOverview } = await import('./useMachineVitalsOverview');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const machine = createMachineFixture({ id: 'machine-a', active: true, activeAt: Date.now(), daemonStateVersion: 1 });
        storage.setState({ machineListByServerId: { [homeA]: [machine] }, machineListStatusByServerId: { [homeA]: 'idle' } });
        boundary.rpc.mockRejectedValue(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND));
        // No Summary helper is mounted: the Overview/Metric demand must carry its own version.
        const hook = await renderHook(() => useMachineVitalsOverview({ serverId: homeA, machineId: machine.id, range: '1h' }));
        try {
            await flushHookEffects({ cycles: 3, turns: 3 });
            expect(hook.getCurrent().status).toBe('not_reported');
            const reads = boundary.rpc.mock.calls.length;
            await act(async () => { hook.getCurrent().retry(); });
            await hook.rerender();
            await flushHookEffects({ cycles: 3, turns: 3 });
            expect(boundary.rpc).toHaveBeenCalledTimes(reads);
            boundary.rpc.mockImplementation(async input => {
                if (input.method === 'daemon.vitals.watch') {
                    const answer = createDeferred<unknown>();
                    input.signal?.addEventListener('abort', () => answer.resolve({ changed: false }), { once: true });
                    return answer.promise;
                }
                if (input.method === 'machines.vitals.history.get') return {
                    range: '1h', bucketMs: 60_000, points: [], today: { rxBytes: 0, txBytes: 0 },
                };
                return { state: 'reporting', sample: null, series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } };
            });
            await act(async () => { storage.setState({ machineListByServerId: { [homeA]: [{ ...machine, daemonStateVersion: 2 }] } }); });
            await flushHookEffects({ cycles: 3, turns: 3 });
            expect(boundary.rpc.mock.calls.length).toBeGreaterThan(reads);
            expect(hook.getCurrent().status).toBe('ready');
            expect(hook.getCurrent().history?.range).toBe('1h');
        } finally {
            await hook.unmount();
        }
    });

    it('projects slow and repeated watch failures while retaining the held summary, then clears the issue on recovery', async () => {
        const { useMachineResourceLiveDemand } = await import('./useMachineResourceLiveDemand');
        const { useMachineResourceSummary } = await import('./useMachineResourceSummary');
        const { machineResourceStore } = await import('./machineResourceStore');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const sampledAt = Date.now();
        const machine = createMachineFixture({ id: 'machine-a', activeAt: sampledAt });
        storage.setState({ machineListByServerId: { [homeA]: [machine] }, machineListStatusByServerId: { [homeA]: 'idle' } });
        const watches: Array<ReturnType<typeof createDeferred<unknown>>> = [];
        boundary.rpc.mockImplementation(async input => {
            if (input.method === 'daemon.vitals.watch') {
                const answer = createDeferred<unknown>();
                watches.push(answer);
                input.signal?.addEventListener('abort', () => answer.resolve({ changed: false }), { once: true });
                return answer.promise;
            }
            return { state: 'reporting', sample: { v: 1, sampledAt, intervalMs: 15_000,
                cpu: { reported: true, busyPct: 20 }, memory: { reported: true, totalBytes: 100, availableBytes: 80, usedBytes: 20, pressure: { level: 'calm', source: 'psi' } },
                disk: { reported: true, volumes: [] }, network: { reported: true, rxBps: 12, txBps: 3 } },
                series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } };
        });
        const keys = [{ serverId: homeA, machineId: 'machine-a', expectedAccountId: 'owner' }];
        const hook = await renderHook(() => {
            useMachineResourceLiveDemand(keys, { detail: 'summary' });
            return useMachineResourceSummary(keys[0]!);
        });
        await flushHookEffects({ cycles: 3, turns: 3 });
        const good = hook.getCurrent();
        expect(good).toMatchObject({ kind: 'reporting', freshness: 'live', summary: { sampledAt } });
        await act(async () => watches[0]!.reject(new Error('watch deadline')));
        await flushHookEffects();
        const slow = hook.getCurrent();
        expect(slow).toMatchObject({ kind: 'reporting', freshness: 'held', readStatus: 'slow' });
        expect(slow?.kind === 'reporting' ? slow.summary : null).toBe(good?.kind === 'reporting' ? good.summary : null);
        await act(async () => watches[1]!.reject(new Error('watch deadline')));
        await flushHookEffects();
        expect(hook.getCurrent()).toMatchObject({ kind: 'reporting', freshness: 'held', readStatus: 'error' });
        expect(watches).toHaveLength(2);
        await act(async () => { await machineResourceStore.retry({ ...keys[0]!, view: 'summary' }); });
        expect(hook.getCurrent()).toMatchObject({ kind: 'reporting', freshness: 'live', summary: { sampledAt } });
        expect(hook.getCurrent()).not.toHaveProperty('readStatus');
        await hook.unmount();
    });

    it('demands every qualified row independently even when the first machine is still reading', async () => {
        const { useMachineResourceLiveDemand } = await import('./useMachineResourceLiveDemand');
        const { useMachineResourceSummary } = await import('./useMachineResourceSummary');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const sampledAt = Date.now();
        const resources = { v: 1, vitals: { state: 'reporting' }, host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 }, attention: { level: 'calm', reasons: [] } };
        const machine = (id: string) => createMachineFixture({ id, activeAt: sampledAt, daemonState: { resources } });
        storage.setState({ machineListByServerId: { [homeA]: [machine('first'), machine('second')], [homeB]: [machine('first')] },
            machineListStatusByServerId: { [homeA]: 'idle', [homeB]: 'idle' } });
        const pendingFirst = createDeferred<unknown>();
        const keys = [{ serverId: homeA, machineId: 'first' }, { serverId: homeA, machineId: 'second' }, { serverId: homeB, machineId: 'first' }];
        boundary.rpc.mockImplementation(async input => {
            if (input.method === 'daemon.vitals.watch') {
                const answer = createDeferred<unknown>();
                input.signal?.addEventListener('abort', () => answer.resolve({ changed: false }), { once: true });
                return answer.promise;
            }
            if (input.serverId === homeA && input.machineId === 'first') return pendingFirst.promise;
            const busyPct = input.serverId === homeB ? 40 : 30;
            return { state: 'reporting', sample: { v: 1, sampledAt, intervalMs: 15_000,
                cpu: { reported: true, busyPct }, memory: { reported: true, totalBytes: 100, availableBytes: 80, usedBytes: 20, pressure: { level: 'calm', source: 'psi' } },
                disk: { reported: true, volumes: [] }, network: { reported: true, rxBps: 12, txBps: 3 } },
                series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } };
        });
        const hook = await renderHook(() => {
            useMachineResourceLiveDemand(keys, { detail: 'summary' });
            return [useMachineResourceSummary(keys[0]!), useMachineResourceSummary(keys[1]!), useMachineResourceSummary(keys[2]!)];
        });
        await flushHookEffects({ cycles: 3, turns: 3 });
        const readings = hook.getCurrent();
        expect(readings[0]?.kind === 'reporting' ? readings[0].summary : null).toBeNull();
        expect(readings[1]?.kind === 'reporting' ? readings[1].summary?.cpu.busyPct : null).toBe(30);
        expect(readings[2]?.kind === 'reporting' ? readings[2].summary?.cpu.busyPct : null).toBe(40);
        expect(boundary.rpc.mock.calls.filter(([input]) => input.method === 'machines.vitals.get')).toHaveLength(3);
        await hook.unmount();
        pendingFirst.resolve({ state: 'reporting', sample: null, series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } });
    });

    it('re-reads only the machines that join the demanded set when another machine comes or goes', async () => {
        const { useMachineResourceLiveDemand } = await import('./useMachineResourceLiveDemand');
        const sampledAt = Date.now();
        const key = (machineId: string) => ({ serverId: homeA, machineId });
        boundary.rpc.mockImplementation(async input => {
            if (input.method === 'daemon.vitals.watch') {
                const answer = createDeferred<unknown>();
                input.signal?.addEventListener('abort', () => answer.resolve({ changed: false }), { once: true });
                return answer.promise;
            }
            return { state: 'reporting', sample: { v: 1, sampledAt, intervalMs: 15_000,
                cpu: { reported: true, busyPct: 30 }, memory: { reported: true, totalBytes: 100, availableBytes: 80, usedBytes: 20, pressure: { level: 'calm', source: 'psi' } },
                disk: { reported: true, volumes: [] }, network: { reported: true, rxBps: 12, txBps: 3 } },
                series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } };
        });
        const hook = await renderHook(({ ids }: { ids: readonly string[] }) => useMachineResourceLiveDemand(ids.map(key), { detail: 'summary' }),
            { initialProps: { ids: ['one', 'two', 'three'] } });
        await flushHookEffects({ cycles: 3, turns: 3 });
        const reads = () => boundary.rpc.mock.calls.filter(([input]) => input.method === 'machines.vitals.get').map(([input]) => input.machineId);
        expect(reads().sort()).toEqual(['one', 'three', 'two']);
        // A machine going offline and another coming online changes the demanded set, not the demand of its neighbours.
        await hook.rerender({ ids: ['one', 'three', 'four'] });
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(reads().sort()).toEqual(['four', 'one', 'three', 'two']);
        await hook.unmount();
    });

    it('keeps one credential binding and a pending Overview read through detail renders and unrelated Home publications', async () => {
        const { useMachineVitalsOverview } = await import('./useMachineVitalsOverview');
        const { useMachineDaemonReadIdentities } = await import('../useMachineDaemonReadTarget');
        const { machineResourceStore } = await import('./machineResourceStore');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        storage.setState({ machineListByServerId: { [homeA]: [createMachineFixture({ id: 'machine-a', activeAt: Date.now() })] } });
        const pending = createDeferred<unknown>();
        const aborted: string[] = [];
        boundary.rpc.mockImplementation(input => {
            input.signal?.addEventListener('abort', () => aborted.push(input.method), { once: true });
            return pending.promise;
        });
        // Observe the real demand owner without replacing its lifecycle or clients.
        const originalDemand = machineResourceStore.demand.bind(machineResourceStore);
        let releases = 0;
        const demand = vi.spyOn(machineResourceStore, 'demand').mockImplementation(input => {
            const release = originalDemand(input);
            return () => { releases += 1; release(); };
        });
        const bindings = new Set<NonNullable<ReturnType<typeof useMachineDaemonReadIdentities>[number]['accountBinding']>>();
        const hook = await renderHook(() => {
            // Fresh input containers match ordinary Machine detail renders.
            const identity = useMachineDaemonReadIdentities([{ serverId: homeA, machineId: 'machine-a' }])[0]!;
            if (identity.accountBinding) bindings.add(identity.accountBinding);
            return useMachineVitalsOverview({ serverId: homeA, machineId: 'machine-a', range: '1h' });
        });
        try {
            await flushHookEffects({ cycles: 3, turns: 3 });
            for (let render = 0; render < 20; render += 1) await hook.rerender();
            const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
            await act(async () => {
                await upsertServerProfile({ serverUrl: 'https://resource-home-a.test', name: 'Renamed Home A' });
                await upsertServerProfile({ serverUrl: 'https://resource-home-b.test', name: 'Renamed Home B' });
            });
            await flushHookEffects();
            expect(bindings.size).toBe(1);
            expect(demand).toHaveBeenCalledTimes(1);
            expect(releases).toBe(0);
            expect(aborted).toEqual([]);
            expect(boundary.rpc.mock.calls.filter(([input]) => input.method === 'machines.vitals.get')).toHaveLength(1);
            expect(boundary.rpc.mock.calls.filter(([input]) => input.method === 'machines.vitals.history.get')).toHaveLength(1);
            await hook.unmount();
            // Credential retirement and effect cleanup may both call the idempotent release.
            expect(releases).toBeGreaterThan(0);
            expect(aborted.sort()).toEqual(['machines.vitals.get', 'machines.vitals.history.get']);
        } finally {
            await hook.unmount();
            demand.mockRestore();
            pending.resolve({ state: 'reporting', sample: null, series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } });
        }
    });

    it.each([
        { reason: 'helper_missing', expected: { kind: 'not_reported', reason: 'unsupported' } },
        { reason: 'reader_failed', expected: { kind: 'reporting', summary: null, freshness: 'stale', attention: { level: 'calm', reasons: [] } } },
    ] as const)('maps first-read unavailable $reason without host facts or value demand', async ({ reason, expected }) => {
        const { useMachineResourceSummary } = await import('./useMachineResourceSummary');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const machine = createMachineFixture({ id: 'machine-a', activeAt: Date.now(), daemonStateVersion: 1, daemonState: {
            resources: { v: 1, vitals: { state: 'unavailable', reason, since: 1 }, attention: { level: 'calm', reasons: [] } },
        } });
        storage.setState({ machineListByServerId: { [homeA]: [machine] }, machineListStatusByServerId: { [homeA]: 'idle' } });
        const hook = await renderHook(() => useMachineResourceSummary({ serverId: homeA, machineId: 'machine-a' }));
        expect(hook.getCurrent()).toEqual(expected);
        expect(boundary.rpc).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('reads the selected history range and suspends a mounted Overview when its route loses focus', async () => {
        const { useMachineVitalsOverview } = await import('./useMachineVitalsOverview');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        storage.setState({ machineListByServerId: { [homeA]: [createMachineFixture({ id: 'machine-a', activeAt: Date.now() })] } });
        boundary.rpc.mockImplementation(async input => {
            if (input.method === 'daemon.vitals.watch') {
                const answer = createDeferred<unknown>();
                input.signal?.addEventListener('abort', () => answer.resolve({ changed: false }), { once: true });
                return answer.promise;
            }
            if (input.method === 'machines.vitals.history.get') {
                const payload = input.payload as { range: '1h' | '24h' | '7d' };
                return { range: payload.range, bucketMs: 60_000, points: [], today: { rxBytes: 0, txBytes: 0 } };
            }
            return { state: 'reporting', sample: null, series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } };
        });
        boundary.focused = false;
        const { NavigationContext } = await import('@react-navigation/native');
        const Navigation = ({ children }: React.PropsWithChildren) => React.createElement(NavigationContext.Provider, { value: {} as React.ContextType<typeof NavigationContext> }, children);
        const hook = await renderHook(({ range }: { range: '1h' | '24h' | '7d' }) => useMachineVitalsOverview({
            serverId: homeA, machineId: 'machine-a', range,
        }), { initialProps: { range: '1h' }, wrapper: Navigation });
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(boundary.rpc).not.toHaveBeenCalled();
        boundary.focused = true;
        await hook.rerender();
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(hook.getCurrent().history?.range).toBe('1h');
        await hook.rerender({ range: '24h' });
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(hook.getCurrent().history?.range).toBe('24h');
        const snapshots = boundary.rpc.mock.calls.filter(([input]) => input.method === 'machines.vitals.get');
        expect(snapshots).toHaveLength(1);
        boundary.focused = false;
        await hook.rerender();
        const count = boundary.rpc.mock.calls.length;
        await hook.rerender({ range: '7d' });
        expect(boundary.rpc).toHaveBeenCalledTimes(count);
        expect(boundary.rpc.mock.calls.filter(([input]) => input.method === 'daemon.vitals.watch').every(([input]) => input.signal?.aborted)).toBe(true);
        await hook.unmount();
    });

    it('clears published reader-failed freshness when an authorized live answer recovers', async () => {
        const { useMachineResourceSummary } = await import('./useMachineResourceSummary');
        const { machineResourceStore } = await import('./machineResourceStore');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const sampledAt = Date.now();
        const machine = createMachineFixture({ id: 'machine-a', active: true, activeAt: sampledAt, daemonStateVersion: 1, daemonState: {
            resources: { v: 1, vitals: { state: 'unavailable', reason: 'reader_failed', since: sampledAt - 60_000 },
                attention: { level: 'calm', reasons: [] } },
        } });
        storage.setState({ machineListByServerId: { [homeA]: [machine] }, machineListStatusByServerId: { [homeA]: 'idle' } });
        boundary.rpc.mockResolvedValue({ state: 'reporting', sample: {
            v: 1, sampledAt, intervalMs: 15_000, cpu: { reported: true, busyPct: 20 },
            memory: { reported: true, totalBytes: 100, availableBytes: 80, usedBytes: 20, pressure: { level: 'calm', source: 'psi' } },
            disk: { reported: true, volumes: [] }, network: { reported: true, rxBps: 12, txBps: 3 },
        }, series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } });
        const key = { serverId: homeA, machineId: 'machine-a', expectedAccountId: 'owner', view: 'summary' as const };
        const hook = await renderHook(() => useMachineResourceSummary(key));
        expect(hook.getCurrent()).toMatchObject({ kind: 'reporting', summary: null, freshness: 'stale' });
        await act(async () => { await machineResourceStore.read(key); });
        expect(hook.getCurrent()).toMatchObject({ kind: 'reporting', freshness: 'live', summary: { sampledAt } });
        await act(async () => {
            storage.setState({ machineListByServerId: { [homeA]: [{ ...machine, daemonStateVersion: 2, daemonState: {
                resources: { v: 1, vitals: { state: 'unavailable', reason: 'reader_failed', since: sampledAt + 1 },
                    attention: { level: 'calm', reasons: [] } },
            } }] } });
        });
        expect(hook.getCurrent()).toMatchObject({ kind: 'reporting', freshness: 'stale', summary: { sampledAt } });
        await hook.unmount();
    });

    it('retones cached values from canonical published attention without value RPCs or identity churn', async () => {
        const { useMachineResourceSummary } = await import('./useMachineResourceSummary');
        const { machineResourceStore } = await import('./machineResourceStore');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const sampledAt = Date.now();
        const resources = { v: 1, vitals: { state: 'reporting' }, host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 }, attention: { level: 'calm', reasons: [] } };
        const machine = createMachineFixture({ id: 'machine-a', activeAt: sampledAt, daemonState: { resources } });
        storage.setState({ machineListByServerId: { [homeA]: [machine] }, machineListStatusByServerId: { [homeA]: 'idle' } });
        boundary.rpc.mockResolvedValue({ state: 'reporting', sample: {
            v: 1, sampledAt, intervalMs: 15_000, cpu: { reported: true, busyPct: 20 },
            memory: { reported: true, totalBytes: 100, availableBytes: 80, usedBytes: 20, pressure: { level: 'calm', source: 'psi' } },
            disk: { reported: true, volumes: [] }, network: { reported: true, rxBps: 12, txBps: 3 },
        }, series5m: { cpu: [], memory: [{ t: sampledAt, y: 80 }], networkRx: [], networkTx: [] }, attention: { level: 'calm', reasons: [] } });
        const key = { serverId: homeA, machineId: 'machine-a' };
        const hook = await renderHook(() => useMachineResourceSummary(key));
        await act(async () => { await machineResourceStore.read({ ...key, expectedAccountId: 'owner', view: 'summary' }); });
        const before = hook.getCurrent();
        const oldSummary = before?.kind === 'reporting' ? before.summary : null;
        expect(oldSummary?.memory.tone).toBe('calm');
        const updated = { ...resources, attention: { level: 'needs_you', reasons: [{
            kind: 'memory_pressure', key: 'memory', metric: 'memory', level: 'needs_you', since: sampledAt, pressure: 'critical', swapping: false,
        }] } };
        await act(async () => { storage.setState({ machineListByServerId: { [homeA]: [{ ...machine, daemonStateVersion: 2, daemonState: { resources: updated } }] } }); });
        const after = hook.getCurrent();
        const summary = after?.kind === 'reporting' ? after.summary : null;
        expect(summary?.memory.tone).toBe('crit');
        expect(summary?.memory.availableBytes).toBe(80);
        expect(summary?.memory.series).toBe(oldSummary?.memory.series);
        expect(summary?.cpu).toBe(oldSummary?.cpu);
        await act(async () => { storage.setState({ machineListByServerId: { [homeA]: [{ ...machine, daemonStateVersion: 3, daemonState: { resources: structuredClone(updated) } }] } }); });
        const repeated = hook.getCurrent();
        expect(repeated?.kind === 'reporting' ? repeated.summary : null).toBe(summary);
        expect(boundary.rpc).toHaveBeenCalledOnce();
        await hook.unmount();
    });

    it('reads nothing when hidden, backgrounded or closed, releases watches, and catches up immediately on resume', async () => {
        const { useMachineResourceLiveDemand } = await import('./useMachineResourceLiveDemand');
        const { useMachineResourceSummary } = await import('./useMachineResourceSummary');
        boundary.visibility = 'hidden';
        boundary.appState?.emit('active');
        const watches: Array<{ signal?: AbortSignal; resolve: (value: unknown) => void }> = [];
        boundary.rpc.mockImplementation(async input => {
            if (input.method === 'daemon.vitals.watch') {
                const answer = createDeferred<unknown>();
                watches.push({ signal: input.signal, resolve: answer.resolve });
                input.signal?.addEventListener('abort', () => answer.resolve({ changed: false }), { once: true });
                return answer.promise;
            }
            return { state: 'reporting', sample: null, series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } };
        });
        const key = { serverId: homeA, machineId: 'machine-a' };
        const hook = await renderHook(({ enabled }: { enabled: boolean }) => {
            useMachineResourceLiveDemand([key], { detail: 'summary', enabled });
            return useMachineResourceSummary(key);
        }, { initialProps: { enabled: true } });
        expect(boundary.rpc).not.toHaveBeenCalled();
        await act(async () => { boundary.visibility = 'visible'; documentBoundary.dispatchEvent(new Event('visibilitychange')); });
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(boundary.rpc.mock.calls.filter(([input]) => input.method === 'machines.vitals.get')).toHaveLength(1);
        expect(watches).toHaveLength(1);
        expect(hook.getCurrent()?.kind).toBe('never_sampled');
        const hydrated = hook.getCurrent();
        await act(async () => { boundary.appState?.emit('background'); });
        expect(watches[0].signal?.aborted).toBe(true);
        const count = boundary.rpc.mock.calls.length;
        await flushHookEffects();
        expect(boundary.rpc).toHaveBeenCalledTimes(count);
        expect(hook.getCurrent()).toBe(hydrated);
        await act(async () => { boundary.appState?.emit('active'); });
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(boundary.rpc.mock.calls.filter(([input]) => input.method === 'machines.vitals.get')).toHaveLength(2);
        expect(watches).toHaveLength(2);
        await hook.rerender({ enabled: false });
        expect(watches[1].signal?.aborted).toBe(true);
        const closedCount = boundary.rpc.mock.calls.length;
        await flushHookEffects();
        expect(boundary.rpc).toHaveBeenCalledTimes(closedCount);
        await hook.unmount();
    });
});
