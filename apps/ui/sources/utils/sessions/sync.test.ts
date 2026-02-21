import { describe, expect, it, vi } from 'vitest';

import { InvalidateSync } from './sync';

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

describe('InvalidateSync.awaitQueue', () => {
    it('resolves after timeout when the queue never completes', async () => {
        vi.useFakeTimers();
        try {
            const sync = new InvalidateSync(async () => await new Promise<void>(() => {}));
            sync.invalidate();

            let resolved = false;
            const promise = sync.awaitQueue({ timeoutMs: 1000 }).then(() => {
                resolved = true;
            });

            await vi.advanceTimersByTimeAsync(999);
            expect(resolved).toBe(false);

            await vi.advanceTimersByTimeAsync(1);
            expect(resolved).toBe(true);

            await promise;
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('InvalidateSync.invalidateCoalesced', () => {
    it('does not schedule a second run when invalidated while a run is in flight', async () => {
        const started = createDeferred<void>();

        const command = vi.fn(async () => {
            await started.promise;
        });

        const sync = new InvalidateSync(command);
        sync.invalidate();
        sync.invalidateCoalesced();

        expect(command).toHaveBeenCalledTimes(1);

        started.resolve(undefined);
        await sync.awaitQueue({ timeoutMs: 2000 });

        expect(command).toHaveBeenCalledTimes(1);
    });

    it('preserves double-run behavior for regular invalidate()', async () => {
        const started = createDeferred<void>();

        const command = vi.fn(async () => {
            await started.promise;
        });

        const sync = new InvalidateSync(command);
        sync.invalidate();
        sync.invalidate();

        expect(command).toHaveBeenCalledTimes(1);

        started.resolve(undefined);
        await sync.awaitQueue({ timeoutMs: 2000 });

        expect(command).toHaveBeenCalledTimes(2);
    });
});
