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

export const Typography = {
    // Default font styles (Inter, except Apple web system stack)
    default: defaultTypography,

    // Monospace font styles (IBM Plex Mono)
    mono: (weight: 'regular' | 'italic' | 'semiBold' = 'regular') => ({
        fontFamily: getMonoFont(weight),
    }),

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
