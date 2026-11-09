import { describe, expect, it } from 'vitest';
import { keepNamesWhole } from './keepNamesWhole';

describe('keepNamesWhole', () => {
    it('keeps a hyphenated name on one line and leaves spaced dashes and edges alone', () => {
        expect(keepNamesWhole('Failed · NLDW3-5-36-33')).toBe('Failed · NLDW3‑5‑36‑33');
        expect(keepNamesWhole('a - b')).toBe('a - b');
        expect(keepNamesWhole('-flag')).toBe('-flag');
    });
});
