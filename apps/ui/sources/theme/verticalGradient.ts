type GradientColorTuple = readonly [string, string, ...string[]];

const parseColorChannel = (value: string): number | null => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 255) return null;
    return Math.round(parsed);
};

const parseColor = (value: string): Readonly<{ red: number; green: number; blue: number }> | null => {
    const normalized = value.trim();
    if (/^#([0-9a-fA-F]{3,8})$/.test(normalized)) {
        const hex = normalized.slice(1);
        const expanded = hex.length === 3 || hex.length === 4
            ? hex.split('').map((character) => `${character}${character}`).join('')
            : hex;
        if (expanded.length < 6) return null;
        const red = Number.parseInt(expanded.slice(0, 2), 16);
        const green = Number.parseInt(expanded.slice(2, 4), 16);
        const blue = Number.parseInt(expanded.slice(4, 6), 16);
        if ([red, green, blue].some((channel) => Number.isNaN(channel))) return null;
        return { red, green, blue };
    }

    const rgbMatch = /^rgba?\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/.exec(normalized);
    if (!rgbMatch) return null;

    const red = parseColorChannel(rgbMatch[1]);
    const green = parseColorChannel(rgbMatch[2]);
    const blue = parseColorChannel(rgbMatch[3]);
    if (red === null || green === null || blue === null) return null;

    return { red, green, blue };
};

const getColorLuminance = (value: string): number | null => {
    const color = parseColor(value);
    if (!color) return null;

    const [red, green, blue] = [color.red, color.green, color.blue].map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });

    return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
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
