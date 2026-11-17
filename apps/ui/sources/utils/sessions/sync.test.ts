import { describe, expect, it, vi } from 'vitest';

import { InvalidateSync } from './sync';
import { PauseController } from '@/utils/timing/pauseController';
import { RetryableServerResponseError } from '@/sync/runtime/connectivity/transientConnectivityErrors';

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
            const promise = sync.awaitQueue({ timeoutMs: 1000 }).then((outcome) => {
                resolved = true;
                return outcome;
            });

            await vi.advanceTimersByTimeAsync(999);
            expect(resolved).toBe(false);

            await vi.runOnlyPendingTimersAsync();
            expect(resolved).toBe(true);

            await expect(promise).resolves.toEqual({ status: 'wait_budget_expired' });
        });
    });
});

describe('InvalidateSync.invalidateAndAwait', () => {
    it.each(['cycle', 'first-attempt', 'queue'] as const)('cancels only the retired %s waiter while its cycle keeps converging', async mode => {
        const command = createDeferred<void>();
        const sync = new InvalidateSync(() => command.promise);
        const controller = new AbortController();
        let cancellation: unknown;
        const pending = mode === 'queue'
            ? sync.invalidateAndAwait({ timeoutMs: 1000, signal: controller.signal })
            : sync.invalidateAndAwait({ settleOnFirstAttempt: mode === 'first-attempt', signal: controller.signal });
        const wait = pending.catch((error: unknown) => { cancellation = error; });
        try {
            controller.abort();
            await vi.waitFor(() => expect(cancellation).toMatchObject({ name: 'SupersededOperationError' }));
            let completed = false;
            const queue = sync.awaitQueue().then(() => { completed = true; });
            await Promise.resolve();
            expect(completed).toBe(false);
            command.resolve();
            await queue;
            expect(completed).toBe(true);
        } finally {
            command.resolve();
            await wait;
        }
    });

    it('bounds a fresh cycle without treating an older in-flight read as completion', async () => {
        await withFakeTimers(async () => {
            const oldRead = createDeferred<void>();
            const freshRead = createDeferred<void>();
            let reads = 0;
            const sync = new InvalidateSync(async () => { await (++reads === 1 ? oldRead.promise : freshRead.promise); });
            sync.invalidate();
            let settled = false;
            const wait = sync.invalidateAndAwait({ timeoutMs: 100 }).then(outcome => { settled = true; return outcome; });
            oldRead.resolve();
            await vi.advanceTimersByTimeAsync(0);
            expect(reads).toBe(2);
            expect(settled).toBe(false);
            freshRead.resolve();
            await expect(wait).resolves.toEqual({ status: 'completed' });
        });
    });

    it('reports expiration and stop rather than successful materialization', async () => {
        await withFakeTimers(async () => {
            const sync = new InvalidateSync(async () => await new Promise<void>(() => {}));
            const expired = sync.invalidateAndAwait({ timeoutMs: 100 });
            await vi.advanceTimersByTimeAsync(100);
            await expect(expired).resolves.toEqual({ status: 'wait_budget_expired' });
            const stopped = sync.invalidateAndAwait({ timeoutMs: 100 });
            sync.stop();
            await expect(stopped).resolves.toEqual({ status: 'stopped' });
            await expect(sync.invalidateAndAwait({ timeoutMs: 100 })).resolves.toEqual({ status: 'stopped' });
            expect(vi.getTimerCount()).toBe(0);
        });
    });

    it('rejects a bounded fresh cycle after terminal failure', async () => {
        const error = Object.assign(new Error('materialization failed'), { retryable: false });
        const sync = new InvalidateSync(async () => { throw error; });
        await expect(sync.invalidateAndAwait({ timeoutMs: 100 })).rejects.toBe(error);
    });

    it('can settle the first attempt while the same queue continues retrying', async () => {
        await withFakeTimers(async () => {
            const error = new RetryableServerResponseError(503, 'temporarily unavailable');
            const command = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
            const onRetryFailure = vi.fn();
            const sync = new InvalidateSync(command, {
                onRetryFailure,
                backoff: { minDelayMs: 1000, maxDelayMs: 1000, maxFailureCount: 'infinite' },
            });
            let firstError: unknown;
            const firstAttempt = sync.invalidateAndAwait({ settleOnFirstAttempt: true }).catch(e => { firstError = e; });
            await vi.advanceTimersByTimeAsync(0);
            expect(firstError).toBe(error);
            expect(onRetryFailure).toHaveBeenCalled();
            expect(command).toHaveBeenCalledTimes(1);
            let drained = false;
            const queue = sync.awaitQueue().then(() => { drained = true; });
            expect(drained).toBe(false);
            await vi.advanceTimersByTimeAsync(1000);
            await firstAttempt;
            await queue;
            expect(command).toHaveBeenCalledTimes(2);
            expect(drained).toBe(true);
        });
    });

    it('retries a transient Home response on its default policy', async () => {
        const command = vi.fn()
            .mockRejectedValueOnce(new RetryableServerResponseError(503, 'temporarily unavailable'))
            .mockResolvedValueOnce(undefined);
        const sync = new InvalidateSync(command, { backoff: { minDelayMs: 0, maxDelayMs: 0, maxFailureCount: 2 } });
        await expect(sync.invalidateAndAwait()).resolves.toBeUndefined();
        expect(command).toHaveBeenCalledTimes(2);
    });
    it('rejects when its refresh cycle ends in a terminal error', async () => {
        const error = Object.assign(new Error('not retryable'), { retryable: false });
        const sync = new InvalidateSync(async () => {
            throw error;
        });

        await expect(sync.invalidateAndAwait()).rejects.toBe(error);
    });

    it('resolves after its own refresh cycle when another invalidation is queued', async () => {
        const firstRun = createDeferred<void>();
        const secondRun = createDeferred<void>();
        let runCount = 0;
        const command = vi.fn(async () => {
            runCount += 1;
            if (runCount === 1) {
                await firstRun.promise;
                return;
            }
            await secondRun.promise;
        });

        const sync = new InvalidateSync(command);
        let firstResolved = false;
        let secondResolved = false;
        const firstAwait = sync.invalidateAndAwait().then(() => {
            firstResolved = true;
        });

        await vi.waitFor(() => {
            expect(command).toHaveBeenCalledTimes(1);
        });

        const secondAwait = sync.invalidateAndAwait().then(() => {
            secondResolved = true;
        });

        firstRun.resolve(undefined);
        await vi.waitFor(() => {
            expect(command).toHaveBeenCalledTimes(2);
        });

        expect(firstResolved).toBe(true);
        expect(secondResolved).toBe(false);

        secondRun.resolve(undefined);
        await secondAwait;
        await firstAwait;
        expect(secondResolved).toBe(true);
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

describe('InvalidateSync user-initiated retry', () => {
    it('starts a user retry at once while the queue waits out a backoff, and runs it once', async () => {
        await withFakeTimers(async () => {
            const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
            try {
                let failing = true;
                const command = vi.fn(async () => {
                    if (failing) throw new RetryableServerResponseError(503, 'temporarily unavailable');
                });
                const sync = new InvalidateSync(command, { backoff: { minDelayMs: 30_000, maxDelayMs: 30_000, maxFailureCount: 'infinite' } });
                sync.invalidate();
                await vi.advanceTimersByTimeAsync(0);
                expect(command).toHaveBeenCalledTimes(1);

                // The Home is back; the user pulls to refresh while the queue sleeps out its 30 s backoff.
                failing = false;
                let settled = false;
                const retry = sync.retryNow().then(() => { settled = true; });
                await vi.advanceTimersByTimeAsync(0);
                expect(command).toHaveBeenCalledTimes(2);
                expect(settled).toBe(true);

                // The retry was the cycle the user asked for: no second read follows it.
                await vi.advanceTimersByTimeAsync(60_000);
                await retry;
                expect(command).toHaveBeenCalledTimes(2);
            } finally {
                randomSpy.mockRestore();
            }
        });
    });

    it('cuts only a running backoff: an idle queue reads nothing, an automatic invalidation keeps its backoff', async () => {
        await withFakeTimers(async () => {
            const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
            try {
                const idle = vi.fn(async () => {});
                const idleSync = new InvalidateSync(idle);
                expect(idleSync.cutBackoff()).toBe(false);
                await vi.advanceTimersByTimeAsync(0);
                expect(idle).not.toHaveBeenCalled();

                const command = vi.fn(async () => { throw new RetryableServerResponseError(503, 'temporarily unavailable'); });
                const sync = new InvalidateSync(command, { backoff: { minDelayMs: 30_000, maxDelayMs: 30_000, maxFailureCount: 'infinite' } });
                sync.invalidate();
                await vi.advanceTimersByTimeAsync(0);
                sync.invalidate();
                await vi.advanceTimersByTimeAsync(10_000);
                expect(command).toHaveBeenCalledTimes(1);
                expect(sync.cutBackoff()).toBe(true);
                await vi.advanceTimersByTimeAsync(0);
                expect(command).toHaveBeenCalledTimes(2);
                sync.stop();
            } finally {
                randomSpy.mockRestore();
            }
        });
    });
});

describe('InvalidateSync retry failure reporting', () => {
    it('reports retryable failures before sleeping for the next retry', async () => {
        await withFakeTimers(async () => {
            const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
            try {
                const error = new Error('temporary outage');
                const command = vi.fn(async () => {
                    throw error;
                });
                const onRetryFailure = vi.fn();
                const sync = new InvalidateSync(command, {
                    onRetryFailure,
                    backoff: { minDelayMs: 1000, maxDelayMs: 1000, maxFailureCount: 'infinite' },
                });

                sync.invalidate();
                await vi.runAllTicks();

                expect(onRetryFailure).toHaveBeenCalledWith(error, {
                    failuresCount: 1,
                    nextDelayMs: 1000,
                    nextRetryAt: expect.any(Number),
                });

                sync.stop();
            } finally {
                randomSpy.mockRestore();
            }
        });
    });
});
