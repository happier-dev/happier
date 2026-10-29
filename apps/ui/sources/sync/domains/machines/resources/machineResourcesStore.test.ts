import { describe, expect, it, vi } from 'vitest';

import { createMachineResourcesStore, IDLE_MACHINE_RESOURCES_ENTRY } from './machineResourcesStore';
import type { MachineResourcesSnapshot } from '@happier-dev/protocol';

function snapshot(sampledAt: number, usagePercent = 10): MachineResourcesSnapshot {
    return {
        sampledAt,
        cpu: { usagePercent },
        memory: { totalBytes: 100, usedBytes: usagePercent, usagePercent },
        disk: { path: '/', totalBytes: 100, availableBytes: 100 - usagePercent, usedBytes: usagePercent, usagePercent },
    };
}

describe('machineResourcesStore', () => {
    it('starts with the shared idle entry for every machine', () => {
        const store = createMachineResourcesStore();

        expect(store.getEntry('machine-1')).toBe(IDLE_MACHINE_RESOURCES_ENTRY);
    });

    it('merges snapshots and moves the entry to ready with a fetch timestamp', () => {
        const store = createMachineResourcesStore();

        store.markLoading('machine-1');
        const merged = store.mergeSnapshot('machine-1', snapshot(5, 42));

        expect(merged).toBe(true);
        const entry = store.getState().entriesByMachineId.get('machine-1');
        expect(entry?.status).toBe('ready');
        expect(entry?.snapshot?.cpu.usagePercent).toBe(42);
        expect(typeof entry?.fetchedAt).toBe('number');
    });

    it('marks errors without discarding the last-known-good snapshot', () => {
        const store = createMachineResourcesStore();

        store.mergeSnapshot('machine-1', snapshot(5, 42));
        store.markError('machine-1');

        const entry = store.getState().entriesByMachineId.get('machine-1');
        expect(entry?.status).toBe('error');
        expect(entry?.snapshot?.sampledAt).toBe(5);
    });

    it('suppresses notifications when the state does not change', () => {
        const store = createMachineResourcesStore();
        const listener = vi.fn();
        store.subscribe(listener);

        expect(store.markLoading('machine-1')).toBe(true);
        expect(listener).toHaveBeenCalledTimes(1);

        // Re-marking the same loading transition must not notify.
        expect(store.markLoading('machine-1')).toBe(false);
        expect(listener).toHaveBeenCalledTimes(1);

        // Merging the identical snapshot reference must not notify.
        const first = snapshot(5, 42);
        store.mergeSnapshot('machine-1', first);
        listener.mockClear();
        expect(store.mergeSnapshot('machine-1', first)).toBe(false);
        expect(listener).toHaveBeenCalledTimes(0);

        // Marking an already-error entry as errored again must not notify.
        store.markError('machine-1');
        listener.mockClear();
        expect(store.markError('machine-1')).toBe(false);
        expect(listener).toHaveBeenCalledTimes(0);
    });
});
