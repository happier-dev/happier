import { afterEach, describe, it, expect, vi } from 'vitest';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { configuration } from '@/configuration';
import { waitForMessagesOrPending } from './waitForMessagesOrPending';

describe('waitForMessagesOrPending', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns immediately when a queue message exists', async () => {
        type Mode = { id: string };
        const mode: Mode = { id: 'm1' };

        const queue = new MessageQueue2<Mode>(() => 'hash');
        queue.pushImmediate('hello', mode);

        const result = await waitForMessagesOrPending({
            messageQueue: queue,
            abortSignal: new AbortController().signal,
            popPendingMessage: async () => false,
            waitForMetadataUpdate: async () => false,
        });

        expect(result?.message).toBe('hello');
    });

    it('wakes on metadata update and then processes a pending item', async () => {
        type Mode = { id: string };
        const mode: Mode = { id: 'm1' };

        const queue = new MessageQueue2<Mode>(() => 'hash');

        let pendingText: string | null = null;
        const popPendingMessage = async () => {
            if (!pendingText) return false;
            const text = pendingText;
            pendingText = null;
            queue.pushImmediate(text, mode);
            return true;
        };

        const metadataWaiters: Array<(ok: boolean) => void> = [];
        let resolveMetadataRegistered: (() => void) | null = null;
        const metadataRegistered = new Promise<void>((resolve) => {
            resolveMetadataRegistered = resolve;
        });
        const waitForMetadataUpdate = async (abortSignal?: AbortSignal) => {
            if (abortSignal?.aborted) return false;
            return await new Promise<boolean>((resolve) => {
                const onAbort = () => resolve(false);
                abortSignal?.addEventListener('abort', onAbort, { once: true });
                metadataWaiters.push((ok) => {
                    abortSignal?.removeEventListener('abort', onAbort);
                    resolve(ok);
                });
                resolveMetadataRegistered?.();
            });
        };

        const abortController = new AbortController();
        let metadataCallbackCount = 0;
        const promise = waitForMessagesOrPending({
            messageQueue: queue,
            abortSignal: abortController.signal,
            popPendingMessage,
            waitForMetadataUpdate,
            onMetadataUpdate: () => {
                metadataCallbackCount++;
            },
        });

        await metadataRegistered;
        expect(metadataWaiters.length).toBeGreaterThan(0);

        pendingText = 'from-pending';
        // Wake the waiter as if metadata changed due to a new pending enqueue.
        metadataWaiters.shift()?.(true);

        const result = await promise;
        expect(result?.message).toBe('from-pending');
        expect(metadataCallbackCount).toBe(1);
    });

    it('does not exit when metadata update waiting fails (e.g., user socket disconnect)', async () => {
        type Mode = { id: string };
        const mode: Mode = { id: 'm1' };
        const queue = new MessageQueue2<Mode>(() => 'hash');

        let callCount = 0;
        const waitForMetadataUpdate = async (abortSignal?: AbortSignal) => {
            callCount++;
            if (callCount === 1) {
                // Simulate a disconnect-like false result for the first wait.
                return false;
            }
            if (abortSignal?.aborted) return false;
            return await new Promise<boolean>((resolve) => {
                abortSignal?.addEventListener('abort', () => resolve(false), { once: true });
            });
        };

        const abortController = new AbortController();
        const promise = waitForMessagesOrPending({
            messageQueue: queue,
            abortSignal: abortController.signal,
            popPendingMessage: async () => false,
            waitForMetadataUpdate,
        });

        queueMicrotask(() => queue.pushImmediate('after-disconnect', mode));

        const result = await Promise.race([
            promise,
            new Promise<null>((_, reject) => setTimeout(() => reject(new Error('waitForMessagesOrPending hung')), 250)),
        ]);

        expect(result?.message).toBe('after-disconnect');
    });

    it('does not tight-loop when metadata waiting returns false immediately', async () => {
        type Mode = { id: string };
        const mode: Mode = { id: 'm1' };
        const queue = new MessageQueue2<Mode>(() => 'hash');

        let metadataCallCount = 0;
        const waitForMetadataUpdate = async () => {
            metadataCallCount++;
            return false;
        };

        let popPendingCallCount = 0;
        const popPendingMessage = async () => {
            popPendingCallCount++;
            if (popPendingCallCount > 20) {
                throw new Error('tight loop: popPendingMessage called too often');
            }
            return false;
        };

        const abortController = new AbortController();
        const promise = waitForMessagesOrPending({
            messageQueue: queue,
            abortSignal: abortController.signal,
            popPendingMessage,
            waitForMetadataUpdate,
        });

        queueMicrotask(() => queue.pushImmediate('after-disconnect', mode));
        const result = await Promise.race([
            promise,
            new Promise<null>((_, reject) => setTimeout(() => reject(new Error('waitForMessagesOrPending hung')), 250)),
        ]);

        expect(metadataCallCount).toBeLessThan(5);
        expect(popPendingCallCount).toBeLessThan(5);
        expect(result?.message).toBe('after-disconnect');
    });

    it('reconciles metadata on idle wake when a metadata event was missed', async () => {
        vi.useFakeTimers();

        type Mode = { id: string };
        const mode: Mode = { id: 'm1' };
        const queue = new MessageQueue2<Mode>(() => 'hash');
        const originalIdleWakePollIntervalMs = configuration.pendingQueueIdleWakePollIntervalMs;
        (configuration as any).pendingQueueIdleWakePollIntervalMs = 10;

        let metadataDirty = false;
        let applyQueuedMetadata = false;

        try {
            const popPendingMessage = async () => {
                if (!applyQueuedMetadata) return false;
                applyQueuedMetadata = false;
                queue.pushImmediate('from-metadata-reconcile', mode);
                return true;
            };

            const waitForMetadataUpdate = async (abortSignal?: AbortSignal) => {
                if (abortSignal?.aborted) return false;
                return await new Promise<boolean>((resolve) => {
                    abortSignal?.addEventListener('abort', () => resolve(false), { once: true });
                });
            };

            const promise = waitForMessagesOrPending({
                messageQueue: queue,
                abortSignal: new AbortController().signal,
                popPendingMessage,
                waitForMetadataUpdate,
                onMetadataUpdate: () => {
                    if (!metadataDirty) return;
                    metadataDirty = false;
                    applyQueuedMetadata = true;
                },
            });

            metadataDirty = true;

            const resultPromise = Promise.race([
                promise,
                new Promise<never>((_, reject) => {
                    setTimeout(() => reject(new Error('waitForMessagesOrPending hung')), 100);
                }),
            ]);

            await vi.advanceTimersByTimeAsync(120);

            await expect(resultPromise).resolves.toMatchObject({ message: 'from-metadata-reconcile' });
        } finally {
            (configuration as any).pendingQueueIdleWakePollIntervalMs = originalIdleWakePollIntervalMs;
        }
    });

    it('reconciles metadata on idle wake even when metadata waiting drops out immediately', async () => {
        vi.useFakeTimers();

        type Mode = { id: string };
        const mode: Mode = { id: 'm1' };
        const queue = new MessageQueue2<Mode>(() => 'hash');
        const originalIdleWakePollIntervalMs = configuration.pendingQueueIdleWakePollIntervalMs;
        (configuration as any).pendingQueueIdleWakePollIntervalMs = 10;

        let metadataDirty = false;

        try {
            const promise = waitForMessagesOrPending({
                messageQueue: queue,
                abortSignal: new AbortController().signal,
                popPendingMessage: async () => false,
                waitForMetadataUpdate: async () => false,
                onMetadataUpdate: () => {
                    if (!metadataDirty) return;
                    metadataDirty = false;
                    queue.pushImmediate('from-immediate-false-metadata-reconcile', mode);
                },
            });

            metadataDirty = true;

            const resultPromise = Promise.race([
                promise,
                new Promise<never>((_, reject) => {
                    setTimeout(() => reject(new Error('waitForMessagesOrPending hung')), 100);
                }),
            ]);

            await vi.advanceTimersByTimeAsync(120);

            await expect(resultPromise).resolves.toMatchObject({ message: 'from-immediate-false-metadata-reconcile' });
        } finally {
            (configuration as any).pendingQueueIdleWakePollIntervalMs = originalIdleWakePollIntervalMs;
        }
    });

    it('does not leak abort listeners when idle fallback timer resolves normally', async () => {
        vi.useFakeTimers();

        type Mode = { id: string };
        const mode: Mode = { id: 'm1' };
        const queue = new MessageQueue2<Mode>(() => 'hash');

        const originalIdleWakePollIntervalMs = configuration.pendingQueueIdleWakePollIntervalMs;
        (configuration as any).pendingQueueIdleWakePollIntervalMs = 10;

        const abortController = new AbortController();
        let addCount = 0;
        let removeCount = 0;
        const instrumentedSignal = {
            get aborted() {
                return abortController.signal.aborted;
            },
            addEventListener: (...args: any[]) => {
                addCount += 1;
                return (abortController.signal as any).addEventListener(...args);
            },
            removeEventListener: (...args: any[]) => {
                removeCount += 1;
                return (abortController.signal as any).removeEventListener(...args);
            },
        } as any as AbortSignal;

        try {
            const promise = waitForMessagesOrPending({
                messageQueue: queue,
                abortSignal: instrumentedSignal,
                popPendingMessage: async () => false,
                waitForMetadataUpdate: async () => false,
                onMetadataUpdate: () => {
                    queue.pushImmediate('idle-wake', mode);
                },
            });

            await vi.advanceTimersByTimeAsync(50);

            await expect(promise).resolves.toMatchObject({ message: 'idle-wake' });
            expect(removeCount).toBe(addCount);
        } finally {
            (configuration as any).pendingQueueIdleWakePollIntervalMs = originalIdleWakePollIntervalMs;
        }
    });

    it('does not hang when abort races with listener registration', async () => {
        type Mode = { id: string };
        const mode: Mode = { id: 'm1' };
        const queue = new MessageQueue2<Mode>(() => 'hash');

        let aborted = false;
        const abortSignal = {
            get aborted() {
                return aborted;
            },
            addEventListener: () => {
                aborted = true;
            },
            removeEventListener: () => { },
        } as any as AbortSignal;

        const waitForMetadataUpdate = async (signal?: AbortSignal) => {
            if (signal?.aborted) return false;
            return await new Promise<boolean>((resolve) => {
                signal?.addEventListener('abort', () => resolve(false), { once: true } as any);
            });
        };

        const p = waitForMessagesOrPending({
            messageQueue: queue,
            abortSignal,
            popPendingMessage: async () => false,
            waitForMetadataUpdate,
        });

        await expect(
            Promise.race([
                p,
                new Promise((_, reject) => setTimeout(() => reject(new Error('waitForMessagesOrPending hung')), 50)),
            ]),
        ).resolves.toBeNull();
    });

    it('does not drop a queue message when metadata update wins the race', async () => {
        type Mode = { id: string };
        const mode: Mode = { id: 'm1' };
        const queue = new MessageQueue2<Mode>(() => 'hash');

        const metadataWaiters: Array<(ok: boolean) => void> = [];
        let resolveMetadataRegistered: (() => void) | null = null;
        const metadataRegistered = new Promise<void>((resolve) => {
            resolveMetadataRegistered = resolve;
        });
        const waitForMetadataUpdate = async (abortSignal?: AbortSignal) => {
            if (abortSignal?.aborted) return false;
            return await new Promise<boolean>((resolve) => {
                const onAbort = () => resolve(false);
                abortSignal?.addEventListener('abort', onAbort, { once: true });
                metadataWaiters.push((ok) => {
                    abortSignal?.removeEventListener('abort', onAbort);
                    resolve(ok);
                });
                resolveMetadataRegistered?.();
            });
        };

        const abortController = new AbortController();
        const p = waitForMessagesOrPending({
            messageQueue: queue,
            abortSignal: abortController.signal,
            popPendingMessage: async () => false,
            waitForMetadataUpdate,
        });

        await metadataRegistered;
        expect(metadataWaiters.length).toBeGreaterThan(0);

        // Resolve metadata first, then enqueue a message synchronously.
        //
        // This reproduces a subtle microtask ordering hazard:
        // - metadata promise resolution schedules the Promise.race continuation
        // - queue push resolves the message waiter and schedules the batch collector microtask
        // - the batch collector can run before the abort (which happens after the race continuation),
        //   draining the queue even though the race winner was "meta".
        metadataWaiters.shift()?.(true);
        queue.pushImmediate('race-message', mode);

        const result = await Promise.race([
            p,
            new Promise<null>((_, reject) => setTimeout(() => reject(new Error('waitForMessagesOrPending hung')), 100)),
        ]);

        expect(result?.message).toBe('race-message');
    });

    it('retries pending materialization while idle even without metadata updates', async () => {
        type Mode = { id: string };
        const mode: Mode = { id: 'm1' };
        const queue = new MessageQueue2<Mode>(() => 'hash');

        let popCount = 0;
        const popPendingMessage = async () => {
            popCount += 1;
            if (popCount < 2) return false;
            queue.pushImmediate('late-pending', mode);
            return true;
        };

        const waitForMetadataUpdate = async (abortSignal?: AbortSignal) => {
            if (abortSignal?.aborted) return false;
            return await new Promise<boolean>((resolve) => {
                abortSignal?.addEventListener('abort', () => resolve(false), { once: true });
            });
        };

        const abortController = new AbortController();
        const promise = waitForMessagesOrPending({
            messageQueue: queue,
            abortSignal: abortController.signal,
            popPendingMessage,
            waitForMetadataUpdate,
        });

        const result = await Promise.race([
            promise,
            new Promise<null>((_, reject) => setTimeout(() => reject(new Error('waitForMessagesOrPending hung')), 1_500)),
        ]);

        expect(result?.message).toBe('late-pending');
    });
});
