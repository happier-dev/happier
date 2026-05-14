import { describe, expect, it } from 'vitest';

import { Typography } from './Typography';

describe('Typography visual primitive helpers', () => {
    it('exposes tabular numerals as a fresh single-purpose style fragment', () => {
        const a = Typography.tabular();
        const b = Typography.tabular();

        expect(a).not.toBe(b);
        expect(a).toEqual({ fontVariant: ['tabular-nums'] });
    });

    it('exposes eyebrow styling for uppercase section labels', () => {
        const style = Typography.eyebrow();

        expect(style).toMatchObject({
            textTransform: 'uppercase',
        });
        expect(Number(style.fontSize)).toBeGreaterThan(0);
        expect(Number(style.lineHeight)).toBeGreaterThanOrEqual(Number(style.fontSize));
        expect(Number(style.letterSpacing)).toBeGreaterThan(0);
    });

    it('exposes rowTitle and rowMeta helpers for two-tier rows', () => {
        const title = Typography.rowTitle();
        const meta = Typography.rowMeta();

        expect(Number(title.fontSize)).toBeGreaterThan(Number(meta.fontSize));
        expect(Number(title.lineHeight)).toBeGreaterThanOrEqual(Number(title.fontSize));
        expect(Number(meta.lineHeight)).toBeGreaterThanOrEqual(Number(meta.fontSize));
    });

    it('exposes compact pill and key-hint label helpers', () => {
        const pillLabel = Typography.pillLabel();
        const keyHint = Typography.keyHint();

        expect(Number(pillLabel.fontSize)).toBeGreaterThan(0);
        expect(Number(keyHint.fontSize)).toBeGreaterThan(0);
        expect(keyHint).toMatchObject(Typography.mono());
    });

    it('uses tabular numerals for timestamps', () => {
        expect(Typography.timestamp().fontVariant).toEqual(['tabular-nums']);
    });
});
