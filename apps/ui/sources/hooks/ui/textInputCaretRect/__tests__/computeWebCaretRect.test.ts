import { describe, it, expect } from 'vitest';
import { computeWebCaretRect } from '../useTextInputCaretRect.web';

describe('computeWebCaretRect', () => {
    it('computes viewport-relative caret rect from element rect, scroll, and caret coordinates', () => {
        const result = computeWebCaretRect(
            { left: 100, top: 200 },
            { left: 0, top: 0 },
            { left: 50, top: 10, height: 18 },
        );

        expect(result).toEqual({
            left: 150,
            top: 210,
            height: 18,
        });
    });

    it('subtracts element scroll from the computation', () => {
        const result = computeWebCaretRect(
            { left: 100, top: 200 },
            { left: 10, top: 30 },
            { left: 50, top: 40, height: 18 },
        );

        expect(result).toEqual({
            left: 140,
            top: 210,
            height: 18,
        });
    });

    it('handles zero values', () => {
        const result = computeWebCaretRect(
            { left: 0, top: 0 },
            { left: 0, top: 0 },
            { left: 0, top: 0, height: 0 },
        );

        expect(result).toEqual({
            left: 0,
            top: 0,
            height: 0,
        });
    });

    it('handles large scroll offsets', () => {
        const result = computeWebCaretRect(
            { left: 100, top: 500 },
            { left: 0, top: 400 },
            { left: 20, top: 420, height: 16 },
        );

        expect(result).toEqual({
            left: 120,
            top: 520,
            height: 16,
        });
    });

    it('preserves caret height as-is', () => {
        const result = computeWebCaretRect(
            { left: 0, top: 0 },
            { left: 0, top: 0 },
            { left: 0, top: 0, height: 24 },
        );

        expect(result.height).toBe(24);
    });
});
