import { afterEach, describe, expect, it, vi } from 'vitest';

import { createParkWatch } from './parkWatch';

describe('parkWatch', () => {
    afterEach(() => vi.useRealTimers());

    it('closes the read-subscribe race and releases the subscription and demand', async () => {
        let version = 1;
        const listeners = new Set<() => void>();
        const counts: number[] = [];
        const watches = createParkWatch({ onWatcherCountChanged: count => counts.push(count) });
        const result = await watches.parkWatch({
            isNewer: () => version > 1,
            read: () => version,
            subscribe(listener) {
                version = 2;
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        });

        expect(result).toEqual({ changed: true, snapshot: 2 });
        expect(listeners.size).toBe(0);
        expect(watches.watcherCount()).toBe(0);
        expect(counts).toEqual([1, 0]);
    });

    it('keeps concurrent watches parked through idle time and releases each one on cancellation', async () => {
        vi.useFakeTimers();
        const listeners = new Set<() => void>();
        const watches = createParkWatch();
        const controller = new AbortController();
        const otherController = new AbortController();
        const input = {
            isNewer: () => false,
            read: () => 1,
            subscribe(listener: () => void) {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        };
        const aborted = watches.parkWatch({ ...input, signal: controller.signal });
        let idleReplies = 0;
        const idle = watches.parkWatch({ ...input, signal: otherController.signal }).then(result => { idleReplies++; return result; });
        expect(watches.watcherCount()).toBe(2);

        controller.abort();
        expect(await aborted).toEqual({ changed: false });
        expect(watches.watcherCount()).toBe(1);
        expect(listeners.size).toBe(1);
        try {
            await vi.advanceTimersByTimeAsync(60_000);
            expect(idleReplies).toBe(0);
            expect(watches.watcherCount()).toBe(1);
        } finally { otherController.abort(); await idle; }
        expect(watches.watcherCount()).toBe(0);
        expect(listeners.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('cleans up when subscription synchronously changes or aborts', async () => {
        for (const outcome of ['change', 'abort'] as const) {
            const controller = new AbortController();
            let subscribed = false;
            const watches = createParkWatch();
            const result = await watches.parkWatch({
                isNewer: () => false,
                read: () => 2,
                subscribe(listener) {
                    subscribed = true;
                    if (outcome === 'change') listener();
                    else controller.abort();
                    return () => { subscribed = false; };
                },
                signal: controller.signal,
            });
            expect(result).toEqual(outcome === 'change' ? { changed: true, snapshot: 2 } : { changed: false });
            expect(subscribed).toBe(false);
            expect(watches.watcherCount()).toBe(0);
        }
    });
});
