import { describe, expect, it } from 'vitest';

import { scaleTextStyle } from './uiFontScale';

describe('uiFontScale', () => {
    it('scales fontSize, lineHeight, and letterSpacing', () => {
        const tokenStyle = { unistyles_abc: 1, color: 'red' } as any;
        const scaled = scaleTextStyle(
            [
                tokenStyle,
                { fontSize: 10, lineHeight: 12, letterSpacing: -0.5 },
            ] as any,
            1.2,
        ) as any;

        expect(Array.isArray(scaled)).toBe(true);
        expect(scaled[0]).toBe(tokenStyle);
        expect(scaled[1]).toMatchObject({
            fontSize: 12,
            lineHeight: 14.4,
            letterSpacing: -0.6,
        });
    });

    it('preserves non-enumerable metadata when scaling', () => {
        const marker = Symbol('marker');
        const style: any = { fontSize: 10 };
        Object.defineProperty(style, marker, { value: { className: 'unistyles_x' }, enumerable: false });

        const scaled = scaleTextStyle(style, 1.2) as any;
        expect(scaled.fontSize).toBe(12);
        expect(Object.getOwnPropertySymbols(scaled)).toContain(marker);
        expect(scaled[marker]).toEqual({ className: 'unistyles_x' });
    });

    it('does not crash on nullish styles', () => {
        expect(scaleTextStyle(null, 1.1)).toBe(null);
        expect(scaleTextStyle(undefined, 1.1)).toBe(undefined);
    });

    it('returns the original style reference when there is nothing to scale', () => {
        const style = [{ color: 'red' }, { fontFamily: 'Inter-Regular' }];
        expect(scaleTextStyle(style, 1.2)).toBe(style);
    });
});
