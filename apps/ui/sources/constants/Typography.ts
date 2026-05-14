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
        semiBold: 'Inter-SemiBold',
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
export const getDefaultFont = (weight: 'regular' | 'italic' | 'semiBold' = 'regular') => {
    if (shouldPreferAppleSystemFontOnWeb()) {
        return APPLE_WEB_SYSTEM_FONT_STACK;
    }
    return FontFamilies.default[weight];
};

export const getMonoFont = (weight: 'regular' | 'italic' | 'semiBold' = 'regular') => {
    return FontFamilies.mono[weight];
};

export const getLogoFont = () => {
    return FontFamilies.logo.bold;
};

// Font weight mappings for the font families
export const FontWeights = {
    regular: '400',
    semiBold: '500',
    bold: '600',
} as const;

// Style utilities for easy inline usage
function defaultTypography(): Pick<TextStyle, 'fontFamily'>;
function defaultTypography(weight: 'regular'): Pick<TextStyle, 'fontFamily'>;
function defaultTypography(weight: 'italic'): Pick<TextStyle, 'fontFamily' | 'fontStyle'>;
function defaultTypography(weight: 'semiBold'): Pick<TextStyle, 'fontFamily' | 'fontWeight'>;
function defaultTypography(
    weight?: 'regular' | 'italic' | 'semiBold',
): Pick<TextStyle, 'fontFamily' | 'fontStyle' | 'fontWeight'>;
function defaultTypography(
    weight: 'regular' | 'italic' | 'semiBold' = 'regular',
): Pick<TextStyle, 'fontFamily' | 'fontStyle' | 'fontWeight'> {
    // Native iOS: prefer the system font (SF). We omit `fontFamily` so RN uses the platform default.
    if (Platform.OS === 'ios') {
        if (weight === 'italic') {
            return { fontStyle: 'italic' };
        }
        if (weight === 'semiBold') {
            return { fontWeight: FontWeights.semiBold };
        }
        return {};
    }

    const fontFamily = getDefaultFont(weight);

    // Keep existing Inter behavior (family encodes weight/style).
    if (fontFamily !== APPLE_WEB_SYSTEM_FONT_STACK) {
        return { fontFamily };
    }

    // Apple web: use system stack + explicit weight/style when needed.
    if (weight === 'italic') {
        return { fontFamily, fontStyle: 'italic' };
    }
    if (weight === 'semiBold') {
        return { fontFamily, fontWeight: FontWeights.semiBold };
    }
    return { fontFamily };
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
    mono: (weight: 'regular' | 'italic' | 'semiBold' = 'regular') => ({
            fontFamily: getMonoFont(weight),
        }),

    // Tabular numbers (fontVariant: ['tabular-nums']) for jitter-free dynamic counts/times
    tabular: tabularTypography,

    // Uppercase, tracked section/kicker labels (non-editable typography primitive)
    eyebrow: eyebrowTypography,

    // Standard two-tier row rhythm (non-editable typography primitives)
    rowTitle: rowTitleTypography,
    rowMeta: rowMetaTypography,

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
