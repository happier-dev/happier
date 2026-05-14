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

    it('keeps the surface border uniform when highlight is transparent', () => {
        expect(surfaceBorderStyles.resolveThemeSurfaceBorderStyle).toBeTypeOf('function');
        if (typeof surfaceBorderStyles.resolveThemeSurfaceBorderStyle !== 'function') return;

        expect(resolveThemeSurfaceBorderStyle({
            borderColor: 'rgba(0,0,0,0.08)',
            highlightColor: 'transparent',
        })).toEqual({
            borderColor: 'rgba(0,0,0,0.08)',
            borderWidth: StyleSheet.hairlineWidth,
            borderTopColor: 'rgba(0,0,0,0.08)',
            borderTopWidth: StyleSheet.hairlineWidth,
        });
    });

    it('keeps the top border color aligned with the rest of the surface border', () => {
        expect(surfaceBorderStyles.resolveThemeSurfaceBorderStyle).toBeTypeOf('function');
        if (typeof surfaceBorderStyles.resolveThemeSurfaceBorderStyle !== 'function') return;

        expect(resolveThemeSurfaceBorderStyle({
            borderColor: 'rgba(255,255,255,0.07)',
            highlightColor: 'rgba(255,255,255,0.04)',
        })).toEqual({
            borderColor: 'rgba(255,255,255,0.07)',
            borderWidth: StyleSheet.hairlineWidth,
            borderTopColor: 'rgba(255,255,255,0.07)',
            borderTopWidth: StyleSheet.hairlineWidth,
        });
    });

    it('does not add surface shadow when surface chrome colors are transparent', () => {
        expect(surfaceBorderStyles.resolveThemeSurfaceChromeStyle).toBeTypeOf('function');
        if (typeof surfaceBorderStyles.resolveThemeSurfaceChromeStyle !== 'function') return;

        expect(resolveThemeSurfaceChromeStyle({
            borderColor: 'transparent',
            highlightColor: 'rgba(255,255,255,0)',
            shadowStyle: { boxShadow: '0 4px 12px rgba(0,0,0,0.2)' },
        })).toEqual({
            borderColor: 'transparent',
            borderWidth: 0,
            borderTopColor: 'transparent',
            borderTopWidth: 0,
        });
    });

    it('adds surface shadow when surface chrome colors are visible', () => {
        expect(surfaceBorderStyles.resolveThemeSurfaceChromeStyle).toBeTypeOf('function');
        if (typeof surfaceBorderStyles.resolveThemeSurfaceChromeStyle !== 'function') return;

        expect(resolveThemeSurfaceChromeStyle({
            borderColor: 'rgba(0,0,0,0.08)',
            highlightColor: 'rgba(255,255,255,0.04)',
            shadowStyle: { boxShadow: '0 4px 12px rgba(0,0,0,0.2)' },
        })).toEqual({
            borderColor: 'rgba(0,0,0,0.08)',
            borderWidth: StyleSheet.hairlineWidth,
            borderTopColor: 'rgba(0,0,0,0.08)',
            borderTopWidth: StyleSheet.hairlineWidth,
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
        });
    });
});

function resolveThemeSurfaceBorderStyle(options: {
    borderColor: string;
    highlightColor: string;
}) {
    if (typeof surfaceBorderStyles.resolveThemeSurfaceBorderStyle !== 'function') {
        throw new TypeError('resolveThemeSurfaceBorderStyle is not available');
    }
    return surfaceBorderStyles.resolveThemeSurfaceBorderStyle(options);
}

function resolveThemeSurfaceChromeStyle(options: {
    borderColor: string;
    highlightColor: string;
    shadowStyle: Record<string, unknown>;
}) {
    if (typeof surfaceBorderStyles.resolveThemeSurfaceChromeStyle !== 'function') {
        throw new TypeError('resolveThemeSurfaceChromeStyle is not available');
    }
    return surfaceBorderStyles.resolveThemeSurfaceChromeStyle(options);
}
