import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';
import { createSessionApplyCoalescer, type SessionApplyCoalescerSession } from './sessionApplyCoalescer';

function buildSession(sessionId: string, seq: number): SessionApplyCoalescerSession {
    return {
        id: sessionId,
        seq,
        createdAt: seq,
        updatedAt: seq,
        active: true,
        activeAt: seq,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    } satisfies Session;
}

describe('createSessionApplyCoalescer', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('drops queued sessions whose guard becomes stale before delayed flush', async () => {
        let isCurrentScope = true;
        const applyBatch = vi.fn();
        const coalescer = createSessionApplyCoalescer({
            getConfig: () => ({ enabled: true, windowMs: 16, maxBatchSize: 1 }),
            applyBatch,
        });

        coalescer.enqueue([
            buildSession('s1', 1),
            buildSession('s2', 2),
        ], { shouldContinue: () => isCurrentScope });

        expect(applyBatch).toHaveBeenCalledTimes(1);
        expect((applyBatch.mock.calls[0]?.[0] as SessionApplyCoalescerSession[]).map((session) => session.id)).toEqual(['s1']);

        isCurrentScope = false;
        expect(coalescer.getQueuedSession('s2')).toBeUndefined();

        await vi.runAllTimersAsync();

        expect(applyBatch).toHaveBeenCalledTimes(1);
    });
});
