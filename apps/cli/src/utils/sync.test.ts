import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { InvalidateSync } from './sync';
import { createBackoff } from './time';

describe('InvalidateSync', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('settles invalidateAndAwait when the real default retry budget is exhausted', async () => {
        const errors: unknown[] = [];
        const failure = new Error('boom');
        const sync = new InvalidateSync(async () => {
            throw failure;
        }, {
            onError: (e: unknown) => errors.push(e),
        });

        const pending = sync.invalidateAndAwait();
        await vi.runAllTimersAsync();
        await pending;
        expect(errors).toEqual(Array.from({ length: 8 }, () => failure));
    });

    it('runs again when invalidated during an in-flight sync', async () => {
        let releaseFirstRun!: () => void;
        const firstRunGate = new Promise<void>((resolve) => {
            releaseFirstRun = resolve;
        });
        const runs: number[] = [];

        const sync = new InvalidateSync(async () => {
            const run = runs.length + 1;
            runs.push(run);
            if (run === 1) {
                await firstRunGate;
            }
        });

        const first = sync.invalidateAndAwait();
        sync.invalidate(); // while run #1 is pending

        // Let run #1 finish, allowing queued run #2.
        releaseFirstRun();

        await first;
        expect(runs).toEqual([1, 2]);
    });

    it('reports increasing failuresCount with a configured real backoff', async () => {
        const failuresCounts: number[] = [];
        const errors: unknown[] = [];

        const sync = new InvalidateSync(async () => {
            throw new Error('boom');
        }, {
            backoff: createBackoff({ maxFailureCount: 3 }),
            onError: (e, failuresCount) => {
                errors.push(e);
                failuresCounts.push(failuresCount);
            },
        });

        const pending = sync.invalidateAndAwait();
        await vi.runAllTimersAsync();
        await pending;

        expect(errors).toHaveLength(3);
        expect(failuresCounts).toEqual([1, 2, 3]);
    });
});
