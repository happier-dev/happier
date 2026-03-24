import { describe, expect, it, vi } from 'vitest';

import { ScmDiffCache } from './scmDiffCache';
import { ScmDiffPrefetchScheduler, type ScmDiffPrefetchFetchFn } from './scmDiffPrefetchScheduler';

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe('ScmDiffPrefetchScheduler', () => {
    it('skips paths already present in the diff cache', async () => {
        const cache = new ScmDiffCache({ maxEntries: 10, maxTotalBytes: 1_000_000, now: () => 0 });
        cache.set({ sessionId: 's', snapshotSignature: 'sig', diffArea: 'pending', path: 'a.ts' }, 'diff');

        const fetchDiff = vi.fn(async (_input: Parameters<ScmDiffPrefetchFetchFn>[0]) => ({ success: true as const, diff: 'x' }));
        const scheduler = new ScmDiffPrefetchScheduler({ cache, fetchDiff, now: () => 0, maxConcurrency: 2 });

        scheduler.prefetch({
            sessionId: 's',
            snapshotSignature: 'sig',
            diffArea: 'pending',
            paths: ['a.ts', 'b.ts'],
        });

        expect(fetchDiff).toHaveBeenCalledTimes(1);
        expect(fetchDiff.mock.calls[0]?.[0]).toEqual({ sessionId: 's', diffArea: 'pending', path: 'b.ts' });
    });

    it('enforces concurrency and pumps the queue as requests resolve', async () => {
        const cache = new ScmDiffCache({ maxEntries: 100, maxTotalBytes: 1_000_000, now: () => 0 });

        const reachedB = createDeferred<void>();
        const reachedC = createDeferred<void>();
        const cachedC = createDeferred<void>();
        const deferredA = createDeferred<Readonly<{ success: true; diff: string }>>();
        const deferredB = createDeferred<Readonly<{ success: true; diff: string }>>();
        const deferredC = createDeferred<Readonly<{ success: true; diff: string }>>();
        const originalSet = cache.set.bind(cache);
        vi.spyOn(cache, 'set').mockImplementation((key, diff) => {
            originalSet(key, diff);
            if (key.path === 'c.ts') {
                cachedC.resolve();
            }
        });
        const fetchDiff = vi.fn(async (input: Parameters<ScmDiffPrefetchFetchFn>[0]) => {
            if (input.path === 'a.ts') return deferredA.promise;
            if (input.path === 'b.ts') {
                reachedB.resolve();
                return deferredB.promise;
            }
            reachedC.resolve();
            return deferredC.promise;
        });

        const scheduler = new ScmDiffPrefetchScheduler({ cache, fetchDiff, now: () => 0, maxConcurrency: 1 });
        scheduler.prefetch({
            sessionId: 's',
            snapshotSignature: 'sig',
            diffArea: 'pending',
            paths: ['a.ts', 'b.ts', 'c.ts'],
        });

        expect(fetchDiff).toHaveBeenCalledTimes(1);
        expect(fetchDiff.mock.calls[0]?.[0]?.path).toBe('a.ts');

        deferredA.resolve({ success: true, diff: 'diff-a' });
        await reachedB.promise;
        expect(fetchDiff).toHaveBeenCalledTimes(2);
        expect(fetchDiff.mock.calls[1]?.[0]?.path).toBe('b.ts');

        deferredB.resolve({ success: true, diff: 'diff-b' });
        await reachedC.promise;
        expect(fetchDiff).toHaveBeenCalledTimes(3);
        expect(fetchDiff.mock.calls[2]?.[0]?.path).toBe('c.ts');

        deferredC.resolve({ success: true, diff: 'diff-c' });
        await cachedC.promise;
        expect(cache.get({ sessionId: 's', snapshotSignature: 'sig', diffArea: 'pending', path: 'c.ts' })?.diff).toBe('diff-c');
    });
});
