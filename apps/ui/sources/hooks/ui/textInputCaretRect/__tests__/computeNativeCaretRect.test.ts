import { describe, it, expect } from 'vitest';
import { computeNativeCaretRect } from '../useTextInputCaretRect.native';

describe('computeNativeCaretRect', () => {
    it('computes window-relative caret rect from input offset and selection coordinates', () => {
        const result = computeNativeCaretRect(
            { x: 100, y: 200 },
            { start: { x: 50, y: 10 }, end: { x: 50, y: 10 } },
        );

        expect(result).toEqual({
            left: 150,
            top: 210,
            height: 16,
        });
    });

    it('computes height from selection span when start.y differs from end.y', () => {
        const result = computeNativeCaretRect(
            { x: 0, y: 0 },
            { start: { x: 10, y: 20 }, end: { x: 10, y: 50 } },
        );

        expect(result).toEqual({
            left: 10,
            top: 20,
            height: 30,
        });
    });

    it('uses minimum height of 16 when selection start and end y are equal', () => {
        const result = computeNativeCaretRect(
            { x: 50, y: 100 },
            { start: { x: 0, y: 0 }, end: { x: 0, y: 0 } },
        );

        expect(result.height).toBe(16);
    });

    it('uses minimum height of 16 when computed height is less than 16', () => {
        const result = computeNativeCaretRect(
            { x: 0, y: 0 },
            { start: { x: 0, y: 5 }, end: { x: 0, y: 10 } },
        );

        expect(result.height).toBe(16);
    });

    it('uses actual height when selection span exceeds minimum', () => {
        const result = computeNativeCaretRect(
            { x: 0, y: 0 },
            { start: { x: 0, y: 0 }, end: { x: 0, y: 24 } },
        );

        expect(result.height).toBe(24);
    });

    it('handles negative input offsets', () => {
        const result = computeNativeCaretRect(
            { x: -10, y: -20 },
            { start: { x: 30, y: 40 }, end: { x: 30, y: 40 } },
        );

        expect(result).toEqual({
            left: 20,
            top: 20,
            height: 16,
        });
    });

    it('handles zero offsets', () => {
        const result = computeNativeCaretRect(
            { x: 0, y: 0 },
            { start: { x: 0, y: 0 }, end: { x: 0, y: 0 } },
        );

        expect(result).toEqual({
            left: 0,
            top: 0,
            height: 16,
        });
    });
});
