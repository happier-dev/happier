import { describe, expect, it, vi } from 'vitest';

import { InvalidateSync } from './sync';
import { PauseController } from '@/utils/timing/pauseController';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { SupersededOperationError } from '@/utils/timing/time';

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
    it('cancels only the superseded waiter while the same sync cycle keeps converging', async () => {
        const command = createDeferred<void>();
        const sync = new InvalidateSync(() => command.promise);
        const controller = new AbortController();
        let cancellation: unknown;
        const waiting = sync.invalidateAndAwait({ signal: controller.signal }).catch((error: unknown) => { cancellation = error; });
        try {
            controller.abort();
            await vi.waitFor(() => expect(cancellation).toBeInstanceOf(SupersededOperationError));

            let completed = false;
            const queue = sync.awaitQueue().then(() => { completed = true; });
            await Promise.resolve();
            expect(completed).toBe(false);
            command.resolve(undefined);
            await queue;
            expect(completed).toBe(true);
        } finally {
            command.resolve(undefined);
            await waiting;
        }
    });

    it.each(['success', 'old failure', 'fresh failure'] as const)('bounded refresh observes the next cycle outcome after %s', async (scenario) => {
        const firstRun = createDeferred<void>();
        const freshRun = createDeferred<void>();
        let runs = 0;
        const sync = new InvalidateSync(async () => {
            runs += 1;
            await (runs === 1 ? firstRun.promise : freshRun.promise);
        });
        const error = Object.assign(new Error('terminal'), { retryable: false });
        sync.invalidate();
        let settled = false;
        const refresh = sync.invalidateAndAwait({ timeoutMs: 2000 }).finally(() => { settled = true; });
        const result = scenario === 'fresh failure'
            ? expect(refresh).rejects.toBe(error)
            : expect(refresh).resolves.toEqual({ status: 'completed' });
        if (scenario === 'old failure') firstRun.reject(error);
        else firstRun.resolve(undefined);
        await vi.waitFor(() => expect(runs).toBe(2));
        expect(settled).toBe(false);
        if (scenario === 'fresh failure') freshRun.reject(error);
        else freshRun.resolve(undefined);
        await result;
    });

    it('retires a bounded next-cycle waiter on expiry before either cycle finishes', async () => {
        await withFakeTimers(async () => {
            const firstRun = createDeferred<void>();
            const error = Object.assign(new Error('late terminal failure'), { retryable: false });
            let runs = 0;
            const sync = new InvalidateSync(async () => {
                runs += 1;
                if (runs === 1) await firstRun.promise;
                else throw error;
            });
            sync.invalidate();
            const refresh = sync.invalidateAndAwait({ timeoutMs: 1000 });
            await vi.advanceTimersByTimeAsync(1000);
            await expect(refresh).resolves.toEqual({ status: 'wait_budget_expired' });
            firstRun.resolve(undefined);
            await expect(sync.awaitQueue()).resolves.toEqual({ status: 'completed' });
            expect(runs).toBe(2);
        });
    });

    it('reports a stop while waiting for a fresh cycle', async () => {
        const firstRun = createDeferred<void>();
        const sync = new InvalidateSync(async () => await firstRun.promise);
        sync.invalidate();
        const refresh = sync.invalidateAndAwait({ timeoutMs: 2000 });
        sync.stop();
        firstRun.resolve(undefined);
        await expect(refresh).resolves.toEqual({ status: 'stopped' });
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
