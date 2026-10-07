import { Platform, type TextStyle } from 'react-native';

/**
 * Typography system for Happier app
 * 
 * Default typography: Inter (except Apple web, where we prefer the system font stack)
 * Monospace typography: IBM Plex Mono  
 * Logo typography: Bricolage Grotesque (specific use only)
 * 
 * Usage Examples:
 * 
 * // Default typography (Inter)
 * <Text style={{ fontSize: 16, ...Typography.default() }}>Regular text</Text>
 * <Text style={{ fontSize: 16, ...Typography.default('italic') }}>Italic text</Text>
 * <Text style={{ fontSize: 16, ...Typography.default('semiBold') }}>Semi-bold text</Text>
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

const APPLE_WEB_SYSTEM_FONT_STACK =
    "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', system-ui, sans-serif";

function shouldPreferAppleSystemFontOnWeb(): boolean {
    if (Platform.OS !== 'web') return false;
    if (typeof navigator === 'undefined') return false;
    const ua = typeof navigator.userAgent === 'string' ? navigator.userAgent : '';
    // Matches macOS and iOS (including iPadOS desktop-mode UAs that report Macintosh).
    return /Macintosh|iPhone|iPad|iPod/i.test(ua);
}

// Font family constants
export const FontFamilies = {
    // Inter (default typography)
    default: {
        regular: 'Inter-Regular',
        italic: 'Inter-Italic',
        medium: 'Inter-Medium',
        semiBold: 'Inter-SemiBold',
        bold: 'Inter-SemiBold',
    },

    // IBM Plex Mono (default monospace)
    mono: {
        regular: 'IBMPlexMono-Regular',
        italic: 'IBMPlexMono-Italic',
        semiBold: 'IBMPlexMono-SemiBold',
    },

    // Bricolage Grotesque (logo/special use only)
    logo: {
        bold: 'BricolageGrotesque-Bold',
    },

    // Legacy fonts (keep for backward compatibility)
    legacy: {
        spaceMono: 'SpaceMono',
        systemMono: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
};

// Helper functions for easy access to font families
/**
 * Default-family weights.
 *
 * `semiBold` predates the others and is intentionally left as it was (Inter 600 file, but 500 on
 * Apple, which renders SF noticeably heavier). `medium` is a true 500 everywhere and is the weight of
 * row titles; `bold` is a true 600 everywhere and is the weight of page and section headings, so the
 * heading/row hierarchy holds on every platform instead of collapsing to 500/500 on Apple.
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
    if (shouldPreferAppleSystemFontOnWeb()) return APPLE_WEB_SYSTEM_FONT_STACK;
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
    regular: '400',
    medium: '500',
    semiBold: '500',
    bold: '600',
} as const;

// Style utilities for easy inline usage
function defaultTypography(): Pick<TextStyle, 'fontFamily'>;
function defaultTypography(weight: 'regular'): Pick<TextStyle, 'fontFamily'>;
function defaultTypography(weight: 'italic'): Pick<TextStyle, 'fontFamily' | 'fontStyle'>;
function defaultTypography(weight: 'medium' | 'semiBold' | 'bold'): Pick<TextStyle, 'fontFamily' | 'fontWeight'>;
function defaultTypography(
    weight?: DefaultFontWeight,
): Pick<TextStyle, 'fontFamily' | 'fontStyle' | 'fontWeight'>;
function defaultTypography(
    weight: DefaultFontWeight = 'regular',
): Pick<TextStyle, 'fontFamily' | 'fontStyle' | 'fontWeight'> {
    // Native iOS: prefer the system font (SF). We omit `fontFamily` so RN uses the platform default.
    if (Platform.OS === 'ios') {
        if (weight === 'italic') {
            return { fontStyle: 'italic' };
        }
        if (weight === 'regular') return {};
        return { fontWeight: FontWeights[weight] };
    }

    const fontFamily = getDefaultFont(weight);

    // Keep existing Inter behavior (family encodes weight/style).
    if (!shouldPreferAppleSystemFontOnWeb()) {
        return { fontFamily };
    }

    // Apple web: use system stack + explicit weight/style when needed.
    if (weight === 'italic') {
        return { fontFamily, fontStyle: 'italic' };
    }
    if (weight === 'regular') return { fontFamily };
    return { fontFamily, fontWeight: FontWeights[weight] };
}

function tabularTypography(): Pick<TextStyle, 'fontVariant'> {
    return { fontVariant: ['tabular-nums'] };
}

function eyebrowTypography(): Pick<TextStyle, 'fontFamily' | 'fontWeight' | 'fontSize' | 'lineHeight' | 'letterSpacing' | 'textTransform'> {
    return {
        ...defaultTypography('semiBold'),
        fontSize: Platform.select({ ios: 11, default: 12 }),
        lineHeight: Platform.select({ ios: 14, default: 16 }),
        letterSpacing: 0.8,
        textTransform: 'uppercase',
    };
}

function rowTitleTypography(): Pick<TextStyle, 'fontFamily' | 'fontWeight' | 'fontSize' | 'lineHeight' | 'letterSpacing'> {
    return {
        ...defaultTypography('semiBold'),
        fontSize: Platform.select({ ios: 15, default: 14 }),
        lineHeight: Platform.select({ ios: 20, default: 18 }),
        letterSpacing: Platform.select({ ios: -0.12, default: -0.08 }),
    };
}

function rowMetaTypography(): Pick<TextStyle, 'fontFamily' | 'fontSize' | 'lineHeight' | 'letterSpacing'> {
    return {
        ...defaultTypography('regular'),
        fontSize: Platform.select({ ios: 13, default: 12 }),
        lineHeight: Platform.select({ ios: 17, default: 16 }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0 }),
    };
}

/**
 * Reading prose — a detail's ask, a summary, a step's body: text that is read rather than scanned, a step
 * above the row meta line (lab c7 `.body`, 14/21) and below the row title in weight.
 */
function readingTypography(): Pick<TextStyle, 'fontFamily' | 'fontWeight' | 'fontSize' | 'lineHeight' | 'letterSpacing'> {
    return {
        ...defaultTypography('regular'),
        fontSize: Platform.select({ ios: 15, default: 14 }),
        lineHeight: Platform.select({ ios: 22, default: 21 }),
        letterSpacing: Platform.select({ ios: -0.12, default: -0.08 }),
    };
}

function pillLabelTypography(): Pick<TextStyle, 'fontFamily' | 'fontWeight' | 'fontSize' | 'lineHeight' | 'letterSpacing'> {
    return {
        ...defaultTypography('semiBold'),
        fontSize: Platform.select({ ios: 11, default: 10 }),
        lineHeight: Platform.select({ ios: 14, default: 12 }),
        letterSpacing: 0.2,
    };
}

function keyHintTypography(): Pick<TextStyle, 'fontFamily' | 'fontSize' | 'lineHeight' | 'fontVariant'> {
    return {
        ...Typography.mono(),
        ...tabularTypography(),
        fontSize: Platform.select({ ios: 12, default: 11 }),
        lineHeight: Platform.select({ ios: 16, default: 14 }),
    };
}

function timestampTypography(): Pick<TextStyle, 'fontFamily' | 'fontSize' | 'lineHeight' | 'fontVariant'> {
    return {
        ...defaultTypography('regular'),
        ...tabularTypography(),
        fontSize: Platform.select({ ios: 12, default: 11 }),
        lineHeight: Platform.select({ ios: 16, default: 14 }),
    };
}

export const Typography = {
    // Default font styles (Inter, except Apple web system stack)
    default: defaultTypography,

    // Monospace font styles (IBM Plex Mono)
    mono: (weight: MonoFontWeight = 'regular') => ({
            fontFamily: getMonoFont(weight),
        }),

    // Tabular numbers (fontVariant: ['tabular-nums']) for jitter-free dynamic counts/times
    tabular: tabularTypography,

    // Uppercase, tracked section/kicker labels (non-editable typography primitive)
    eyebrow: eyebrowTypography,

    // Standard two-tier row rhythm (non-editable typography primitives)
    rowTitle: rowTitleTypography,
    rowMeta: rowMetaTypography,

    // Reading prose (detail bodies, summaries, story steps)
    reading: readingTypography,

    // Compact label primitives for status pills and keyboard hints
    pillLabel: pillLabelTypography,
    keyHint: keyHintTypography,
    timestamp: timestampTypography,

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
