import { describe, expect, it } from 'vitest';

import { appendTranscriptQuoteToDraft } from './transcriptQuote';

describe('appendTranscriptQuoteToDraft', () => {
    it('quotes every selected line and leaves an empty line for the reply', () => {
        expect(appendTranscriptQuoteToDraft('', 'First paragraph\n\nSecond paragraph'))
            .toBe('> First paragraph\n>\n> Second paragraph\n\n');
    });

    it('keeps the existing draft and separates the quote from it with one blank line', () => {
        expect(appendTranscriptQuoteToDraft('Please check', 'the cache key')).toBe('Please check\n\n> the cache key\n\n');
        expect(appendTranscriptQuoteToDraft('Please check\n', 'the cache key')).toBe('Please check\n\n> the cache key\n\n');
        expect(appendTranscriptQuoteToDraft('> earlier\n\n', 'later')).toBe('> earlier\n\n> later\n\n');
    });

    it('trims surrounding blank lines and normalizes Windows line endings', () => {
        expect(appendTranscriptQuoteToDraft('', '\r\n  one\r\ntwo  \r\n\r\n')).toBe('> one\n> two\n\n');
    });

    it('returns null for a blank selection so the draft is left untouched', () => {
        expect(appendTranscriptQuoteToDraft('draft', ' \n\t ')).toBeNull();
    });
});
