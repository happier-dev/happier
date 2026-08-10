import { describe, expect, it } from 'vitest';

import { darkTheme, lightTheme } from '@/theme';
import { resolveThemeProfile } from '@/theme/profiles/resolveThemeProfile';
import type { ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import {
    getEditableThemeColorTokenDefinition,
    resolveThemeColorTokenBaseValue,
} from '@/theme/tokens/themeColorTokenDefinitions';

/**
 * R-1 gate: text rendered on a `state.<variant>.background` tint must clear WCAG 2.2 AA (4.5:1).
 *
 * This file asserts the `onTint` role only. It deliberately says nothing about
 * `state.<variant>.foreground`, which tints glyphs, icons and borders across ~300 non-tinted
 * call sites and is out of scope for this contract.
 */
const WCAG_AA_MIN_RATIO = 4.5;

const STATE_VARIANTS = ['success', 'warning', 'danger', 'info', 'neutral', 'active'] as const;

/**
 * Four of the six `state.*.background` values are translucent, so a ratio only exists once the
 * tint is composited over something. These are the surface tokens the app can paint behind a
 * tinted status chip: the content surfaces plus the two persistent/transient row fills. The
 * darkest light surface and the lightest dark surface are the binding cases.
 */
const COMPOSITE_SURFACE_TOKEN_IDS = [
    'surface.base',
    'background.canvas',
    'surface.inset',
    'surface.elevated',
    'surface.selected',
    'surface.pressed',
] as const;

const THEMES = [
    ['light', lightTheme],
    ['dark', darkTheme],
] as const;

type Rgba = Readonly<{ r: number; g: number; b: number; a: number }>;

function parseColor(value: string): Rgba {
    const normalized = value.trim();
    const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(normalized);
    if (hex) {
        const raw = hex[1] ?? '';
        const expanded = raw.length === 3 ? raw.split('').map((part) => `${part}${part}`).join('') : raw;
        return {
            r: Number.parseInt(expanded.slice(0, 2), 16),
            g: Number.parseInt(expanded.slice(2, 4), 16),
            b: Number.parseInt(expanded.slice(4, 6), 16),
            a: 1,
        };
    }

    const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(normalized);
    if (!rgb) {
        throw new Error(`Unsupported color value for a contrast pairing: ${value}`);
    }

    return {
        r: Number(rgb[1]),
        g: Number(rgb[2]),
        b: Number(rgb[3]),
        a: rgb[4] === undefined ? 1 : Number(rgb[4]),
    };
}

function compositeOver(source: Rgba, backdrop: Rgba): Rgba {
    return {
        r: source.a * source.r + (1 - source.a) * backdrop.r,
        g: source.a * source.g + (1 - source.a) * backdrop.g,
        b: source.a * source.b + (1 - source.a) * backdrop.b,
        a: 1,
    };
}

/** WCAG 2.x relative luminance. */
function relativeLuminance(color: Rgba): number {
    const channel = (value: number): number => {
        const normalized = value / 255;
        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function contrastRatio(left: Rgba, right: Rgba): number {
    const leftLuminance = relativeLuminance(left);
    const rightLuminance = relativeLuminance(right);
    const lighter = Math.max(leftLuminance, rightLuminance);
    const darker = Math.min(leftLuminance, rightLuminance);
    return (lighter + 0.05) / (darker + 0.05);
}

function readToken(theme: typeof lightTheme, tokenId: string): string {
    const value = resolveThemeColorTokenBaseValue(theme, tokenId);
    if (value === undefined) {
        throw new Error(`Theme color token "${tokenId}" is not registered or does not resolve to a color`);
    }
    return value;
}

describe('state tint contrast (R-1)', () => {
    for (const [themeName, theme] of THEMES) {
        for (const variant of STATE_VARIANTS) {
            it(`${themeName}: state.${variant}.onTint reads at AA on state.${variant}.background`, () => {
                const ink = parseColor(readToken(theme, `state.${variant}.onTint`));
                const tint = parseColor(readToken(theme, `state.${variant}.background`));

                for (const surfaceTokenId of COMPOSITE_SURFACE_TOKEN_IDS) {
                    const surface = parseColor(readToken(theme, surfaceTokenId));
                    const ratio = contrastRatio(ink, compositeOver(tint, surface));

                    expect(
                        Number(ratio.toFixed(2)),
                        `state.${variant}.onTint on state.${variant}.background over ${surfaceTokenId}`,
                    ).toBeGreaterThanOrEqual(WCAG_AA_MIN_RATIO);
                }
            });
        }
    }

    for (const variant of STATE_VARIANTS) {
        it(`registers state.${variant}.onTint against its own tint`, () => {
            expect(getEditableThemeColorTokenDefinition(`state.${variant}.onTint`)?.contrastPairs).toEqual([
                { tokenId: `state.${variant}.background`, minRatio: WCAG_AA_MIN_RATIO },
            ]);
        });
    }
});

describe('state tint ink under theme profiles', () => {
    const buildProfile = (overrides: Record<string, string>): ThemeProfileV1 => ({
        schemaVersion: 1,
        id: 'contrast-spec-profile',
        name: 'Contrast spec profile',
        createdAt: '2026-08-10T00:00:00.000Z',
        updatedAt: '2026-08-10T00:00:00.000Z',
        base: { light: 'light', dark: 'dark' },
        overrides: { light: overrides, dark: {} },
    });

    it('follows a profile that re-tunes the state foreground, so a pill label keeps the profile hue', () => {
        const theme = resolveThemeProfile({
            mode: 'light',
            profile: buildProfile({ 'state.success.foreground': '#0F5132' }),
        });

        expect(theme.colors.state.success.onTint).toBe('#0F5132');
    });

    it('prefers an explicit onTint override over the profile foreground', () => {
        const theme = resolveThemeProfile({
            mode: 'light',
            profile: buildProfile({
                'state.success.foreground': '#0F5132',
                'state.success.onTint': '#14532D',
            }),
        });

        expect(theme.colors.state.success.onTint).toBe('#14532D');
    });

    it('keeps the canonical onTint when a profile leaves the state hue alone', () => {
        const theme = resolveThemeProfile({
            mode: 'light',
            profile: buildProfile({ 'surface.base': '#FEFEFE' }),
        });

        expect(lightTheme.colors.state.success.onTint).toEqual(expect.any(String));
        expect(theme.colors.state.success.onTint).toBe(lightTheme.colors.state.success.onTint);
    });
});
