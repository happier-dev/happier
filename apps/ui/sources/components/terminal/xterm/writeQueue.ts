import type { EmbeddedTerminalWriteOptions } from '../embedded/embeddedTerminalRendererHandle';

export type XtermWritePayload = string | Uint8Array;

export type XtermQueuedWrite = Readonly<{
    data: XtermWritePayload;
    byteLength: number;
    onComplete?: () => void;
    options?: EmbeddedTerminalWriteOptions;
}>;

export type XtermRejectedWrite = Readonly<{
    byteLength: number;
    pendingBytes: number;
    maxPendingBytes: number;
}>;

export type XtermWriteQueue = Readonly<{
    enqueue: (chunk: XtermQueuedWrite) => boolean;
    flush: () => void;
    clear: () => void;
}>;

export type CreateXtermWriteQueueParams = Readonly<{
    canWrite?: () => boolean;
    write: (data: XtermWritePayload, callback: () => void, options?: EmbeddedTerminalWriteOptions) => void;
    schedule: (flush: () => void) => void;
    maxPendingBytes: number;
    onReject?: (event: XtermRejectedWrite) => void;
}>;

export const DEFAULT_XTERM_MAX_PENDING_WRITE_BYTES = 4 * 1024 * 1024;

export function createXtermWriteQueue(params: CreateXtermWriteQueueParams): XtermWriteQueue {
    let pending: XtermQueuedWrite[] = [];
    let pendingBytes = 0;
    let isWriting = false;
    let epoch = 0;

    const flush = () => {
        if (isWriting) return;
        if (params.canWrite && !params.canWrite()) return;
        const next = pending.shift();
        if (!next) return;

        pendingBytes = Math.max(0, pendingBytes - next.byteLength);
        isWriting = true;
        const writeEpoch = epoch;
        const complete = () => {
            if (writeEpoch !== epoch) return;
            isWriting = false;
            next.onComplete?.();
            if (pending.length > 0) {
                flush();
            }
        };
        let submitting = true;
        params.write(next.data, () => {
            // xterm parses the first echo after user input synchronously. Let the
            // caller install its queued receipt before delivering its completion.
            if (submitting) queueMicrotask(complete);
            else complete();
        }, next.options);
        submitting = false;
    };

    return {
        enqueue: (chunk) => {
            if (chunk.byteLength <= 0) return true;
            if (pendingBytes + chunk.byteLength > params.maxPendingBytes) {
                params.onReject?.({
                    byteLength: chunk.byteLength,
                    pendingBytes,
                    maxPendingBytes: params.maxPendingBytes,
                });
                return false;
            }

            pending.push(chunk);
            pendingBytes += chunk.byteLength;
            params.schedule(flush);
            return true;
        },
        flush,
        clear: () => {
            pending = [];
            pendingBytes = 0;
            isWriting = false;
            epoch += 1;
        },
    };
}
