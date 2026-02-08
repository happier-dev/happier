import { describe, it, expect } from 'vitest';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { waitForMessagesOrPending } from './waitForMessagesOrPending';

describe('waitForMessagesOrPending', () => {
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
});
