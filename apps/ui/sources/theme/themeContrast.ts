import Color from 'color';
import { compositeThemeColor, parseThemeColorValue, themeContrastRatio, type ThemeRgb } from '@happier-dev/protocol/account/settings/themeColor';

/** The surface is the already-composited paint; readable authored alpha is retained. */
export function readableThemeColorOn(color: string, surface: string | ThemeRgb, minContrast: number): string {
    const background = typeof surface === 'string' ? parseThemeColorValue(surface)?.rgb : surface;
    if (!background) throw new TypeError('A numeric theme surface is required');
    const readable = (candidate: string) => {
        const parsed = parseThemeColorValue(candidate);
        if (!parsed) throw new TypeError('A numeric theme foreground is required');
        return themeContrastRatio(compositeThemeColor(parsed, background), background) >= minContrast;
    };
    if (readable(color)) return color;

    // HSL changes preserve the authored hue and saturation. Search the actual serialized
    // 8-bit paint, so rounding cannot put the returned colour below the requested ratio.
    const source = Color(color).alpha(1).hsl();
    const lightness = source.lightness();
    const opaque = source.hex();
    if (readable(opaque)) return opaque;
    let best: Readonly<{ color: string; distance: number }> | null = null;
    for (const endpoint of [0, 100]) {
        let passing = endpoint;
        let failing = lightness;
        let candidate = source.lightness(endpoint).hex();
        if (!readable(candidate)) continue;
        // Terminate at floating-point convergence, without an arbitrary iteration budget.
        for (;;) {
            const midpoint = (passing + failing) / 2;
            if (midpoint === passing || midpoint === failing) break;
            const serialized = source.lightness(midpoint).hex();
            if (readable(serialized)) {
                passing = midpoint;
                candidate = serialized;
            } else {
                failing = midpoint;
            }
        }
        const distance = Math.abs(passing - lightness);
        if (!best || distance < best.distance) best = { color: candidate, distance };
    }
    if (!best) throw new RangeError('The requested contrast is unavailable on this surface');
    return best.color;
}
