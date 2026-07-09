import { describe, expect, it } from 'vitest';

import { isHardTerminatorDot } from '@/voice/shared/sentenceBoundary';

describe('isHardTerminatorDot (canonical sentence-boundary owner)', () => {
    const dotIndex = (text: string) => text.indexOf('.');

    it('treats a sentence-ending period as a hard terminator', () => {
        const text = 'Done. Next';
        expect(isHardTerminatorDot(text, dotIndex(text))).toBe(true);
    });

    it('does not split inside a decimal number', () => {
        const text = '3.14';
        expect(isHardTerminatorDot(text, dotIndex(text))).toBe(false);
    });

    it('does not split on a known abbreviation', () => {
        for (const text of ['e.g', 'i.e', 'Dr', 'Mr', 'etc']) {
            const sample = `${text}. rest`;
            // Index of the boundary dot (after the abbreviation token).
            const idx = sample.indexOf(`${text}.`) + text.length;
            expect(isHardTerminatorDot(sample, idx)).toBe(false);
        }
    });

    it('does not split on a single-letter initial', () => {
        const text = 'U. S. A';
        expect(isHardTerminatorDot(text, dotIndex(text))).toBe(false);
    });
});
