import { describe, expect, it } from 'vitest';

import { countTextLinesUpTo } from './countTextLinesUpTo';

describe('countTextLinesUpTo', () => {
    it('counts lines like split(\\n).length', () => {
        expect(countTextLinesUpTo('', 100)).toBe(1);
        expect(countTextLinesUpTo('a', 100)).toBe(1);
        expect(countTextLinesUpTo('a\nb', 100)).toBe(2);
        expect(countTextLinesUpTo('a\n', 100)).toBe(2);
        expect(countTextLinesUpTo('a\nb\nc', 100)).toBe(3);
    });

    it('caps at maxLines for early-exit callers', () => {
        expect(countTextLinesUpTo('a\nb\nc\nd', 2)).toBe(2);
        expect(countTextLinesUpTo('a\nb\nc\nd', 3)).toBe(3);
    });
});
