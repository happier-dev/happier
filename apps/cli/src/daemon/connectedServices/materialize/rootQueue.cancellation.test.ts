import { describe, expect, it, vi } from 'vitest';

import { runSerializedMaterialization } from './materializeConnectedServicesForSpawn';

describe('materialization root queue cancellation', () => {
    it('retires a canceled middle waiter while preserving the predecessor and later writer', async () => {
        vi.useFakeTimers();
        const events: string[] = [];
        let releaseFirst!: () => void;
        const firstWork = new Promise<void>(resolve => { releaseFirst = resolve; });
        let entered!: () => void;
        const firstEntered = new Promise<void>(resolve => { entered = resolve; });
        const first = runSerializedMaterialization('cancelled-middle-fixture', async () => {
            events.push('first:start');
            entered();
            // The public queue consumer retains its own unfinished work.
            await firstWork;
            events.push('first:end');
        });
        await firstEntered;
        const controller = new AbortController();
        const middle = runSerializedMaterialization('cancelled-middle-fixture', async () => {
            events.push('middle');
        }, controller.signal);
        let middleRetired = false;
        const middleSettlement = middle.then(() => {}, () => { middleRetired = true; });
        let later: Promise<void> | undefined;
        try {
            controller.abort();
            await vi.advanceTimersByTimeAsync(0);
            expect(middleRetired).toBe(true);
            await expect(middle).rejects.toBe(controller.signal.reason);
            // Register after cancellation: deleting the tail early would let this writer bypass its predecessor.
            later = runSerializedMaterialization('cancelled-middle-fixture', async () => { events.push('later'); });
            await vi.advanceTimersByTimeAsync(0);
            expect(events).toEqual(['first:start']);
            releaseFirst();
            await Promise.all([first, middleSettlement, later]);
            expect(events).toEqual(['first:start', 'first:end', 'later']);
        } finally {
            releaseFirst();
            await Promise.allSettled([first, middleSettlement, later]);
            vi.useRealTimers();
        }
    });
});
