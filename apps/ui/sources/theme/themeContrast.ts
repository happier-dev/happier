import Color from 'color';
import { compositeThemeColor, parseThemeColorValue, themeContrastRatio, themeRelativeLuminance, type ThemeRgb } from '@happier-dev/protocol/account/settings/themeColor';

export type ThemeContrastSurface = Readonly<{ surface: string | ThemeRgb; minContrast: number }>;

/** The surface is the already-composited paint; readable authored alpha is retained. */
export function readableThemeColorOn(color: string, surface: string | ThemeRgb, minContrast: number): string {
    const readable = readableThemeColorOnSurfaces(color, [{ surface, minContrast }]);
    if (readable === null) throw new RangeError('The requested contrast is unavailable on this surface');
    return readable;
}

/** Find one foreground for every actual surface the role paints, or leave the warning unresolved. */
export function readableThemeColorOnSurfaces(color: string, surfaces: readonly ThemeContrastSurface[]): string | null {
    const backgrounds = surfaces.map(({ surface, minContrast }) => {
        const rgb = typeof surface === 'string' ? parseThemeColorValue(surface)?.rgb : surface;
        if (!rgb) throw new TypeError('A numeric theme surface is required');
        return { rgb, minContrast };
    });
    const readable = (candidate: string) => {
        const parsed = parseThemeColorValue(candidate);
        if (!parsed) throw new TypeError('A numeric theme foreground is required');
        return backgrounds.every(({ rgb, minContrast }) => themeContrastRatio(compositeThemeColor(parsed, rgb), rgb) >= minContrast);
    };
    if (readable(color)) return color;

    // HSL changes preserve the authored hue and saturation. Search the actual serialized
    // 8-bit paint, so rounding cannot put the returned colour below the requested ratio.
    const source = Color(color).alpha(1).hsl();
    const lightness = source.lightness();
    const opaque = source.hex();
    if (readable(opaque)) return opaque;
    const luminance = (candidate: string) => themeRelativeLuminance(parseThemeColorValue(candidate)!.rgb);
    const sourceLuminance = luminance(opaque);

    // Each WCAG pair admits a dark and a light luminance interval. Their intersection
    // also covers shared ink between black and white surfaces, where neither endpoint works.
    let intervals: (readonly [number, number])[] = [[0, 1]];
    for (const { rgb, minContrast } of backgrounds) {
        const surfaceLuminance = themeRelativeLuminance(rgb);
        const darkMaximum = (surfaceLuminance + 0.05) / minContrast - 0.05;
        const lightMinimum = minContrast * (surfaceLuminance + 0.05) - 0.05;
        intervals = intervals.flatMap(([minimum, maximum]) => {
            const allowed: (readonly [number, number])[] = [];
            const darkEnd = Math.min(maximum, darkMaximum);
            const lightStart = Math.max(minimum, lightMinimum);
            if (minimum <= darkEnd) allowed.push([minimum, darkEnd]);
            if (lightStart <= maximum) allowed.push([lightStart, maximum]);
            return allowed;
        });
    }
    let best: Readonly<{ color: string; distance: number }> | null = null;
    for (const [minimum, maximum] of intervals) {
        const darken = sourceLuminance > maximum;
        const withinBoundary = (candidate: string) => darken ? luminance(candidate) <= maximum : luminance(candidate) >= minimum;
        let passing = darken ? 0 : 100;
        let failing = lightness;
        let candidate = source.lightness(passing).hex();
        // Terminate at floating-point convergence, without an arbitrary iteration budget.
        for (;;) {
            const midpoint = (passing + failing) / 2;
            if (midpoint === passing || midpoint === failing) break;
            const serialized = source.lightness(midpoint).hex();
            if (withinBoundary(serialized)) {
                passing = midpoint;
                candidate = serialized;
            } else {
                failing = midpoint;
            }
        }
        if (!readable(candidate)) continue;
        const distance = Math.abs(passing - lightness);
        if (!best || distance < best.distance) best = { color: candidate, distance };
    }
    return best?.color ?? null;
}
