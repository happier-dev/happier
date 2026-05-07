import { describe, expect, it } from 'vitest';

import {
    readCommonPrefixLength,
    splitStreamingRevealTextParts,
} from './splitStreamingRevealTextParts';

describe('splitStreamingRevealTextParts', () => {
    it('marks only words after the common prefix as animated', () => {
        expect(splitStreamingRevealTextParts({
            text: 'Hello world again',
            commonPrefixLength: 'Hello world '.length,
        })).toEqual([
            { text: 'Hello', animated: false },
            { text: ' ', animated: false },
            { text: 'world', animated: false },
            { text: ' ', animated: false },
            { text: 'again', animated: true },
        ]);
    });

    it('preserves whitespace as non-animated text parts', () => {
        expect(splitStreamingRevealTextParts({
            text: 'Hello\n\nworld',
            commonPrefixLength: 0,
        })).toEqual([
            { text: 'Hello', animated: true },
            { text: '\n\n', animated: false },
            { text: 'world', animated: true },
        ]);
    });

    it('uses a character common prefix for repaired non-append changes', () => {
        expect(readCommonPrefixLength('Look at docs', 'Look at docs now')).toBe('Look at docs'.length);
        expect(readCommonPrefixLength('This is **half', 'This is half done')).toBe('This is '.length);
    });
});
