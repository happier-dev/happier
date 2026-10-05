import { describe, expect, it } from 'vitest';
import { resolveTranscriptFindCoverage } from './transcriptFindCoverage';

describe('transcript Find coverage', () => {
    it('does not certify missing workflow display text complete after the root pages are exhausted', () => {
        const base = { history: { isLoaded: true, hasOlder: false, hasNewer: false }, stopped: false, partialErrors: false };
        expect(resolveTranscriptFindCoverage({ ...base, hasPendingText: true })).toBe('loaded');
        expect(resolveTranscriptFindCoverage({ ...base, hasUnreadableText: true })).toBe('partialErrors');
        expect(resolveTranscriptFindCoverage(base)).toBe('complete');
    });

    it('keeps both historical frontiers and Stop honest without hiding an unreadable range', () => {
        const base = { history: { isLoaded: true, hasOlder: false, hasNewer: true }, stopped: false, partialErrors: false };
        expect(resolveTranscriptFindCoverage(base)).toBe('loaded');
        expect(resolveTranscriptFindCoverage({ ...base, stopped: true })).toBe('olderRemaining');
        expect(resolveTranscriptFindCoverage({ ...base, stopped: true, hasUnreadableText: true })).toBe('partialErrors');
    });
});
