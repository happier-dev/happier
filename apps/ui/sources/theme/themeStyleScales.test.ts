import { describe, expect, it } from 'vitest';

import { darkTheme, lightTheme } from '@/theme';

import { applyThemeStyleScales, resolveThemeStyleScales } from './themeStyleScales';

// Today's literal values, written out so a table edit that silently moves the default fails here.
// One base of 10 with the derived steps (plugin-ui `radius.ts`); a modal card is a dialog.
const TODAY_BORDER_RADIUS = { sm: 6, md: 8, lg: 10, xl: 14, xxl: 18, modalCard: 18 };
const TODAY_MARGINS = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24 };

describe('theme style scales', () => {
    it('defaults to soft and lets each surface inherit or override the global finish without moving radii', () => {
        const defaults = resolveThemeStyleScales();
        expect(defaults.finish).toBe('soft');
        const flat = resolveThemeStyleScales({ finish: 'flat', parts: { floating: { finish: 'soft' }, composer: { radius: 'xxl', finish: 'soft' } } });
        expect(flat.finish).toBe('flat');
        expect(flat.parts.card.finish).toBe('flat');
        expect(flat.parts.primaryButton.finish).toBe('flat');
        expect(flat.parts.secondaryButton.finish).toBe('flat');
        expect(flat.parts.floating.finish).toBe('soft');
        expect(flat.parts.composer).toEqual({ radius: flat.borderRadius.xxl, finish: 'soft' });
        expect(flat.parts.card.radius).toBe(defaults.parts.card.radius);
        expect(applyThemeStyleScales(lightTheme, defaults)).toBe(lightTheme);
        const styled = applyThemeStyleScales(lightTheme, flat);
        expect(applyThemeStyleScales(styled, resolveThemeStyleScales({ finish: 'flat', parts: { floating: { finish: 'soft' }, composer: { radius: 'xxl', finish: 'soft' } } }))).toBe(styled);
    });
    it('keeps every default equal to the values the app renders today', () => {
        const scales = resolveThemeStyleScales();

        expect(scales.borderRadius).toEqual(TODAY_BORDER_RADIUS);
        expect(scales.margins).toEqual(TODAY_MARGINS);
        expect(scales.parts).toEqual({
            userBubble: { radius: 14, finish: 'soft' },
            // The composer stack: 14, 18 on Android (the test platform is not Android).
            composer: { radius: 14, finish: 'soft' },
            toolCard: { radius: 8, finish: 'soft' },
            approvalCard: { radius: 14, finish: 'soft' },
            codeBlock: { radius: 10, finish: 'soft' },
            card: { radius: 14, finish: 'soft' },
            floating: { radius: 10, finish: 'soft' },
            primaryButton: { radius: 8, finish: 'soft' },
            secondaryButton: { radius: 8, finish: 'soft' },
        });
        expect(scales.transcript).toEqual({ messageGap: 22 });
        expect(scales.typography).toEqual({ fontFamily: null, monoFontFamily: null });

        for (const theme of [lightTheme, darkTheme]) {
            expect(theme.borderRadius).toEqual(TODAY_BORDER_RADIUS);
            expect(theme.margins).toEqual(TODAY_MARGINS);
            expect(theme.parts).toEqual(scales.parts);
            expect(theme.transcript).toEqual(scales.transcript);
            expect(theme.typography).toEqual(scales.typography);
        }
    });

    it('changes exactly the radius scale and the part radii derived from it for a sharp style', () => {
        const defaults = resolveThemeStyleScales();
        const sharp = resolveThemeStyleScales({ radius: 'sharp' });

        for (const step of Object.keys(TODAY_BORDER_RADIUS) as Array<keyof typeof TODAY_BORDER_RADIUS>) {
            expect(sharp.borderRadius[step]).toBeLessThan(defaults.borderRadius[step]);
        }
        expect(sharp.parts.toolCard.radius).toBe(sharp.borderRadius.md);
        expect(sharp.parts.userBubble.radius).toBe(sharp.borderRadius.xl);
        expect(sharp.margins).toEqual(defaults.margins);
        expect(sharp.transcript).toEqual(defaults.transcript);
        expect(sharp.typography).toEqual(defaults.typography);
    });

    it('lets a part pick another step of the active radius scale', () => {
        const round = resolveThemeStyleScales({ radius: 'round', parts: { toolCard: { radius: 'xxl' } } });

        expect(round.parts.toolCard.radius).toBe(round.borderRadius.xxl);
        expect(round.parts.codeBlock.radius).toBe(round.borderRadius.lg);
    });

    it('tightens spacing and the transcript rhythm for a compact density only', () => {
        const defaults = resolveThemeStyleScales();
        const compact = resolveThemeStyleScales({ density: 'compact' });

        expect(compact.transcript.messageGap).toBeLessThan(defaults.transcript.messageGap);
        expect(compact.margins.lg).toBeLessThan(defaults.margins.lg);
        expect(compact.borderRadius).toEqual(defaults.borderRadius);
    });

    it('applies scales onto a theme without touching its colours', () => {
        const styled = applyThemeStyleScales(lightTheme, resolveThemeStyleScales({
            radius: 'round',
            fontFamily: 'Acme Sans',
        }));

        expect(styled.colors).toBe(lightTheme.colors);
        expect(styled.borderRadius.xl).toBeGreaterThan(lightTheme.borderRadius.xl);
        expect(styled.typography.fontFamily).toBe('Acme Sans');
        expect(applyThemeStyleScales(lightTheme, resolveThemeStyleScales())).toEqual(lightTheme);
    });
});
