import { describe, expect, it, vi } from 'vitest';

import { InvalidateSync } from './sync';
import { PauseController } from '@/utils/timing/pauseController';

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

async function withFakeTimers(run: () => Promise<void>) {
    vi.useFakeTimers();
    try {
        await run();
    } finally {
        vi.useRealTimers();
    }
}

describe('InvalidateSync.awaitQueue', () => {
    it('resolves after timeout when the queue never completes', async () => {
        await withFakeTimers(async () => {
            const sync = new InvalidateSync(async () => await new Promise<void>(() => {}));
            sync.invalidate();

            let resolved = false;
            const promise = sync.awaitQueue({ timeoutMs: 1000 }).then(() => {
                resolved = true;
            });

            await vi.advanceTimersByTimeAsync(999);
            expect(resolved).toBe(false);

            await vi.runOnlyPendingTimersAsync();
            expect(resolved).toBe(true);

            await promise;
        });
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

describe('InvalidateSync pause behavior', () => {
    it('does not run while paused and runs after resume', async () => {
        const pause = new PauseController();
        pause.pause();
        const command = vi.fn(async () => {});
        const sync = new InvalidateSync(command, { pause, backoff: { minDelayMs: 1, maxDelayMs: 1, maxFailureCount: 'infinite' } });

        sync.invalidate();
        await new Promise<void>((resolve) => {
            queueMicrotask(resolve);
        });
        expect(command).toHaveBeenCalledTimes(0);

        pause.resume();
        await sync.awaitQueue({ timeoutMs: 2000 });
        expect(command).toHaveBeenCalledTimes(1);
    });

    it('does not schedule retries while paused', async () => {
        await withFakeTimers(async () => {
            const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
            try {
                const pause = new PauseController();
                const command = vi.fn(async () => {
                    throw new Error('nope');
                });
                const sync = new InvalidateSync(command, { pause, backoff: { minDelayMs: 1000, maxDelayMs: 1000, maxFailureCount: 'infinite' } });

                sync.invalidate();
                await vi.runAllTicks();
                expect(command).toHaveBeenCalledTimes(1);

                pause.pause();
                await vi.runOnlyPendingTimersAsync();
                await vi.runAllTicks();
                expect(command).toHaveBeenCalledTimes(1);

                pause.resume();
                await vi.runOnlyPendingTimersAsync();
                await vi.runAllTicks();
                expect(command).toHaveBeenCalledTimes(2);
            } finally {
                randomSpy.mockRestore();
            }
        });
    });
});
