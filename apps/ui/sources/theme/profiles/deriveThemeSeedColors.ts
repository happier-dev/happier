import Color from 'color';
import { compositeThemeColor, parseThemeColorValue, themeContrastRatio, type ThemeRgb } from '@happier-dev/protocol/account/settings/themeColor';
import type { Theme } from '@/theme';
import type { ThemeProfileSeeds } from '@happier-dev/protocol/account/settings/themeProfiles';

/** Palette assembly lives beside the canonical semantic propagation owner. Overrides apply last. */
export function deriveThemeSeedColors(base: Theme, seeds: ThemeProfileSeeds): Theme['colors'] {
    const canvas = Color(seeds.canvas);
    const ink = Color(base.dark ? '#ffffff' : '#000000');
    const inverse = Color(base.dark ? '#000000' : '#ffffff');
    const mix = (weight: number) => canvas.mix(ink, weight).hex();
    const baseCanvas = parseThemeColorValue(base.colors.background.canvas)!.rgb;
    const effectiveCanvas = compositeThemeColor(parseThemeColorValue(seeds.canvas)!, baseCanvas);
    const readable = (background: string, backing: ThemeRgb) => {
        const parsed = parseThemeColorValue(background);
        if (!parsed) return base.colors.text.primary;
        const effective = compositeThemeColor(parsed, backing);
        return themeContrastRatio(effective, [0, 0, 0]) >= themeContrastRatio(effective, [1, 1, 1]) ? '#000000' : '#ffffff';
    };
    const text = readable(seeds.canvas, baseCanvas);
    return {
        ...base.colors,
        background: { ...base.colors.background, canvas: seeds.canvas },
        surface: { ...base.colors.surface, base: seeds.canvas, inset: canvas.mix(inverse, 0.04).hex(), elevated: mix(0.04), selected: mix(0.08), pressed: mix(0.12) },
        text: { ...base.colors.text, primary: text, secondary: Color(text).mix(canvas, 0.3).hex(), tertiary: Color(text).mix(canvas, 0.45).hex() },
        border: { ...base.colors.border, default: Color(text).alpha(0.12).rgb().string(), strong: Color(text).alpha(0.2).rgb().string() },
        button: { ...base.colors.button, primary: { ...base.colors.button.primary, background: seeds.accent, tint: readable(seeds.accent, effectiveCanvas) } },
        state: { ...base.colors.state, info: { ...base.colors.state.info, foreground: seeds.accent } },
    };
}
