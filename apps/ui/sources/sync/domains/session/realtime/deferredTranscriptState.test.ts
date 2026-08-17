import { describe, expect, it } from 'vitest';

import {
    clearResolvedStaleTranscriptMessageIds,
    clearDeferredTranscriptStateForSession,
    createDeferredTranscriptState,
    hasStaleTranscriptMarkers,
    markDeferredTranscriptRemoteSeq,
    markTranscriptDeferred,
    markTranscriptStale,
    readStaleTranscriptMessageIds,
    readStaleTranscriptMinSeq,
} from './deferredTranscriptState';

describe('deferred transcript state', () => {
    it('tracks known remote seq separately from deferred durable seq', () => {
        const state = markDeferredTranscriptRemoteSeq(createDeferredTranscriptState(), 's1', 5);

        expect(state.knownRemoteSeqBySessionId.s1).toBe(5);
        expect(state.deferredDurableSeqBySessionId.s1).toBeUndefined();
    });

    it('marks deferred transcript seq without moving stale markers', () => {
        const state = markTranscriptDeferred(createDeferredTranscriptState(), 's1', {
            updateType: 'new-message',
            seq: 7,
            messageId: 'm7',
        });

        expect(state.knownRemoteSeqBySessionId.s1).toBe(7);
        expect(state.deferredDurableSeqBySessionId.s1).toBe(7);
        expect(hasStaleTranscriptMarkers(state, 's1')).toBe(false);
    });

    it('dedupes stale message markers and clears reveal state only', () => {
        const first = markTranscriptStale(createDeferredTranscriptState(), 's1', {
            updateType: 'message-updated',
            seq: 2,
            messageId: 'm2',
        });
        const second = markTranscriptStale(first, 's1', {
            updateType: 'message-updated',
            seq: 2,
            messageId: 'm2',
        });
        const cleared = clearDeferredTranscriptStateForSession(second, 's1');

        expect(second.staleMessageIdsBySessionId.s1).toEqual(['m2']);
        expect(hasStaleTranscriptMarkers(second, 's1')).toBe(true);
        expect(cleared.staleMessageIdsBySessionId.s1).toBeUndefined();
        expect(cleared.deferredDurableSeqBySessionId.s1).toBeUndefined();
        expect(cleared.knownRemoteSeqBySessionId.s1).toBe(2);
    });

    it('clears only exact stale rows resolved by a paged targeted refetch', () => {
        const first = markTranscriptStale(createDeferredTranscriptState(), 's1', {
            updateType: 'message-updated',
            seq: 2,
            messageId: 'm2',
        });
        const second = markTranscriptStale(first, 's1', {
            updateType: 'message-updated',
            seq: 200,
            messageId: 'm200',
        });

        const partiallyResolved = clearResolvedStaleTranscriptMessageIds(second, 's1', new Set(['m2']));
        expect(readStaleTranscriptMessageIds(partiallyResolved, 's1')).toEqual(['m200']);
        // Keep the original lower bound rather than silently skipping any
        // unresolved rows that were delivered concurrently with the first page.
        expect(readStaleTranscriptMinSeq(partiallyResolved, 's1')).toBe(2);
        expect(partiallyResolved.deferredDurableSeqBySessionId.s1).toBe(200);

        const fullyResolved = clearResolvedStaleTranscriptMessageIds(partiallyResolved, 's1', new Set(['m200']));
        expect(hasStaleTranscriptMarkers(fullyResolved, 's1')).toBe(false);
        expect(readStaleTranscriptMinSeq(fullyResolved, 's1')).toBeNull();
        // The generic deferred-newer marker remains independently owned.
        expect(fullyResolved.deferredDurableSeqBySessionId.s1).toBe(200);
    });
});
