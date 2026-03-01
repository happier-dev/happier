import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import type { NormalizedMessage } from '@/sync/typesRaw';
import { createSessionMessageApplyCoalescer } from './sessionMessageApplyCoalescer';

function buildUserTextMessage(id: string, createdAt: number): NormalizedMessage {
    return {
        role: 'user',
        content: { type: 'text', text: id },
        id,
        seq: createdAt,
        localId: null,
        createdAt,
        isSidechain: false,
    };
}

describe('createSessionMessageApplyCoalescer', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('coalesces multiple enqueues into a single flush per session', () => {
        const applied: Array<{ sessionId: string; messageIds: string[] }> = [];
        const applyBatch = vi.fn((sessionId: string, messages: NormalizedMessage[]) => {
            applied.push({ sessionId, messageIds: messages.map((m) => m.id) });
        });

        const coalescer = createSessionMessageApplyCoalescer({
            getConfig: () => ({ enabled: true, windowMs: 16, maxBatchSize: 200 }),
            applyBatch,
        });

        coalescer.enqueue('s1', [buildUserTextMessage('m1', 1)]);
        coalescer.enqueue('s1', [buildUserTextMessage('m2', 2)]);

        expect(applyBatch).not.toHaveBeenCalled();

        vi.advanceTimersByTime(16);

        expect(applyBatch).toHaveBeenCalledTimes(1);
        expect(applied).toEqual([{ sessionId: 's1', messageIds: ['m1', 'm2'] }]);
    });

    it('applies immediately when disabled', () => {
        const applyBatch = vi.fn();
        const coalescer = createSessionMessageApplyCoalescer({
            getConfig: () => ({ enabled: false, windowMs: 16, maxBatchSize: 200 }),
            applyBatch,
        });

        coalescer.enqueue('s1', [buildUserTextMessage('m1', 1)]);

        expect(applyBatch).toHaveBeenCalledTimes(1);
        expect(applyBatch.mock.calls[0]?.[0]).toBe('s1');
        expect((applyBatch.mock.calls[0]?.[1] as NormalizedMessage[]).map((m) => m.id)).toEqual(['m1']);
    });

    it('respects maxBatchSize and preserves order across flushes', () => {
        const batches: string[][] = [];
        const applyBatch = vi.fn((_sessionId: string, messages: NormalizedMessage[]) => {
            batches.push(messages.map((m) => m.id));
        });

        const coalescer = createSessionMessageApplyCoalescer({
            getConfig: () => ({ enabled: true, windowMs: 16, maxBatchSize: 2 }),
            applyBatch,
        });

        coalescer.enqueue('s1', [buildUserTextMessage('m1', 1)]);
        coalescer.enqueue('s1', [buildUserTextMessage('m2', 2)]);
        coalescer.enqueue('s1', [buildUserTextMessage('m3', 3)]);

        expect(batches).toEqual([['m1', 'm2']]);

        vi.advanceTimersByTime(16);
        expect(batches).toEqual([['m1', 'm2'], ['m3']]);
    });

    it('exposes queued max seq for in-flight batches', () => {
        const applyBatch = vi.fn();
        const coalescer = createSessionMessageApplyCoalescer({
            getConfig: () => ({ enabled: true, windowMs: 16, maxBatchSize: 200 }),
            applyBatch,
        });

        expect(coalescer.getQueuedMaxSeq('s1')).toBe(0);

        coalescer.enqueue('s1', [buildUserTextMessage('m1', 2)]);
        coalescer.enqueue('s1', [buildUserTextMessage('m2', 5)]);

        expect(coalescer.getQueuedMaxSeq('s1')).toBe(5);

        vi.advanceTimersByTime(16);

        expect(coalescer.getQueuedMaxSeq('s1')).toBe(0);
    });
});
