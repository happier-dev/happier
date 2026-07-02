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

    it('matches a native FlashList session only when the stable content signature is unchanged', () => {
        rememberTranscriptWarmStablePaint({
            committedMessagesCount: 12,
            items: 4,
            latestCommittedActivityKey: 'message-12',
            listImplementation: 'flash_v2',
            nowMs: 1_000,
            platform: 'android',
            sessionId: 's1',
        });

        expect(hasTranscriptWarmStablePaint({
            committedMessagesCount: 12,
            items: 4,
            latestCommittedActivityKey: 'message-12',
            listImplementation: 'flash_v2',
            nowMs: 1_100,
            platform: 'android',
            sessionId: 's1',
        })).toBe(true);
        expect(hasTranscriptWarmStablePaint({
            committedMessagesCount: 13,
            items: 4,
            latestCommittedActivityKey: 'message-13',
            listImplementation: 'flash_v2',
            nowMs: 1_100,
            platform: 'android',
            sessionId: 's1',
        })).toBe(false);
    });

    it('does not treat web, route-hydrating, or expired paint records as native warm paint', () => {
        rememberTranscriptWarmStablePaint({
            committedMessagesCount: 1,
            items: 1,
            latestCommittedActivityKey: 'message-1',
            listImplementation: 'flash_v2',
            nowMs: 1_000,
            platform: 'ios',
            sessionId: 's1',
        });

        expect(hasTranscriptWarmStablePaint({
            committedMessagesCount: 1,
            items: 1,
            latestCommittedActivityKey: 'message-1',
            listImplementation: 'flash_v2',
            nowMs: 1_100,
            platform: 'web',
            sessionId: 's1',
        })).toBe(false);
        expect(hasTranscriptWarmStablePaint({
            committedMessagesCount: 1,
            items: 1,
            latestCommittedActivityKey: 'message-1',
            listImplementation: 'flash_v2',
            nowMs: 1_100,
            platform: 'ios',
            routeHydrationPending: true,
            sessionId: 's1',
        })).toBe(false);
        expect(hasTranscriptWarmStablePaint({
            committedMessagesCount: 1,
            items: 1,
            latestCommittedActivityKey: 'message-1',
            listImplementation: 'flash_v2',
            nowMs: 11 * 60 * 1000,
            platform: 'ios',
            sessionId: 's1',
        })).toBe(false);
    });
});
