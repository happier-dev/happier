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

    it('scales native Unistyles secret-backed text styles', () => {
        const dependency = Symbol('dependency');
        const secret = {
            uni__getStyles: () => ({
                color: 'red',
                fontSize: 14,
                lineHeight: 20,
                letterSpacing: -0.24,
            }),
            uni__dependencies: [dependency],
        };
        const style = {
            unistyles_native_text: secret,
        } as any;

        const scaled = scaleTextStyle(style, 1.25) as any;

        expect(scaled).not.toBe(style);
        expect(scaled.unistyles_native_text).not.toBe(secret);
        expect(scaled.unistyles_native_text.uni__dependencies).toBe(secret.uni__dependencies);
        expect(scaled.unistyles_native_text.uni__getStyles()).toEqual({
            color: 'red',
            fontSize: 17.5,
            lineHeight: 25,
            letterSpacing: -0.3,
        });
    });

    it('scales native Unistyles secret-backed text styles inside nested style arrays', () => {
        const secret = {
            uni__getStyles: () => ({
                color: 'blue',
                fontSize: 12,
                lineHeight: 16,
            }),
            uni__dependencies: [],
        };
        const nestedStyle = [
            { color: 'red' },
            [{ unistyles_nested_text: secret }],
        ] as any;

        const scaled = scaleTextStyle(nestedStyle, 1.5) as any;

        expect(scaled).not.toBe(nestedStyle);
        expect(scaled[1]).not.toBe(nestedStyle[1]);
        expect(scaled[1][0]).not.toBe(nestedStyle[1][0]);
        expect(scaled[1][0].unistyles_nested_text).not.toBe(secret);
        expect(scaled[1][0].unistyles_nested_text.uni__getStyles()).toEqual({
            color: 'blue',
            fontSize: 18,
            lineHeight: 24,
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
