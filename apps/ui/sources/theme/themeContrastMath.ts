/**
 * WCAG 2.x contrast math over theme token values.
 *
 * Three places in this repo need this and they had started to disagree: the R-1 gate
 * (`components/ui/theme/themeContrast.test.ts`) carried a private alpha-aware copy, the theme
 * editor (`themeProfileEditorModel.ts`) carries an alpha-BLIND one that reads
 * `rgba(52,199,89,0.12)` as opaque `#34C759`, and the press/focus gate needed a third. Rather than
 * add the third, the correct version lives here and the gates share it.
 *
 * Most `state.*.background` and dark `border.*` values are translucent, so a ratio only exists once
 * the colour is composited over the surface behind it — `contrastRatioOverLayers` is the entry
 * point that makes that explicit instead of leaving each caller to remember.
 *
 * Known divergent reader, deliberately not migrated here: the theme editor's parser. Correcting it
 * changes user-visible contrast warnings in the profile editor, which is a product decision.
 */

export type ThemeContrastColor = Readonly<{ r: number; g: number; b: number; a: number }>;

const HEX_PATTERN = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const RGB_PATTERN = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/;

export function parseThemeColor(value: string): ThemeContrastColor {
    const normalized = value.trim();

    const hex = HEX_PATTERN.exec(normalized);
    if (hex) {
        const raw = hex[1] ?? '';
        const expanded = raw.length === 3
            ? raw.split('').map((part) => `${part}${part}`).join('')
            : raw;
        return {
            r: Number.parseInt(expanded.slice(0, 2), 16),
            g: Number.parseInt(expanded.slice(2, 4), 16),
            b: Number.parseInt(expanded.slice(4, 6), 16),
            a: 1,
        };
    }

    const rgb = RGB_PATTERN.exec(normalized);
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

export function compositeThemeColorOver(source: ThemeContrastColor, backdrop: ThemeContrastColor): ThemeContrastColor {
    return {
        r: source.a * source.r + (1 - source.a) * backdrop.r,
        g: source.a * source.g + (1 - source.a) * backdrop.g,
        b: source.a * source.b + (1 - source.a) * backdrop.b,
        a: 1,
    };
}

export function withThemeColorOpacity(color: ThemeContrastColor, opacity: number): ThemeContrastColor {
    return { ...color, a: color.a * opacity };
}

/**
 * Contrast of ink that a `View`-level `opacity` has faded into the surface behind it.
 *
 * This exists because the naive form — reduce the alpha and take the ratio — silently returns the
 * UNDIMMED figure: relative luminance has no alpha term, so the fade has to be composited first.
 * That mistake makes the `opacity: pressed ? 0.7 : 1` idiom look compliant, which is precisely the
 * measurement this repo needs to get right.
 */
export function themeContrastRatioForFadedInk(params: Readonly<{
    ink: ThemeContrastColor;
    opacity: number;
    backdrop: ThemeContrastColor;
}>): number {
    const faded = compositeThemeColorOver(
        withThemeColorOpacity(params.ink, params.opacity),
        params.backdrop,
    );
    return themeContrastRatio(faded, params.backdrop);
}

/** WCAG 2.x relative luminance. */
export function themeColorRelativeLuminance(color: ThemeContrastColor): number {
    const channel = (value: number): number => {
        const normalized = value / 255;
        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

export function themeContrastRatio(left: ThemeContrastColor, right: ThemeContrastColor): number {
    const leftLuminance = themeColorRelativeLuminance(left);
    const rightLuminance = themeColorRelativeLuminance(right);
    const lighter = Math.max(leftLuminance, rightLuminance);
    const darker = Math.min(leftLuminance, rightLuminance);
    return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Ratio of `ink` against a stack of layers painted back-to-front, e.g.
 * `['#ffffff', 'rgba(52,199,89,0.12)']` = a success tint on the base surface.
 */
export function themeContrastRatioOverLayers(ink: ThemeContrastColor, layers: readonly string[]): number {
    let backdrop: ThemeContrastColor | null = null;
    for (const layer of layers) {
        const parsed = parseThemeColor(layer);
        backdrop = backdrop === null ? parsed : compositeThemeColorOver(parsed, backdrop);
    }
    if (backdrop === null) {
        throw new Error('themeContrastRatioOverLayers needs at least one backdrop layer');
    }
    return themeContrastRatio(ink, backdrop);
}
