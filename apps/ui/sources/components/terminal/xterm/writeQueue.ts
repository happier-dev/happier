export type XtermWritePayload = string | Uint8Array;

export type XtermQueuedWrite = Readonly<{
    data: XtermWritePayload;
    byteLength: number;
    onComplete?: () => void;
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
    pendingBytes: () => number;
    pendingCount: () => number;
}>;

export type CreateXtermWriteQueueParams = Readonly<{
    canWrite?: () => boolean;
    write: (data: XtermWritePayload, callback: () => void) => void;
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

        params.write(next.data, () => {
            if (writeEpoch !== epoch) return;
            isWriting = false;
            next.onComplete?.();
            if (pending.length > 0) {
                params.schedule(flush);
            }
        });
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
        pendingBytes: () => pendingBytes,
        pendingCount: () => pending.length + (isWriting ? 1 : 0),
    };
}
