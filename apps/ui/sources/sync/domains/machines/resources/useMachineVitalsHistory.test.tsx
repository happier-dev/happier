import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderHook } from '@/dev/testkit';
import type { createReactNativeAppStateEmitter } from '@/dev/testkit/mocks/reactNative';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
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
// Cold app-entry registration belongs to collection, after installing physical boundaries.
// Per-case setup below still restores the real singleton after each Home reset.
await loadSyncSingletonForTests();
let homeA = '';

describe('a service\'s usage history', () => {
    beforeEach(async () => {
        await homes.reset();
        await loadSyncSingletonForTests();
        homeA = await homes.addHome({ name: 'Home A', serverUrl: 'https://resource-home-a.test', accountId: 'owner', currentAccount: true });
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


    it('reads one service\'s history for the chosen range only while its page is active, without a live vitals watch', async () => {
        const { useMachineServiceUsageHistory } = await import('./useMachineVitalsHistory');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        await publishMachineInventoryForTest({ serverId: homeA, accountId: 'owner' }, [createMachineFixture({ id: 'machine-a', activeAt: Date.now() })]);
        boundary.rpc.mockImplementation(async input => {
            if (input.method !== 'machines.vitals.history.get') throw new Error(`unexpected ${input.method}`);
            const payload = input.payload as { range: '1h' | '24h' | '7d'; serviceId?: string };
            return { range: payload.range, bucketMs: 300_000, points: [], today: { rxBytes: 0, txBytes: 0 },
                ...(payload.serviceId ? { service: { serviceId: payload.serviceId, points: [{ t: 1_000, cpuPercent: 4, cpuMaxPercent: 9,
                    memoryBytes: 200, memoryMaxBytes: 210 }] } } : {}) };
        });
        const hook = await renderHook(({ range, enabled }: { range: '1h' | '24h' | '7d'; enabled: boolean }) => useMachineServiceUsageHistory({
            serverId: homeA, machineId: 'machine-a', serviceId: 'svc-api', range, enabled,
        }), { initialProps: { range: '24h', enabled: false } });
        await flushHookEffects({ cycles: 3, turns: 3 });
        // A page that isn't presented reads nothing.
        expect(boundary.rpc).not.toHaveBeenCalled();
        await hook.rerender({ range: '24h', enabled: true });
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(hook.getCurrent().history?.service).toEqual({ serviceId: 'svc-api',
            points: [{ t: 1_000, cpuPercent: 4, cpuMaxPercent: 9, memoryBytes: 200, memoryMaxBytes: 210 }] });
        await hook.rerender({ range: '7d', enabled: true });
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(hook.getCurrent().history?.range).toBe('7d');
        // One history read per range, each naming the service; no Machine snapshot or live watch starts for it.
        expect(boundary.rpc.mock.calls.map(([input]) => [input.method, input.payload])).toEqual([
            ['machines.vitals.history.get', expect.objectContaining({ machineId: 'machine-a', range: '24h', serviceId: 'svc-api' })],
            ['machines.vitals.history.get', expect.objectContaining({ machineId: 'machine-a', range: '7d', serviceId: 'svc-api' })],
        ]);
        const count = boundary.rpc.mock.calls.length;
        await hook.rerender({ range: '24h', enabled: false });
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(boundary.rpc).toHaveBeenCalledTimes(count);
        await hook.unmount();
    });
});
