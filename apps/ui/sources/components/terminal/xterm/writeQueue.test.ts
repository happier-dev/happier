import { describe, expect, it, vi } from 'vitest';

import { createXtermWriteQueue } from './writeQueue';

describe('createXtermWriteQueue', () => {
    it('serializes writes and invokes completions after parser callbacks', () => {
        const scheduled: Array<() => void> = [];
        const parserCallbacks: Array<() => void> = [];
        const onComplete = vi.fn();
        const queue = createXtermWriteQueue({
            write: (_data, callback) => parserCallbacks.push(callback),
            schedule: (flush) => scheduled.push(flush),
            maxPendingBytes: 1024,
        });

        expect(queue.enqueue({ data: 'one', byteLength: 3, onComplete })).toBe(true);
        expect(queue.enqueue({ data: 'two', byteLength: 3, onComplete })).toBe(true);
        expect(queue.pendingBytes()).toBe(6);
        expect(queue.pendingCount()).toBe(2);

        scheduled.shift()?.();
        expect(queue.pendingBytes()).toBe(3);
        expect(queue.pendingCount()).toBe(2);
        expect(onComplete).not.toHaveBeenCalled();

        parserCallbacks.shift()?.();
        expect(onComplete).toHaveBeenCalledTimes(1);
        scheduled.shift()?.();
        parserCallbacks.shift()?.();
        expect(onComplete).toHaveBeenCalledTimes(2);
        expect(queue.pendingBytes()).toBe(0);
        expect(queue.pendingCount()).toBe(0);
    });

    it('rejects writes that would exceed the pending-byte cap', () => {
        const onReject = vi.fn();
        const queue = createXtermWriteQueue({
            write: () => {},
            schedule: () => {},
            maxPendingBytes: 4,
            onReject,
        });

        expect(queue.enqueue({ data: 'abcd', byteLength: 4 })).toBe(true);
        expect(queue.enqueue({ data: 'e', byteLength: 1 })).toBe(false);
        expect(onReject).toHaveBeenCalledWith({
            byteLength: 1,
            pendingBytes: 4,
            maxPendingBytes: 4,
        });
    });

    it('drops stale parser callbacks after clear', () => {
        const parserCallbacks: Array<() => void> = [];
        const onComplete = vi.fn();
        const queue = createXtermWriteQueue({
            write: (_data, callback) => parserCallbacks.push(callback),
            schedule: (flush) => flush(),
            maxPendingBytes: 1024,
        });

        queue.enqueue({ data: 'hello', byteLength: 5, onComplete });
        queue.clear();
        parserCallbacks.shift()?.();

        expect(onComplete).not.toHaveBeenCalled();
        expect(queue.pendingBytes()).toBe(0);
        expect(queue.pendingCount()).toBe(0);
    });
});
