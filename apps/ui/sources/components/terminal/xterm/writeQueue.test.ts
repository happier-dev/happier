import { describe, expect, it, vi } from 'vitest';

import { createXtermWriteQueue } from './writeQueue';

describe('createXtermWriteQueue', () => {
    it('continues queued writes on parser completion without waiting for another presentation frame', () => {
        const scheduled: Array<() => void> = [];
        const written: string[] = [];
        const parserCallbacks: Array<() => void> = [];
        const completed: string[] = [];
        const queue = createXtermWriteQueue({
            write: (data, callback) => {
                written.push(String(data));
                parserCallbacks.push(callback);
            },
            schedule: (flush) => scheduled.push(flush),
            maxPendingBytes: 1024,
        });

        expect(queue.enqueue({ data: 'one', byteLength: 3, onComplete: () => completed.push('one') })).toBe(true);
        expect(queue.enqueue({ data: 'two', byteLength: 3, onComplete: () => completed.push('two') })).toBe(true);
        expect(written).toEqual([]);

        scheduled.shift()?.();
        scheduled.shift()?.();
        expect(written).toEqual(['one']);
        expect(completed).toEqual([]);

        parserCallbacks.shift()?.();
        expect(completed).toEqual(['one']);
        expect(written).toEqual(['one', 'two']);
        parserCallbacks.shift()?.();
        expect(completed).toEqual(['one', 'two']);
    });

    it('rejects writes that would exceed the pending-byte cap and frees the budget on clear', () => {
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

        queue.clear();
        expect(queue.enqueue({ data: 'efgh', byteLength: 4 })).toBe(true);
    });

    it.each([false, true])('drops stale parser callbacks after clear (synchronous=%s)', async (synchronous) => {
        const written: string[] = [];
        const parserCallbacks: Array<() => void> = [];
        const onComplete = vi.fn();
        const onNextComplete = vi.fn();
        const queue = createXtermWriteQueue({
            write: (data, callback) => {
                written.push(String(data));
                if (synchronous) callback();
                else parserCallbacks.push(callback);
            },
            schedule: (flush) => flush(),
            maxPendingBytes: 1024,
        });

        queue.enqueue({ data: 'hello', byteLength: 5, onComplete });
        queue.clear();
        parserCallbacks.shift()?.();
        await Promise.resolve();

        expect(onComplete).not.toHaveBeenCalled();

        queue.enqueue({ data: 'next', byteLength: 4, onComplete: onNextComplete });
        expect(written).toEqual(['hello', 'next']);
        parserCallbacks.shift()?.();
        await Promise.resolve();
        expect(onNextComplete).toHaveBeenCalledTimes(1);
        expect(onComplete).not.toHaveBeenCalled();
    });
});
