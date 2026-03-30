import { describe, expect, it } from 'vitest';
import { runTasksWithLimit } from '@/sync/runtime/orchestration/runTasksWithLimit';

describe('runTasksWithLimit', () => {
    it('runs tasks with a concurrency limit and preserves result ordering', async () => {
        let current = 0;
        let maxSeen = 0;
        let started = 0;
        let resolveStarted: (() => void) | null = null;
        const startedPromise = new Promise<void>((resolve) => {
            resolveStarted = resolve;
        });
        const blockers = Array.from({ length: 5 }, () => {
            let resolve: (() => void) | null = null;
            const promise = new Promise<void>((innerResolve) => {
                resolve = innerResolve;
            });
            return {
                promise,
                resolve: () => resolve?.(),
            };
        });

        const tasks = Array.from({ length: 5 }, (_, index) => async () => {
            current += 1;
            maxSeen = Math.max(maxSeen, current);
            started += 1;
            if (started === 2) {
                resolveStarted?.();
            }
            await blockers[index].promise;
            current -= 1;
            return index;
        });

        const runPromise = runTasksWithLimit(tasks, 2);

        await startedPromise;

        expect(maxSeen).toBe(2);

        for (const blocker of blockers) {
            blocker.resolve();
        }

        await expect(runPromise).resolves.toEqual([0, 1, 2, 3, 4]);
    });
});
