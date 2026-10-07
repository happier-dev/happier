import { StyleSheet } from 'react-native';
import { describe, expect, it } from 'vitest';

import * as surfaceBorderStyles from './resolveThemeHairlineBorderStyle';

const { resolveThemeHairlineBorderStyle } = surfaceBorderStyles;

describe('resolveThemeHairlineBorderStyle', () => {
    it('removes layout-affecting border width for transparent colors', () => {
        expect(resolveThemeHairlineBorderStyle('transparent')).toEqual({
            borderColor: 'transparent',
            borderWidth: 0,
        });
    });

    it('removes layout-affecting border width for alpha-zero colors', () => {
        expect(resolveThemeHairlineBorderStyle('rgba(255, 255, 255, 0)')).toEqual({
            borderColor: 'rgba(255, 255, 255, 0)',
            borderWidth: 0,
        });
        expect(resolveThemeHairlineBorderStyle('#00000000')).toEqual({
            borderColor: '#00000000',
            borderWidth: 0,
        });
    });

    it('uses hairline width for visible colors', () => {
        expect(resolveThemeHairlineBorderStyle('rgba(255, 255, 255, 0.08)')).toEqual({
            borderColor: 'rgba(255, 255, 255, 0.08)',
            borderWidth: StyleSheet.hairlineWidth,
        });
    });

    it('keeps the surface border uniform without an edge (a popover arrow)', () => {
        expect(resolveThemeSurfaceBorderStyle({ borderColor: 'rgba(0,0,0,0.08)' })).toEqual({
            borderColor: 'rgba(0,0,0,0.08)',
            borderWidth: StyleSheet.hairlineWidth,
        });
    });

    it('recolours the top border as the raised edge on dark', () => {
        expect(resolveThemeSurfaceBorderStyle({
            borderColor: 'rgba(255,255,255,0.056)',
            edge: { side: 'top', color: 'rgba(255,255,255,0.113)' },
        })).toEqual({
            borderColor: 'rgba(255,255,255,0.056)',
            borderWidth: StyleSheet.hairlineWidth,
            borderTopColor: 'rgba(255,255,255,0.113)',
            borderTopWidth: StyleSheet.hairlineWidth,
        });
    });

    it('gives a borderless light sheet its bottom lip alone, and grounds it once it draws one', () => {
        const edge = { side: 'bottom', color: 'rgba(34, 34, 34, 0.04)' } as const;
        expect(resolveThemeSurfaceBorderStyle({ borderColor: 'transparent', edge })).toEqual({
            borderColor: 'transparent',
            borderWidth: 0,
            borderBottomColor: 'rgba(34, 34, 34, 0.04)',
            borderBottomWidth: StyleSheet.hairlineWidth,
        });
        expect(resolveThemeSurfaceChromeStyle({
            borderColor: 'transparent',
            edge,
            shadowStyle: { boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)' },
        })).toMatchObject({ borderWidth: 0, borderBottomWidth: StyleSheet.hairlineWidth, boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)' });
    });

    it('hands a rim surface\'s whole hairline to its rim, keeping its elevation', () => {
        expect(resolveThemeSurfaceChromeStyle({
            borderColor: 'rgba(255,255,255,0.064)',
            edge: { side: 'top', color: 'rgba(255,255,255,0.12)' },
            rim: true,
            shadowStyle: { boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)' },
        })).toEqual({
            borderColor: 'rgba(255,255,255,0.064)',
            borderWidth: 0,
            boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)',
        });
    });

    it('casts no surface shadow when the surface draws no edge at all', () => {
        expect(resolveThemeSurfaceChromeStyle({
            borderColor: 'transparent',
            edge: { side: 'bottom', color: 'rgba(0,0,0,0)' },
            shadowStyle: { boxShadow: '0 4px 12px rgba(0,0,0,0.2)' },
        })).toEqual({
            borderColor: 'transparent',
            borderWidth: 0,
            borderBottomColor: 'rgba(0,0,0,0)',
            borderBottomWidth: 0,
        });
    });
});

const { resolveThemeSurfaceBorderStyle, resolveThemeSurfaceChromeStyle } = surfaceBorderStyles;
