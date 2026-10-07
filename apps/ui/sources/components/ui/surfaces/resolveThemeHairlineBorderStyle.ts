import type { HappierRaisedEdge } from '@happier-dev/plugin-ui/presentation';

import { Platform, StyleSheet } from 'react-native';

const THEME_HAIRLINE_WIDTH = StyleSheet.hairlineWidth || 1;
const THEME_VISIBLE_BORDER_WIDTH = Platform.OS === 'ios' ? 1 : THEME_HAIRLINE_WIDTH;

export type ThemeHairlineBorderStyle = Readonly<{
    borderColor: string;
    borderWidth: number;
}>;

/** A surface's hairline, plus the one side its raised edge recolours (top on dark, bottom on light). */
export type ThemeSurfaceBorderStyle = Readonly<{
    borderColor: string;
    borderWidth: number;
    borderTopColor?: string;
    borderTopWidth?: number;
    borderBottomColor?: string;
    borderBottomWidth?: number;
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

type ThemeSurfaceEdgeOptions = Readonly<{
    borderColor: string;
    /**
     * The raised edge of `borderColor`'s role (`resolveThemeRaisedEdge`). Omit it for chrome that must
     * stay flat, such as a rotated popover arrow, whose sides are diagonals.
     */
    edge?: HappierRaisedEdge | null;
    /**
     * The surface's role stands on the directional rim in this scheme (`surfaceUsesRim`): it draws no
     * border of its own and no flat edge, because its `SurfaceRim` draws the whole hairline.
     */
    rim?: boolean;
}>;

/**
 * A raised surface's border: the role's hairline, with one side recoloured as its raised edge. The edge
 * side keeps a hairline even where the rest of the border is invisible (a light theme's borderless
 * sheet still gets its bottom lip).
 */
export function resolveThemeSurfaceBorderStyle(options: ThemeSurfaceEdgeOptions): ThemeSurfaceBorderStyle {
    const borderStyle = resolveThemeHairlineBorderStyle(options.borderColor);
    if (options.rim === true) {
        return { borderColor: options.borderColor, borderWidth: 0 };
    }
    const edge = options.edge;
    if (!edge) return borderStyle;
    const edgeWidth = resolveThemeHairlineBorderStyle(edge.color).borderWidth || borderStyle.borderWidth;
    return edge.side === 'top'
        ? { ...borderStyle, borderTopColor: edge.color, borderTopWidth: edgeWidth }
        : { ...borderStyle, borderBottomColor: edge.color, borderBottomWidth: edgeWidth };
}

/** The surface border plus its elevation, cast only while the surface draws any edge at all. */
export function resolveThemeSurfaceChromeStyle(options: ThemeSurfaceEdgeOptions & Readonly<{
    shadowStyle: ThemeSurfaceChromeShadowStyle;
}>): ThemeSurfaceChromeStyle {
    const borderStyle = resolveThemeSurfaceBorderStyle(options);
    const hasVisibleChrome = options.rim === true
        || borderStyle.borderWidth > 0
        || (borderStyle.borderTopWidth ?? 0) > 0
        || (borderStyle.borderBottomWidth ?? 0) > 0;

    return {
        ...borderStyle,
        ...(hasVisibleChrome ? options.shadowStyle : {}),
    };
}
