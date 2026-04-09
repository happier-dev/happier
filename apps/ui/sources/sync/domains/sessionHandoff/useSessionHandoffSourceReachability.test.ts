import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import {
    invalidateCachedTransferRoutesForServer,
    recordCachedMachineRpcDirectRouteUnavailable,
    recordCachedMachineRpcDirectRouteViable,
} from '@/sync/domains/transfers/runtime/transferRouteCache';

const probeSessionHandoffSourceReachabilityMock = vi.hoisted(() => vi.fn());

vi.mock('./probeSessionHandoffSourceReachability', () => ({
    probeSessionHandoffSourceReachability: (...args: unknown[]) => probeSessionHandoffSourceReachabilityMock(...args),
}));

describe('useSessionHandoffSourceReachability', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        probeSessionHandoffSourceReachabilityMock.mockReset();
        probeSessionHandoffSourceReachabilityMock.mockImplementation(async () => await new Promise<never>(() => undefined));
        invalidateCachedTransferRoutesForServer({ serverId: 'server-a' });
    });

    afterEach(() => {
        vi.useRealTimers();
        standardCleanup();
        invalidateCachedTransferRoutesForServer({ serverId: 'server-a' });
    });

    it('downgrades from reachable to unknown when the server-scoped cache is invalidated', async () => {
        recordCachedMachineRpcDirectRouteViable({
            serverId: 'server-a',
            remoteMachineId: 'machine-a',
        });

        const { useSessionHandoffSourceReachability } = await import('./useSessionHandoffSourceReachability');

        const hook = await renderHook(() => useSessionHandoffSourceReachability({
            serverId: 'server-a',
            sourceMachineId: 'machine-a',
        }));

        expect(hook.getCurrent()).toBe('reachable');

        await act(async () => {
            invalidateCachedTransferRoutesForServer({ serverId: 'server-a' });
        });

        expect(hook.getCurrent()).toBe('unknown');

        await hook.unmount();
    });

    it('returns unavailable immediately when the server-scoped cache already proves the route is unavailable', async () => {
        recordCachedMachineRpcDirectRouteUnavailable({
            serverId: 'server-a',
            remoteMachineId: 'machine-a',
        }, 'machine_rpc_direct_unavailable');

        const { useSessionHandoffSourceReachability } = await import('./useSessionHandoffSourceReachability');

        const hook = await renderHook(() => useSessionHandoffSourceReachability({
            serverId: 'server-a',
            sourceMachineId: 'machine-a',
        }));

        expect(hook.getCurrent()).toBe('unavailable');
        expect(probeSessionHandoffSourceReachabilityMock).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('keeps retrying after repeated transient unavailable probes and promotes to reachable when a later probe succeeds within the retry window', async () => {
        probeSessionHandoffSourceReachabilityMock
            .mockResolvedValueOnce('unavailable')
            .mockResolvedValueOnce('unavailable')
            .mockResolvedValueOnce('reachable');

        const { useSessionHandoffSourceReachability } = await import('./useSessionHandoffSourceReachability');

        const hook = await renderHook(() => useSessionHandoffSourceReachability({
            serverId: 'server-a',
            sourceMachineId: 'machine-a',
        }));

        expect(hook.getCurrent()).toBe('unavailable');

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_000);
        });

        expect(probeSessionHandoffSourceReachabilityMock).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent()).toBe('unavailable');

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_000);
        });

        expect(probeSessionHandoffSourceReachabilityMock).toHaveBeenCalledTimes(3);
        expect(hook.getCurrent()).toBe('reachable');

        await hook.unmount();
    });
});
