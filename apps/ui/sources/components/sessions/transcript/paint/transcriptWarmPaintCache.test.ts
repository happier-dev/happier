import { beforeEach, describe, expect, it } from 'vitest';

import {
    __resetTranscriptWarmPaintCacheForTests,
    hasTranscriptWarmStablePaint,
    rememberTranscriptWarmStablePaint,
} from './transcriptWarmPaintCache';

describe('transcriptWarmPaintCache', () => {
    beforeEach(() => {
        __resetTranscriptWarmPaintCacheForTests();
    });

    it('stays warm when the transcript only GREW since it last painted', () => {
        // The record exists to answer "have we already measured this transcript's geometry",
        // and appended messages do not invalidate that: the rows that were measured are still
        // the rows above the new ones. Requiring an identical signature meant any message
        // arriving in a live agent session dropped it back to the slow first-paint placeholder
        // — which is the common case, not the edge case.
        rememberTranscriptWarmStablePaint({
            committedMessagesCount: 12,
            items: 4,
            latestCommittedActivityKey: 'message-12',
            nowMs: 1_000,
            platform: 'android',
            sessionId: 's1',
        });

        expect(hasTranscriptWarmStablePaint({
            committedMessagesCount: 12,
            items: 4,
            latestCommittedActivityKey: 'message-12',
            nowMs: 1_100,
            platform: 'android',
            sessionId: 's1',
        })).toBe(true);
        expect(hasTranscriptWarmStablePaint({
            committedMessagesCount: 13,
            items: 5,
            latestCommittedActivityKey: 'message-13',
            nowMs: 1_100,
            platform: 'android',
            sessionId: 's1',
        })).toBe(true);
    });

    it('drops warmth when the transcript SHRANK, because the measured geometry may be gone', () => {
        // A tail reset, a fork, or a retention eviction can leave fewer rows than were measured.
        // Growth is safe to reveal through; loss is not.
        rememberTranscriptWarmStablePaint({
            committedMessagesCount: 12,
            items: 4,
            latestCommittedActivityKey: 'message-12',
            nowMs: 1_000,
            platform: 'android',
            sessionId: 's1',
        });

        expect(hasTranscriptWarmStablePaint({
            committedMessagesCount: 11,
            items: 4,
            latestCommittedActivityKey: 'message-11',
            nowMs: 1_100,
            platform: 'android',
            sessionId: 's1',
        })).toBe(false);
        expect(hasTranscriptWarmStablePaint({
            committedMessagesCount: 12,
            items: 3,
            latestCommittedActivityKey: 'message-12',
            nowMs: 1_100,
            platform: 'android',
            sessionId: 's1',
        })).toBe(false);
    });

    it('remembers far more than a handful of sessions, because a record is four scalars', () => {
        // Swiping through a session list must not evict the sessions being swiped between.
        for (let index = 0; index < 120; index += 1) {
            rememberTranscriptWarmStablePaint({
                committedMessagesCount: 5,
                items: 3,
                latestCommittedActivityKey: `message-${index}`,
                nowMs: 1_000,
                platform: 'android',
                sessionId: `s${index}`,
            });
        }

        expect(hasTranscriptWarmStablePaint({
            committedMessagesCount: 5,
            items: 3,
            latestCommittedActivityKey: 'message-0',
            nowMs: 1_100,
            platform: 'android',
            sessionId: 's0',
        })).toBe(true);
    });

    it('does not treat web, route-hydrating, or expired paint records as native warm paint', () => {
        rememberTranscriptWarmStablePaint({
            committedMessagesCount: 1,
            items: 1,
            latestCommittedActivityKey: 'message-1',
            nowMs: 1_000,
            platform: 'ios',
            sessionId: 's1',
        });

        expect(hasTranscriptWarmStablePaint({
            committedMessagesCount: 1,
            items: 1,
            latestCommittedActivityKey: 'message-1',
            nowMs: 1_100,
            platform: 'web',
            sessionId: 's1',
        })).toBe(false);
        expect(hasTranscriptWarmStablePaint({
            committedMessagesCount: 1,
            items: 1,
            latestCommittedActivityKey: 'message-1',
            nowMs: 1_100,
            platform: 'ios',
            routeHydrationPending: true,
            sessionId: 's1',
        })).toBe(false);
        // Expiry is a memory bound, not a correctness one — the content check already refuses a
        // record that no longer describes the transcript — so it sits far beyond a browsing
        // session rather than inside one.
        expect(hasTranscriptWarmStablePaint({
            committedMessagesCount: 1,
            items: 1,
            latestCommittedActivityKey: 'message-1',
            nowMs: 13 * 60 * 60 * 1000,
            platform: 'ios',
            sessionId: 's1',
        })).toBe(false);
        // ...and a record from an hour ago is still perfectly usable.
        expect(hasTranscriptWarmStablePaint({
            committedMessagesCount: 1,
            items: 1,
            latestCommittedActivityKey: 'message-1',
            nowMs: 60 * 60 * 1000,
            platform: 'ios',
            sessionId: 's1',
        })).toBe(true);
    });
});
