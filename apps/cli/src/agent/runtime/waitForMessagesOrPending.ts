import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';

export type MessageBatch<T> = {
    message: string;
    mode: T;
    isolate: boolean;
    hash: string;
};

export async function waitForMessagesOrPending<T>(opts: {
    messageQueue: MessageQueue2<T>;
    abortSignal: AbortSignal;
    popPendingMessage: () => Promise<boolean>;
    waitForMetadataUpdate: (abortSignal?: AbortSignal) => Promise<boolean>;
    onMetadataUpdate?: (() => void | Promise<void>) | null;
}): Promise<MessageBatch<T> | null> {
    while (true) {
        if (opts.abortSignal.aborted) {
            return null;
        }

        // Fast path
        if (opts.messageQueue.size() > 0) {
            return await opts.messageQueue.waitForMessagesAndGetAsString(opts.abortSignal);
        }

        // Give pending queue a chance to materialize a message before we park.
        await opts.popPendingMessage();

        // If queue is still empty, wait for either:
        // - a new transcript message (via normal update delivery), OR
        // - a metadata change (e.g. a new pending enqueue)
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        opts.abortSignal.addEventListener('abort', onAbort, { once: true });
        if (opts.abortSignal.aborted) {
            controller.abort();
        }

        try {
            const queueWait = opts.messageQueue
                .waitForMessagesSignal(controller.signal)
                .then((hasMessages) => ({ kind: 'queue' as const, hasMessages }));
            const metaWait = opts.waitForMetadataUpdate(controller.signal).then((ok) => ({ kind: 'meta' as const, ok }));

            const winner = await Promise.race([queueWait, metaWait]);

            // If metadata waiting ended (e.g. disconnect), fall back to waiting for a real message
            // without repeatedly re-arming the race (which can cause a tight loop).
            if (winner.kind === 'meta' && !winner.ok) {
                const queued = await queueWait;
                if (!queued.hasMessages) {
                    return null;
                }
                return await opts.messageQueue.waitForMessagesAndGetAsString(opts.abortSignal);
            }

            controller.abort('waitForMessagesOrPending');

            if (winner.kind === 'queue') {
                if (!winner.hasMessages) {
                    // Aborted/closed while waiting.
                    return null;
                }
                // Collect the batch now (non-racy): avoids the loser draining the queue.
                return await opts.messageQueue.waitForMessagesAndGetAsString(opts.abortSignal);
            }

            try {
                const cb = opts.onMetadataUpdate;
                if (cb) {
                    await cb();
                }
            } catch {
                // Non-fatal: metadata notifications should not break the message loop.
            }

            // Metadata updated – loop to try popPendingMessage again.
        } finally {
            opts.abortSignal.removeEventListener('abort', onAbort);
        }
    }
}
