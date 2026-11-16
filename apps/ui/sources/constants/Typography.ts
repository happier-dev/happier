import { Platform, type TextStyle } from 'react-native';
import { BUNDLED_FONTS } from './bundledFonts';
import { HAPPIER_TYPE_WEIGHT, resolveHappierTypeScale, type HappierTypeRole, type HappierTypeEmphasis } from '@happier-dev/plugin-ui/presentation/typeScale';

/**
 * Typography system for Happier app
 * 
 * Default typography: Inter on every platform
 * Monospace typography: IBM Plex Mono  
 * Logo typography: Bricolage Grotesque (specific use only)
 * 
 * Usage Examples:
 * 
 * // Default typography (Inter)
 * <Text variant="label">Regular text</Text>
 * <Text style={{ fontSize: 16, ...Typography.default('italic') }}>Italic text</Text>
 * <Text variant="label" emphasis="semiBold">Semi-bold text</Text>
 * 
 * // Monospace typography (IBM Plex Mono)
 * <Text style={{ fontSize: 14, ...Typography.mono() }}>Code text</Text>
 * <Text style={{ fontSize: 14, ...Typography.mono('italic') }}>Italic code</Text>
 * <Text style={{ fontSize: 14, ...Typography.mono('semiBold') }}>Bold code</Text>
 * 
 * // Logo typography (Bricolage Grotesque - use sparingly!)
 * // Note: Don't add fontWeight as this font is already bold
 * <Text style={{ fontSize: 28, ...Typography.logo() }}>Logo Text</Text>
 * 
 * // Alternative direct usage
 * <Text style={{ fontSize: 16, fontFamily: getDefaultFont('semiBold') }}>Direct usage</Text>
 * <Text style={{ fontSize: 14, fontFamily: getMonoFont() }}>Direct mono usage</Text>
 * <Text style={{ fontSize: 28, fontFamily: getLogoFont() }}>Direct logo usage</Text>
 */

// Font family constants
export const FontFamilies = {
    // Inter (default typography)
    default: {
        regular: BUNDLED_FONTS.inter.faces.regular.family,
        italic: BUNDLED_FONTS.inter.faces.italic.family,
        medium: BUNDLED_FONTS.inter.faces.medium.family,
        semiBold: BUNDLED_FONTS.inter.faces.semiBold.family,
        bold: BUNDLED_FONTS.inter.faces.semiBold.family,
    },

    // IBM Plex Mono (default monospace)
    mono: {
        regular: BUNDLED_FONTS.plexMono.faces.regular.family,
        italic: BUNDLED_FONTS.plexMono.faces.italic.family,
        semiBold: BUNDLED_FONTS.plexMono.faces.semiBold.family,
    },

    // Bricolage Grotesque (logo/special use only)
    logo: {
        bold: BUNDLED_FONTS.bricolage.faces.bold.family,
    },

    // Legacy fonts (keep for backward compatibility)
    legacy: {
        spaceMono: BUNDLED_FONTS.spaceMono.faces.regular.family,
        systemMono: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
};

/** Resolve authored family identifiers through the existing platform font catalog. */
export function resolveKnownFontFamily(value: string): string | null {
    const family = value.trim();
    return Object.values(FontFamilies).some(group => Object.values(group).includes(family)) ? family : null;
}

// Helper functions for easy access to font families
/**
 * Default-family weights.
 *
 * The Inter face encodes its weight and style: `medium` uses the 500 file, while
 * `semiBold` and `bold` use the 600 file on every platform.
 */
export type DefaultFontWeight = 'regular' | 'italic' | 'medium' | 'semiBold' | 'bold';
export type MonoFontWeight = 'regular' | 'italic' | 'semiBold';
export type ThemeFontKind = 'default' | 'mono';

export const DEFAULT_FONT_WEIGHTS: readonly DefaultFontWeight[] = ['regular', 'italic', 'medium', 'semiBold', 'bold'];
export const MONO_FONT_WEIGHTS: readonly MonoFontWeight[] = ['regular', 'italic', 'semiBold'];

/**
 * Web only: the CSS variable that carries a theme-held family (`theme.typography`) for one weight.
 * The theme owner (`theme/themeFontFamilyVariables.ts`) sets it on the document root; unset, the
 * `var()` fallback is the Happier family, so the rendered font is unchanged. Every text style reads
 * through it, so a family change restyles mounted text without recomputing any stylesheet.
 */
export function themeFontFamilyVariableName(kind: ThemeFontKind, weight: DefaultFontWeight | MonoFontWeight): string {
    return `--happier-font-${kind}-${weight}`;
}

/** The Happier family itself for one weight, before any theme-held family. */
export function getHappierFontFamily(kind: 'default', weight: DefaultFontWeight): string;
export function getHappierFontFamily(kind: 'mono', weight: MonoFontWeight): string;
export function getHappierFontFamily(kind: ThemeFontKind, weight: DefaultFontWeight | MonoFontWeight): string {
    if (kind === 'mono') return FontFamilies.mono[weight as MonoFontWeight];
    return FontFamilies.default[weight as DefaultFontWeight];
}

function readThroughThemeFamily(kind: ThemeFontKind, weight: DefaultFontWeight | MonoFontWeight, family: string): string {
    if (Platform.OS !== 'web') return family;
    return `var(${themeFontFamilyVariableName(kind, weight)}, ${family})`;
}

export const getDefaultFont = (weight: DefaultFontWeight = 'regular') => {
    return readThroughThemeFamily('default', weight, getHappierFontFamily('default', weight));
};

export const getMonoFont = (weight: MonoFontWeight = 'regular') => {
    return readThroughThemeFamily('mono', weight, getHappierFontFamily('mono', weight));
};

export const getLogoFont = () => {
    return FontFamilies.logo.bold;
};

// Font weight mappings for the font families
export const FontWeights = {
    regular: HAPPIER_TYPE_WEIGHT.regular,
    medium: HAPPIER_TYPE_WEIGHT.medium,
    semiBold: HAPPIER_TYPE_WEIGHT.semiBold,
    bold: HAPPIER_TYPE_WEIGHT.semiBold,
} as const;

// Style utilities for easy inline usage
function defaultTypography(
    weight: DefaultFontWeight = 'regular',
): Pick<TextStyle, 'fontFamily'> {
    return { fontFamily: getDefaultFont(weight) };
}

function tabularTypography(): Pick<TextStyle, 'fontVariant'> {
    return { fontVariant: ['tabular-nums'] };
}

function variantTypography(role: HappierTypeRole, emphasis?: HappierTypeEmphasis) {
    const { weight, ...metrics } = resolveHappierTypeScale(role, Platform.OS, emphasis);
    return { ...metrics, ...defaultTypography(weight) };
}

/** Uppercase chrome is the micro role plus the Eyebrow component's two modifiers. */
export const EYEBROW_TYPOGRAPHY: Readonly<Pick<TextStyle, 'fontFamily' | 'fontSize' | 'lineHeight' | 'letterSpacing' | 'textTransform'>> = Object.freeze({
    ...variantTypography('micro', 'semiBold'),
    letterSpacing: 0.8,
    textTransform: 'uppercase',
});

export const Typography = {
    variant: variantTypography,
    // Default font styles (Inter on every platform)
    default: defaultTypography,

    // Monospace font styles (IBM Plex Mono)
    mono: (weight: MonoFontWeight = 'regular') => ({
            fontFamily: getMonoFont(weight),
        }),

    // Tabular numbers (fontVariant: ['tabular-nums']) for jitter-free dynamic counts/times
    tabular: tabularTypography,

    // Logo font style (Bricolage Grotesque)
    logo: () => ({
        fontFamily: getLogoFont(),
    }),

    // Header text style
    header: () => ({
        ...Typography.default('semiBold'),
    }),

    // Body text style
    body: () => ({
        ...Typography.default('regular'),
    }),

    // Legacy font styles (for backward compatibility)
    legacy: {
        spaceMono: () => ({
            fontFamily: FontFamilies.legacy.spaceMono,
        }),
        systemMono: () => ({
            fontFamily: FontFamilies.legacy.systemMono,
        }),
    },
};
