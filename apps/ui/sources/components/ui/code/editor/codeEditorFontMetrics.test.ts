import { describe, expect, it } from 'vitest';

import { resolveCodeEditorFontMetrics } from './codeEditorFontMetrics';
import { resolveCodeEditorGutterMetrics, resolveCodeEditorLineNumberDigits } from './codeEditorFontMetrics';

describe('resolveCodeEditorFontMetrics', () => {
    it('applies uiFontScale and osFontScale', () => {
        const m = resolveCodeEditorFontMetrics({ uiFontScale: 2, osFontScale: 1.25 });
        expect(m.fontSize).toBe(33);
        expect(m.lineHeight).toBe(55);
        expect(m.scale).toBeCloseTo(2.5, 5);
        expect(m.lineNumberFontSize).toBe(28);
    });
    it('reserves gutter space for maximum line digits, measured glyphs and a review lane', () => {
        for (const [digits, digitWidth, numberWidth, textOffset] of [
            [1, 7.8, 24, 86],
            [1, 15.6, 24, 86],
            [1, 19.5, 24, 86],
            [2, 7.8, 24, 86],
            [2, 15.6, 31, 93],
            [2, 19.5, 39, 101],
            [3, 7.8, 24, 86],
            [3, 15.6, 47, 109],
            [3, 19.5, 59, 121],
            [4, 7.8, 31, 93],
            [4, 15.6, 62, 124],
            [4, 19.5, 78, 140],
            [5, 7.8, 39, 101],
            [5, 15.6, 78, 140],
            [5, 19.5, 98, 160],
        ] as const) {
            expect(resolveCodeEditorGutterMetrics({ lineNumberDigits: digits, digitWidth, reviewLaneWidth: 32 }))
                .toEqual({ numberWidth, textOffset });
        }
        expect(resolveCodeEditorGutterMetrics({ lineNumberDigits: 5, digitWidth: 7.8, showLineNumbers: false }).textOffset).toBe(30);
        expect(resolveCodeEditorGutterMetrics({ lineNumberDigits: 5, digitWidth: 7.8, showLineNumbers: false, columns: 2 }).textOffset).toBe(30);
    });
    it('counts CRLF as one line boundary when crossing a digit boundary', () => {
        const text = Array.from({ length: 9 }, () => 'line').join('\r\n');
        expect(resolveCodeEditorLineNumberDigits(text)).toBe(1);
        expect(resolveCodeEditorLineNumberDigits(`${text}\nlast`)).toBe(2);
    });
});

