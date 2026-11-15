import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import type { NormalizedMessage } from '@/sync/typesRaw';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { flushRealtimeFanoutTelemetry, resetRealtimeFanoutTelemetry } from '@/sync/runtime/performance/realtimeFanoutTelemetry';
import { createSessionMessageApplyCoalescer } from './sessionMessageApplyCoalescer';
import { socketApplyFrame } from './socketApplyFrame';

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

function findEvent(name: string) {
    return syncPerformanceTelemetry.snapshot().events.find((event) => event.name === name);
}

describe('createSessionMessageApplyCoalescer', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        syncPerformanceTelemetry.reset();
    });

    afterEach(() => {
        socketApplyFrame.flushNow();
        vi.useRealTimers();
        resetRealtimeFanoutTelemetry();
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

    it('applies every enqueue that arrives within one frame as one ordered batch at that frame', async () => {
        const applied: Array<{ sessionId: string; messageIds: string[] }> = [];
        const coalescer = createSessionMessageApplyCoalescer({
            getConfig: () => ({ enabled: true, windowMs: 16, maxBatchSize: 200 }),
            applyBatch: (sessionId, messages) => {
                applied.push({ sessionId, messageIds: messages.map((m) => m.id) });
            },
        });

        for (let i = 1; i <= 5; i += 1) {
            coalescer.enqueue('s1', [buildUserTextMessage(`m${i}`, i)]);
        }
        expect(applied).toEqual([]);

        await vi.advanceTimersByTimeAsync(16);

        expect(applied).toEqual([{ sessionId: 's1', messageIds: ['m1', 'm2', 'm3', 'm4', 'm5'] }]);
        await vi.runAllTimersAsync();
        expect(applied).toHaveLength(1);
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

    it('respects maxBatchSize and preserves order across bounded and frame flushes', async () => {
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

        await vi.runAllTimersAsync();
        expect(batches).toEqual([['m1', 'm2'], ['m3']]);
    });

    it('exposes queued max seq for in-flight batches', async () => {
        const applyBatch = vi.fn();
        const coalescer = createSessionMessageApplyCoalescer({
            getConfig: () => ({ enabled: true, windowMs: 16, maxBatchSize: 200 }),
            applyBatch,
        });

        expect(coalescer.getQueuedMaxSeq('s1')).toBe(0);

        coalescer.enqueue('s1', [buildUserTextMessage('m1', 2)]);
        coalescer.enqueue('s1', [buildUserTextMessage('m2', 5)]);

        expect(coalescer.getQueuedMaxSeq('s1')).toBe(5);

        await vi.runAllTimersAsync();

        expect(coalescer.getQueuedMaxSeq('s1')).toBe(0);
    });

    it('drops queued messages whose guard becomes stale before delayed flush', async () => {
        let isCurrentScope = true;
        const applyBatch = vi.fn();
        const coalescer = createSessionMessageApplyCoalescer({
            getConfig: () => ({ enabled: true, windowMs: 16, maxBatchSize: 1 }),
            applyBatch,
        });

        coalescer.enqueue('s1', [
            buildUserTextMessage('m1', 1),
            buildUserTextMessage('m2', 2),
        ], { shouldContinue: () => isCurrentScope });

        // The bounded batch applies at once; the rest waits for the frame.
        expect(applyBatch).toHaveBeenCalledTimes(1);
        expect((applyBatch.mock.calls[0]?.[1] as NormalizedMessage[]).map((message) => message.id)).toEqual(['m1']);

        isCurrentScope = false;
        expect(coalescer.getQueuedMaxSeq('s1')).toBe(0);

        await vi.runAllTimersAsync();

        expect(applyBatch).toHaveBeenCalledTimes(1);
    });

    it('drops queued messages by id before a delayed flush', async () => {
        const applyBatch = vi.fn();
        const coalescer = createSessionMessageApplyCoalescer({
            getConfig: () => ({ enabled: true, windowMs: 16, maxBatchSize: 1 }),
            applyBatch,
        });

        coalescer.enqueue('s1', [
            buildUserTextMessage('m1', 1),
            buildUserTextMessage('m2', 2),
        ]);

        coalescer.dropQueuedMessageIds('s1', ['m2']);
        await vi.runAllTimersAsync();

        expect(applyBatch).toHaveBeenCalledTimes(1);
        expect((applyBatch.mock.calls[0]?.[1] as NormalizedMessage[]).map((message) => message.id)).toEqual(['m1']);
    });

    it('records queued and flushed streaming message batches', async () => {
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 1_000_000,
        });
        syncPerformanceTelemetry.reset();

        const coalescer = createSessionMessageApplyCoalescer({
            getConfig: () => ({ enabled: true, windowMs: 16, maxBatchSize: 200 }),
            applyBatch: vi.fn(),
        });

        coalescer.enqueue('s1', [buildUserTextMessage('m1', 1)]);
        coalescer.enqueue('s1', [buildUserTextMessage('m2', 2)]);

        expect(findEvent('sync.socket.messages.coalesce.immediate')).toBeUndefined();
        expect(findEvent('sync.socket.messages.coalesce.queued')).toMatchObject({
            count: 2,
            fields: { messages: 2, queued: 3 },
        });

        await vi.runAllTimersAsync();

        expect(findEvent('sync.socket.messages.coalesce.flush')).toMatchObject({
            count: 1,
            fields: { messages: 2, remaining: 0 },
        });
    });

    it('summarizes coalescer queue depth for realtime fanout telemetry', async () => {
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 1_000_000,
        });
        syncPerformanceTelemetry.reset();
        resetRealtimeFanoutTelemetry();

        const coalescer = createSessionMessageApplyCoalescer({
            getConfig: () => ({ enabled: true, windowMs: 16, maxBatchSize: 200 }),
            applyBatch: vi.fn(),
        });

        coalescer.enqueue('s1', [buildUserTextMessage('m1', 1)]);
        coalescer.enqueue('s1', [buildUserTextMessage('m2', 2)]);
        flushRealtimeFanoutTelemetry();

        expect(findEvent('sync.sessions.realtime.fanout.window')).toMatchObject({
            count: 1,
            fields: expect.objectContaining({
                coalescerEnqueues: 2,
                coalescerMessagesEnqueued: 2,
                maxCoalescerQueueDepth: 2,
            }),
        });

        await vi.runAllTimersAsync();
    });

    it('does not count coalescer drops for sessions with no queued messages', async () => {
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 1_000_000,
        });
        syncPerformanceTelemetry.reset();
        resetRealtimeFanoutTelemetry();

        const coalescer = createSessionMessageApplyCoalescer({
            getConfig: () => ({ enabled: true, windowMs: 16, maxBatchSize: 200 }),
            applyBatch: vi.fn(),
        });

        coalescer.enqueue('s1', [buildUserTextMessage('m1', 1)]);
        await vi.runAllTimersAsync();
        coalescer.dropSessionIds(['s1']);
        flushRealtimeFanoutTelemetry();

        expect(findEvent('sync.sessions.realtime.fanout.window')).toMatchObject({
            fields: expect.objectContaining({
                coalescerDrops: 0,
                coalescerMessagesDropped: 0,
            }),
        });
    });
});
