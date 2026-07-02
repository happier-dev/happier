import { describe, expect, it } from 'vitest';

import {
    clearDeferredTranscriptStateForSession,
    createDeferredTranscriptState,
    hasStaleTranscriptMarkers,
    markDeferredTranscriptRemoteSeq,
    markTranscriptDeferred,
    markTranscriptStale,
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
});
