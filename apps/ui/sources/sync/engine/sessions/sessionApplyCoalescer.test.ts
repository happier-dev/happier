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

    it('keeps the settled request cohort when an older pending snapshot replaces a queued session', () => {
        const applyBatch = vi.fn<(sessions: SessionApplyCoalescerSession[]) => void>();
        const coalescer = createSessionApplyCoalescer({
            getConfig: () => ({ enabled: true, windowMs: 16, maxBatchSize: 10 }),
            applyBatch,
        });
        const settled = {
            ...buildSession('s1', 3),
            agentStateVersion: 2,
            agentState: { requests: {} },
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            pendingRequestObservedAt: null,
        } satisfies SessionApplyCoalescerSession;
        coalescer.enqueue([settled], { deferLeadingBatch: true });
        coalescer.enqueue([{
            ...settled,
            updatedAt: 2,
            agentStateVersion: 1,
            agentState: { requests: { r1: { tool: 'Bash', arguments: {}, createdAt: 2 } } },
            pendingPermissionRequestCount: 1,
            pendingRequestObservedAt: 2,
            metadata: { path: '/renamed', host: 'host' },
            metadataVersion: 2,
        }]);
        coalescer.flushAll();

        expect(applyBatch.mock.calls[0]?.[0][0]).toMatchObject({
            agentStateVersion: 2,
            agentState: { requests: {} },
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            pendingRequestObservedAt: null,
            metadata: { path: '/renamed' },
            metadataVersion: 2,
        });
    });

    it('keeps independently newer queued metadata when accepting a new request version', () => {
        const applyBatch = vi.fn<(sessions: SessionApplyCoalescerSession[]) => void>();
        const coalescer = createSessionApplyCoalescer({
            getConfig: () => ({ enabled: true, windowMs: 16, maxBatchSize: 10 }),
            applyBatch,
        });
        const queued = {
            ...buildSession('s1', 3), metadataVersion: 3,
            metadata: { path: '/current', host: 'host' },
        };
        coalescer.enqueue([queued], { deferLeadingBatch: true });
        coalescer.enqueue([{
            ...queued, metadataVersion: 2, metadata: { path: '/stale', host: 'host' },
            agentStateVersion: 2, agentState: { requests: {} },
            pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0, pendingRequestObservedAt: null,
        }]);
        coalescer.flushAll();
        expect(applyBatch.mock.calls[0]?.[0][0]).toMatchObject({
            metadataVersion: 3, metadata: { path: '/current' }, agentStateVersion: 2,
            pendingPermissionRequestCount: 0,
        });
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
