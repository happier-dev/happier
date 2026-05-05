import { describe, expect, it } from 'vitest';

import {
    createCompletionQueueState,
    reduceCompletionQueue,
} from './completionQueue';

describe('completionQueue', () => {
    it('drops explicit completion events older than the recency window', () => {
        const state = reduceCompletionQueue(createCompletionQueueState(), {
            type: 'enqueue',
            event: {
                id: 'turn-old',
                sessionId: 'session-1',
                variant: 'turn_complete',
                occurredAtMs: 1_000,
                nowMs: 31_001,
            },
        });

        expect(state.visible).toBeNull();
        expect(state.pending).toEqual([]);
    });

    it('keeps subagent completion sticky after higher-priority turn completion is dismissed', () => {
        const first = reduceCompletionQueue(createCompletionQueueState(), {
            type: 'enqueue',
            event: {
                id: 'turn-1',
                sessionId: 'session-1',
                variant: 'turn_complete',
                occurredAtMs: 10_000,
                nowMs: 10_000,
            },
        });
        const second = reduceCompletionQueue(first, {
            type: 'enqueue',
            event: {
                id: 'subagent-1',
                sessionId: 'session-1',
                variant: 'subagent_done',
                occurredAtMs: 10_100,
                nowMs: 10_100,
            },
        });

        expect(second.visible).toEqual(expect.objectContaining({
            id: 'turn-1',
            sticky: false,
            variant: 'turn_complete',
        }));

        const dismissed = reduceCompletionQueue(second, {
            type: 'dismiss',
            id: 'turn-1',
        });

        expect(dismissed.visible).toEqual(expect.objectContaining({
            id: 'subagent-1',
            sticky: true,
            variant: 'subagent_done',
        }));
    });

    it('preempts visible completion with pending tool events and preserves FIFO order within priority', () => {
        const queued = [
            {
                id: 'turn-1',
                sessionId: 'session-1',
                variant: 'turn_complete' as const,
                occurredAtMs: 10_000,
                nowMs: 10_000,
            },
            {
                id: 'tool-1',
                sessionId: 'session-1',
                variant: 'pending_tool' as const,
                occurredAtMs: 10_100,
                nowMs: 10_100,
            },
            {
                id: 'tool-2',
                sessionId: 'session-2',
                variant: 'pending_tool' as const,
                occurredAtMs: 10_200,
                nowMs: 10_200,
            },
        ].reduce(
            (state, event) => reduceCompletionQueue(state, { type: 'enqueue', event }),
            createCompletionQueueState(),
        );

        expect(queued.visible).toEqual(expect.objectContaining({
            id: 'tool-1',
            variant: 'pending_tool',
        }));

        const dismissed = reduceCompletionQueue(queued, {
            type: 'dismiss',
            id: 'tool-1',
        });

        expect(dismissed.visible).toEqual(expect.objectContaining({
            id: 'tool-2',
            variant: 'pending_tool',
        }));
    });
});
