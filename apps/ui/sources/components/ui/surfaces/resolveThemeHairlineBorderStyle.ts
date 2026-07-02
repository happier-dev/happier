import { Platform, StyleSheet } from 'react-native';

const THEME_HAIRLINE_WIDTH = StyleSheet.hairlineWidth || 1;
const THEME_VISIBLE_BORDER_WIDTH = Platform.OS === 'ios' ? 1 : THEME_HAIRLINE_WIDTH;

export type ThemeHairlineBorderStyle = Readonly<{
    borderColor: string;
    borderWidth: number;
}>;

export type ThemeSurfaceBorderStyle = Readonly<{
    borderColor: string;
    borderWidth: number;
    borderTopColor: string;
    borderTopWidth: number;
}>;

export type ThemeSurfaceChromeShadowStyle = Partial<Readonly<{
    boxShadow?: string;
    shadowColor: string;
    shadowOffset: Readonly<{ width: number; height: number }>;
    shadowOpacity: number;
    shadowRadius: number;
    elevation: number;
}>>;

export type ThemeSurfaceChromeStyle = ThemeSurfaceBorderStyle & ThemeSurfaceChromeShadowStyle;

function parseAlpha(rawAlpha: string | undefined): number | null {
    if (typeof rawAlpha !== 'string') return null;
    const trimmed = rawAlpha.trim();
    if (!trimmed) return null;
    if (trimmed.endsWith('%')) {
        const percent = Number.parseFloat(trimmed.slice(0, -1));
        return Number.isFinite(percent) ? percent / 100 : null;
    }
    const value = Number.parseFloat(trimmed);
    return Number.isFinite(value) ? value : null;
}

function extractFunctionalAlpha(normalizedColor: string): number | null {
    const match = normalizedColor.match(/^(?:rgb|hsl)a?\((.*)\)$/);
    if (!match) return null;
    const body = match[1]?.trim() ?? '';
    if (!body) return null;

    const slashIndex = body.lastIndexOf('/');
    if (slashIndex >= 0) {
        return parseAlpha(body.slice(slashIndex + 1));
    }

    const commaParts = body.split(',');
    if (commaParts.length >= 4) {
        return parseAlpha(commaParts[3]);
    }

    return null;
}

function isAlphaZeroColor(color: string): boolean {
    const normalized = color.trim().toLowerCase();
    if (!normalized) return true;
    if (normalized === 'transparent') return true;

    if (/^#[0-9a-f]{4}$/.test(normalized)) {
        return normalized[4] === '0';
    }
    if (/^#[0-9a-f]{8}$/.test(normalized)) {
        return normalized.slice(7, 9) === '00';
    }

    const alpha = extractFunctionalAlpha(normalized);
    return alpha !== null && alpha <= 0;
}

export function resolveThemeHairlineBorderStyle(color: string): ThemeHairlineBorderStyle {
    return {
        borderColor: color,
        borderWidth: isAlphaZeroColor(color) ? 0 : THEME_VISIBLE_BORDER_WIDTH,
    };
}

export function resolveThemeSurfaceBorderStyle(options: Readonly<{
    borderColor: string;
    highlightColor: string;
}>): ThemeSurfaceBorderStyle {
    const borderStyle = resolveThemeHairlineBorderStyle(options.borderColor);
    const borderWidth = borderStyle.borderWidth;

    return {
        ...borderStyle,
        borderTopColor: borderStyle.borderColor,
        borderTopWidth: borderWidth,
    };
}

export function resolveThemeSurfaceChromeStyle(options: Readonly<{
    borderColor: string;
    highlightColor: string;
    shadowStyle: ThemeSurfaceChromeShadowStyle;
}>): ThemeSurfaceChromeStyle {
    const borderStyle = resolveThemeSurfaceBorderStyle({
        borderColor: options.borderColor,
        highlightColor: options.highlightColor,
    });
    const highlightStyle = resolveThemeHairlineBorderStyle(options.highlightColor);
    const hasVisibleChrome = borderStyle.borderWidth > 0 || highlightStyle.borderWidth > 0;

    return {
        ...borderStyle,
        ...(hasVisibleChrome ? options.shadowStyle : {}),
    };
}
