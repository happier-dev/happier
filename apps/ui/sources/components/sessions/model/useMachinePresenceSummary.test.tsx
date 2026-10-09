import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { useMachinePresenceSummary } from './useMachinePresenceSummary';

afterEach(() => { standardCleanup(); vi.useRealTimers(); });

describe('reactive Machine presence', () => {
    it('expires without another store notification and recovers on a heartbeat, while unknown is not offline', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(Date.now());
        const previous = storage.getState();
        const machine = createMachineFixture({ id: 'machine', activeAt: Date.now() });
        storage.setState({ machines: { machine }, machineListByServerId: { home: [machine] } });
        try {
            const hook = await renderHook(() => useMachinePresenceSummary('home', 'machine'));
            expect(hook.getCurrent().reachability).toBe('reachable');
            const admitted = hook.getCurrent();
            await act(async () => {
                vi.advanceTimersByTime(20_000);
                const heartbeat = { ...machine, activeAt: Date.now() };
                storage.setState({ machines: { machine: heartbeat }, machineListByServerId: { home: [heartbeat] } });
            });
            expect(hook.getCurrent()).toBe(admitted);
            await act(async () => { vi.advanceTimersByTime(40_001); });
            expect(hook.getCurrent().reachability).toBe('reachable');
            await act(async () => { vi.advanceTimersByTime(20_000); });
            expect(hook.getCurrent().reachability).toBe('unreachable');
            const refreshed = { ...machine, activeAt: Date.now() };
            await act(async () => { storage.setState({ machines: { machine: refreshed }, machineListByServerId: { home: [refreshed] } }); });
            expect(hook.getCurrent().reachability).toBe('reachable');
            await act(async () => { storage.setState({ machines: {}, machineListByServerId: { home: [] } }); });
            expect(hook.getCurrent().reachability).toBe('unknown');
            await hook.unmount();
        } finally { storage.setState(previous); }
    });
});
