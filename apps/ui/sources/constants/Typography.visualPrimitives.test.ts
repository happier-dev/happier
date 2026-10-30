import { describe, expect, it } from 'vitest';

import { EYEBROW_TYPOGRAPHY, Typography } from './Typography';

describe('Typography visual primitive helpers', () => {
    it('exposes tabular numerals as a fresh single-purpose style fragment', () => {
        const a = Typography.tabular();
        const b = Typography.tabular();

        expect(a).not.toBe(b);
        expect(a).toEqual({ fontVariant: ['tabular-nums'] });
    });

    it('exposes eyebrow styling for uppercase section labels', () => {
        const style = EYEBROW_TYPOGRAPHY;

        expect(style).toMatchObject({
            textTransform: 'uppercase',
        });
        expect(Number(style.fontSize)).toBeGreaterThan(0);
        expect(Number(style.lineHeight)).toBeGreaterThanOrEqual(Number(style.fontSize));
        expect(Number(style.letterSpacing)).toBeGreaterThan(0);
    });

    it('exposes rowTitle and rowMeta helpers for two-tier rows', () => {
        const title = Typography.variant('label', 'semiBold');
        const meta = Typography.variant('meta');

        expect(Number(title.fontSize)).toBeGreaterThan(Number(meta.fontSize));
        expect(Number(title.lineHeight)).toBeGreaterThanOrEqual(Number(title.fontSize));
        expect(Number(meta.lineHeight)).toBeGreaterThanOrEqual(Number(meta.fontSize));
    });

    it('uses the canonical Inter faces for prose and chrome while key hints stay mono', () => {
        expect(Typography.variant('reading').fontFamily).toContain('Inter-Regular');
        expect(Typography.variant('meta').fontFamily).toContain('Inter-Regular');
        expect(({ ...Typography.variant('micro', 'regular'), ...Typography.tabular() }).fontFamily).toContain('Inter-Regular');
        expect(EYEBROW_TYPOGRAPHY.fontFamily).toContain('Inter-SemiBold');
        expect(Typography.variant('label', 'semiBold').fontFamily).toContain('Inter-SemiBold');
        expect(Typography.variant('micro', 'semiBold').fontFamily).toContain('Inter-SemiBold');
        expect(({ ...Typography.variant('micro', 'regular'), ...Typography.mono(), ...Typography.tabular() }).fontFamily).toContain('IBMPlexMono-Regular');
    });

    it('exposes compact pill and key-hint label helpers', () => {
        const pillLabel = Typography.variant('micro', 'semiBold');
        const keyHint = ({ ...Typography.variant('micro', 'regular'), ...Typography.mono(), ...Typography.tabular() });

        expect(Number(pillLabel.fontSize)).toBeGreaterThan(0);
        expect(Number(keyHint.fontSize)).toBeGreaterThan(0);
        expect(keyHint).toMatchObject(Typography.mono());
    });

});
