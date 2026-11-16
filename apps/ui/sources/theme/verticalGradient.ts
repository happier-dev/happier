import { parseThemeColorValue, themeRelativeLuminance } from '@happier-dev/protocol/account/settings/themeColor';

type GradientColorTuple = readonly [string, string, ...string[]];

const getColorLuminance = (value: string): number | null => {
    const color = parseThemeColorValue(value);
    if (!color || value.trim() === 'transparent') return null;

    // Orientation follows authored RGB; a gradient has no single opaque backdrop for alpha compositing.
    return themeRelativeLuminance(color.rgb);
};

export const normalizeVerticalGradientColors = <TColors extends GradientColorTuple>(colors: TColors): TColors => {
    if (colors.length < 2) return colors;

    const bottomColor = colors[0];
    const topColor = colors[colors.length - 1];
    const bottomLuminance = getColorLuminance(bottomColor);
    const topLuminance = getColorLuminance(topColor);

    if (bottomLuminance === null || topLuminance === null) return colors;
    if (topLuminance >= bottomLuminance) return colors;

    return [...colors].reverse() as unknown as TColors;
};

export const createVerticalGradient = <TColors extends GradientColorTuple>(colors: TColors) => ({
    colors: normalizeVerticalGradientColors(colors),
    start: { x: 0.5, y: 1 },
    end: { x: 0.5, y: 0 },
} as const);
