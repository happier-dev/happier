/** Encoded sRGB channels in the range 0–1, before linearization. */
export type ThemeRgb = readonly [red: number, green: number, blue: number];
export type ThemeRgba = Readonly<{ rgb: ThemeRgb; alpha: number }>;

/** Portable numeric syntax admitted by theme documents; CSS expressions resolve in their host. */
export function parseThemeColorValue(value: string): ThemeRgba | null {
    const normalized = value.trim();
    if (normalized === 'transparent') return { rgb: [0, 0, 0], alpha: 0 };
    const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(normalized)?.[1];
    if (hex) {
        const expanded = hex.length <= 4 ? [...hex].map(digit => digit + digit).join('') : hex;
        return {
            rgb: [Number.parseInt(expanded.slice(0, 2), 16) / 255,
                Number.parseInt(expanded.slice(2, 4), 16) / 255,
                Number.parseInt(expanded.slice(4, 6), 16) / 255],
            alpha: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
        };
    }
    const rgb = /^rgb\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*\)$/.exec(normalized);
    const rgba = /^rgba\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*(0|1|0?\.\d+)\s*\)$/.exec(normalized);
    const match = rgb ?? rgba;
    if (!match) return null;
    const red = Number(match[1]);
    const green = Number(match[2]);
    const blue = Number(match[3]);
    const alpha = rgba ? Number(rgba[4]) : 1;
    if (red > 255 || green > 255 || blue > 255 || alpha > 1) return null;
    return { rgb: [red / 255, green / 255, blue / 255], alpha };
}

export function themeSrgbToLinear(channel: number): number {
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** Inverse of sRGB linearization, used by material solvers for neutral tones. */
export function themeLinearToSrgb(channel: number): number {
    return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

/** The first three channels are encoded sRGB; alpha policy belongs to the caller. */
export function themeRelativeLuminance(rgb: readonly number[]): number {
    return 0.2126 * themeSrgbToLinear(rgb[0]!)
        + 0.7152 * themeSrgbToLinear(rgb[1]!)
        + 0.0722 * themeSrgbToLinear(rgb[2]!);
}

export function themeContrastRatio(left: readonly number[], right: readonly number[]): number {
    const a = themeRelativeLuminance(left);
    const b = themeRelativeLuminance(right);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Source-over compositing in encoded sRGB, matching the rendered theme paint. */
export function compositeThemeColor(color: ThemeRgba, background: readonly number[]): ThemeRgb {
    return [color.rgb[0] * color.alpha + background[0]! * (1 - color.alpha),
        color.rgb[1] * color.alpha + background[1]! * (1 - color.alpha),
        color.rgb[2] * color.alpha + background[2]! * (1 - color.alpha)];
}
