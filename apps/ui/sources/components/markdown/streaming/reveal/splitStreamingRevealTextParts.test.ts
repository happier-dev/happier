import { describe, expect, it } from 'vitest';
import {
    readCommonPrefixLength,
    splitStreamingRevealTextParts,
    type StreamingRevealRange,
} from 'react-native-enriched-markdown/lib/module/web/streamingReveal.js';

// Pins the SHARED word classifier (owned by the vendored enriched-markdown package,
// shipped via patches/react-native-enriched-markdown+0.5.0.patch) in the exact
// single-appended-suffix-range recipe `StreamingTextReveal` feeds it with. The
// enriched renderer's range-driven usage is gated separately in
// components/markdown/enriched/enrichedStreamingRevealFlicker.test.ts.

function appendedSuffixRanges(params: Readonly<{
    commonPrefixLength: number;
    textLength: number;
}>): StreamingRevealRange[] {
    if (params.textLength <= params.commonPrefixLength) return [];
    return [{ start: params.commonPrefixLength, end: params.textLength, expiresAtMs: Number.MAX_SAFE_INTEGER }];
}

function splitWithSuffix(text: string, commonPrefixLength: number) {
    return splitStreamingRevealTextParts({
        text,
        startOffset: 0,
        activeRanges: appendedSuffixRanges({ commonPrefixLength, textLength: text.length }),
    }).map((part) => ({ text: part.text, animated: part.animated }));
}

describe('splitStreamingRevealTextParts (package-owned, plain-suffix recipe)', () => {
    it('marks only words after the common prefix as animated', () => {
        expect(splitWithSuffix('Hello world again', 'Hello world '.length)).toEqual([
            { text: 'Hello', animated: false },
            { text: ' ', animated: false },
            { text: 'world', animated: false },
            { text: ' ', animated: false },
            { text: 'again', animated: true },
        ]);
    });

    it('preserves whitespace as non-animated text parts', () => {
        expect(splitWithSuffix('Hello\n\nworld', 0)).toEqual([
            { text: 'Hello', animated: true },
            { text: '\n\n', animated: false },
            { text: 'world', animated: true },
        ]);
    });

    it('animates nothing when the text is unchanged', () => {
        expect(splitWithSuffix('Hello world', 'Hello world'.length)).toEqual([
            { text: 'Hello', animated: false },
            { text: ' ', animated: false },
            { text: 'world', animated: false },
        ]);
    });

    it('reports word start offsets in text space', () => {
        const parts = splitStreamingRevealTextParts({
            text: 'Hello world',
            startOffset: 0,
            activeRanges: [],
        });
        expect(parts.map((part) => part.startOffset)).toEqual([0, 5, 6]);
    });

    it('uses a character common prefix for repaired non-append changes', () => {
        expect(readCommonPrefixLength('Look at docs', 'Look at docs now')).toBe('Look at docs'.length);
        expect(readCommonPrefixLength('This is **half', 'This is half done')).toBe('This is '.length);
    });
});
