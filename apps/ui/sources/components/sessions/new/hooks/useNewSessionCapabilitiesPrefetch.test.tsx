import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { getMachineCapabilitiesCacheState, prefetchMachineCapabilitiesIfStale } from '@/hooks/server/useMachineCapabilitiesCache';
import { resolveDaemonCapabilitiesCacheKeySalt } from '@/hooks/server/useDaemonScopedMachineCapabilitiesCache';
import { publishMachineContributionRegistryProjectionInvalidation } from '@/sync/ops/machineContributionRegistryProjectionRevision';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { useNewSessionCapabilitiesPrefetch } from './useNewSessionCapabilitiesPrefetch';
import { act } from 'react-test-renderer';

// Exercise real scheduling/cache logic beneath the machine RPC transport boundary.
const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
afterEach(() => { standardCleanup(); machineRpc.mockReset(); vi.useRealTimers(); });

const request = { requests: [{ id: 'tool.tmux' as const }] };

describe('new-session capability prefetch', () => {
    it('cancels stranded work on cleanup and retries when prefetch is enabled again', async () => {
        vi.useFakeTimers();
        const machine = createMachineFixture({ id: 'prefetch-cleanup', activeAt: Date.now() });
        const serverId = 'prefetch-cleanup-home';
        let signal: AbortSignal | undefined;
        machineRpc.mockImplementationOnce((args: { signal?: AbortSignal }) => {
            signal = args.signal;
            return new Promise(() => {});
        });
        const machines = [machine];
        const empty: typeof machines = [];
        const hook = await renderHook(({ enabled }: { enabled: boolean }) => useNewSessionCapabilitiesPrefetch({
            enabled, serverId, machines, favoriteMachineItems: empty, recentMachines: empty,
            selectedMachineId: machine.id, isMachineOnline, staleMs: 60_000, request, prefetchMachineCapabilitiesIfStale,
        }), { initialProps: { enabled: true }, flushOptions: { cycles: 0 } });
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(getMachineCapabilitiesCacheState(machine.id, serverId, 0)?.status).toBe('loading');
        await hook.rerender({ enabled: false });
        expect(signal?.aborted).toBe(true);
        expect(getMachineCapabilitiesCacheState(machine.id, serverId, 0)?.status).toBe('idle');
        machineRpc.mockResolvedValueOnce({ protocolVersion: 1, results: { 'tool.tmux': { ok: true, checkedAt: 12, data: { available: true } } } });
        await hook.rerender({ enabled: true });
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(getMachineCapabilitiesCacheState(machine.id, serverId, 0)?.status).toBe('loaded');
        await hook.unmount();
    });

    it('preserves another mounted reader when a prefetch owner leaves', async () => {
        vi.useFakeTimers();
        const machine = createMachineFixture({ id: 'prefetch-shared-cleanup', activeAt: Date.now() });
        const serverId = 'prefetch-shared-cleanup-home';
        let signal: AbortSignal | undefined;
        let respond!: (response: unknown) => void;
        machineRpc.mockImplementationOnce((args: { signal?: AbortSignal }) => {
            signal = args.signal;
            return new Promise(resolve => { respond = resolve; });
        });
        const machines = [machine];
        const empty: typeof machines = [];
        const render = () => renderHook(() => useNewSessionCapabilitiesPrefetch({
            enabled: true, serverId, machines, favoriteMachineItems: empty, recentMachines: empty,
            selectedMachineId: machine.id, isMachineOnline, staleMs: 60_000, request, prefetchMachineCapabilitiesIfStale,
        }), { flushOptions: { cycles: 0 } });
        const first = await render();
        const second = await render();
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        await first.unmount();
        expect(signal?.aborted).toBe(false);
        respond({ protocolVersion: 1, results: { 'tool.tmux': { ok: true, checkedAt: 12, data: { available: true } } } });
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(getMachineCapabilitiesCacheState(machine.id, serverId, 0)?.status).toBe('loaded');
        await second.unmount();
    });

    it('keeps a pending request alive across machine heartbeat and array churn', async () => {
        vi.useFakeTimers();
        const machine = createMachineFixture({ id: 'prefetch-pending-churn', activeAt: Date.now() });
        let signal: AbortSignal | undefined;
        let respond!: (response: unknown) => void;
        machineRpc.mockImplementationOnce((args: { signal?: AbortSignal }) => {
            signal = args.signal;
            return new Promise(resolve => { respond = resolve; });
        });
        const hook = await renderHook(({ version }: { version: number }) => useNewSessionCapabilitiesPrefetch({
            enabled: true, serverId: 'prefetch-pending-churn-home', machines: [{ ...machine, daemonStateVersion: version }],
            favoriteMachineItems: [], recentMachines: [], selectedMachineId: machine.id, isMachineOnline,
            staleMs: 60_000, request, prefetchMachineCapabilitiesIfStale,
        }), { initialProps: { version: 1 }, flushOptions: { cycles: 0 } });
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        await hook.rerender({ version: 2 });
        expect(signal?.aborted).toBe(false);
        respond({ protocolVersion: 1, results: { 'tool.tmux': { ok: true, checkedAt: 12, data: { available: true } } } });
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(getMachineCapabilitiesCacheState(machine.id, 'prefetch-pending-churn-home', 0)?.status).toBe('loaded');
        await hook.unmount();
    });

    it('does not lose the selected prefetch when rerender precedes its web deferral', async () => {
        vi.useFakeTimers();
        const machine = createMachineFixture({ id: 'prefetch-deferred', activeAt: Date.now() });
        machineRpc.mockResolvedValue({ protocolVersion: 1, results: { 'tool.tmux': { ok: true, checkedAt: 12, data: { available: true } } } });
        const hook = await renderHook(({ churn }: { churn: number }) => useNewSessionCapabilitiesPrefetch({
            enabled: true, serverId: 'prefetch-deferred-home', machines: [{ ...machine, daemonStateVersion: churn }],
            favoriteMachineItems: [], recentMachines: [], selectedMachineId: machine.id, isMachineOnline,
            staleMs: 60_000, request, prefetchMachineCapabilitiesIfStale,
        }), { initialProps: { churn: 0 }, flushOptions: { cycles: 0 } });
        expect(machineRpc).not.toHaveBeenCalled();
        await hook.rerender({ churn: 1 });
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(getMachineCapabilitiesCacheState(machine.id, 'prefetch-deferred-home', 0)).toMatchObject({ status: 'loaded' });
        await hook.unmount();
    });

    it('keeps valid facts across array/version churn and reads a changed registry namespace', async () => {
        const machine = createMachineFixture({ id: 'prefetch-currentness', activeAt: Date.now(), daemonStateVersion: 1 });
        const serverId = 'prefetch-currentness-home';
        let available = true;
        machineRpc.mockImplementation(async () => ({ protocolVersion: 1, results: {
            'tool.tmux': { ok: true, checkedAt: 12, data: { available } },
        } }));
        const hook = await renderHook(({ version }: { version: number }) => useNewSessionCapabilitiesPrefetch({
            enabled: true, serverId, machines: [{ ...machine, daemonStateVersion: version }],
            favoriteMachineItems: [], recentMachines: [], selectedMachineId: machine.id,
            isMachineOnline, staleMs: 60_000, request, prefetchMachineCapabilitiesIfStale,
        }), { initialProps: { version: 1 } });
        const read = () => getMachineCapabilitiesCacheState(machine.id, serverId, resolveDaemonCapabilitiesCacheKeySalt(machine, serverId));
        await vi.waitFor(() => expect(read()?.status).toBe('loaded'));
        const ready = read();
        available = false;
        machineRpc.mockClear();
        await hook.rerender({ version: 1 });
        await hook.rerender({ version: 2 });
        expect(read()).toBe(ready);
        expect(machineRpc).not.toHaveBeenCalled();
        publishMachineContributionRegistryProjectionInvalidation({ serverId, machineId: machine.id }, 'authority');
        await hook.rerender({ version: 3 });
        await vi.waitFor(() => expect(read()).toMatchObject({ status: 'loaded', snapshot: {
            response: { results: { 'tool.tmux': { data: { available: false } } } },
        } }));
        await hook.unmount();
    });

    it('keeps the same machine separate across Homes', async () => {
        const machine = createMachineFixture({ id: 'prefetch-two-homes', activeAt: Date.now() });
        machineRpc.mockImplementation(async ({ serverId }: { serverId: string }) => ({ protocolVersion: 1, results: {
            'tool.tmux': { ok: true, checkedAt: 12, data: { available: serverId === 'prefetch-home-a' } },
        } }));
        const hook = await renderHook(({ serverId }: { serverId: string }) => useNewSessionCapabilitiesPrefetch({
            enabled: true, serverId, machines: [machine], favoriteMachineItems: [machine], recentMachines: [],
            selectedMachineId: machine.id, isMachineOnline, staleMs: 60_000, request, prefetchMachineCapabilitiesIfStale,
        }), { initialProps: { serverId: 'prefetch-home-a' } });
        const read = (serverId: string) => getMachineCapabilitiesCacheState(machine.id, serverId, resolveDaemonCapabilitiesCacheKeySalt(machine, serverId));
        await vi.waitFor(() => expect(read('prefetch-home-a')?.status).toBe('loaded'));
        await hook.rerender({ serverId: 'prefetch-home-b' });
        await vi.waitFor(() => expect(read('prefetch-home-b')).toMatchObject({ status: 'loaded', snapshot: {
            response: { results: { 'tool.tmux': { data: { available: false } } } },
        } }));
        expect(read('prefetch-home-a')).toMatchObject({ snapshot: { response: { results: { 'tool.tmux': { data: { available: true } } } } } });
        await hook.unmount();
    });

    it('does not demand capability work while disabled', async () => {
        const machine = createMachineFixture({ id: 'prefetch-disabled', activeAt: Date.now() });
        const hook = await renderHook(() => useNewSessionCapabilitiesPrefetch({
            enabled: false, serverId: 'prefetch-disabled-home', machines: [machine], favoriteMachineItems: [], recentMachines: [],
            selectedMachineId: machine.id, isMachineOnline, staleMs: 60_000, request, prefetchMachineCapabilitiesIfStale,
        }));
        expect(getMachineCapabilitiesCacheState(machine.id, 'prefetch-disabled-home', 0)).toBeNull();
        expect(machineRpc).not.toHaveBeenCalled();
        await hook.unmount();
    });
});
