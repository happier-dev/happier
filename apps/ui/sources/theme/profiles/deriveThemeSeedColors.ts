import Color from 'color';
import { compositeThemeColor, parseThemeColorValue } from '@happier-dev/protocol/account/settings/themeColor';
import type { Theme } from '@/theme';
import { readableThemeColorOn, readableThemeColorOnSurfaces } from '@/theme/themeContrast';
import type { ThemeProfileSeeds } from '@happier-dev/protocol/account/settings/themeProfiles';

/** Palette assembly lives beside the canonical semantic propagation owner. Overrides apply last. */
export function deriveThemeSeedColors(base: Theme, seeds: ThemeProfileSeeds): Theme['colors'] {
    const canvas = Color(seeds.canvas);
    const ink = Color(base.dark ? '#ffffff' : '#000000');
    const inverse = Color(base.dark ? '#000000' : '#ffffff');
    const mix = (weight: number) => canvas.mix(ink, weight).hex();
    const baseCanvas = parseThemeColorValue(base.colors.background.canvas)!.rgb;
    const effectiveCanvas = compositeThemeColor(parseThemeColorValue(seeds.canvas)!, baseCanvas);
    const effectiveAccent = compositeThemeColor(parseThemeColorValue(seeds.accent)!, effectiveCanvas);
    let inset = canvas.mix(inverse, 0.04).hex();
    const surfaces = (insetColor: string) => [{ surface: effectiveCanvas, minContrast: 4.5 },
        { surface: compositeThemeColor(parseThemeColorValue(insetColor)!, effectiveCanvas), minContrast: 4.5 }];
    const sharedText = readableThemeColorOnSurfaces(base.colors.text.primary, surfaces(inset));
    const text = sharedText ?? readableThemeColorOn(base.colors.text.primary, effectiveCanvas, 4.5);
    // Adjacent mid-tone surfaces can admit no common ink. Adjust only the generated
    // inset paint; the person's canvas and accent seeds stay exact.
    if (sharedText === null) inset = readableThemeColorOn(inset, parseThemeColorValue(text)!.rgb, 4.5);
    const textSurfaces = surfaces(inset);
    const readableText = (color: string) => readableThemeColorOnSurfaces(color, textSurfaces) ?? text;
    return {
        ...base.colors,
        background: { ...base.colors.background, canvas: seeds.canvas },
        surface: { ...base.colors.surface, base: seeds.canvas, inset, elevated: mix(0.04), selected: mix(0.08), pressed: mix(0.12) },
        text: { ...base.colors.text, primary: text,
            secondary: readableText(Color(text).mix(canvas, 0.3).hex()),
            tertiary: readableText(Color(text).mix(canvas, 0.45).hex()) },
        border: { ...base.colors.border, default: Color(text).alpha(0.12).rgb().string(), strong: Color(text).alpha(0.2).rgb().string() },
        button: { ...base.colors.button, primary: { ...base.colors.button.primary, background: seeds.accent, tint: readableThemeColorOn(base.colors.button.primary.tint, effectiveAccent, 4.5) } },
        state: { ...base.colors.state, info: { ...base.colors.state.info, foreground: seeds.accent } },
    };
}
