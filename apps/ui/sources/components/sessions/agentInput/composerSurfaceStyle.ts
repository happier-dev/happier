import { fixedThemePaint, tokenThemePaint, type ThemePaint } from '@/theme/profiles/themePaint';

export type ComposerSurfaceStyle = 'standard' | 'glass';

type ComposerPaintTheme = Readonly<{ colors: Readonly<{
    input: Readonly<{ background: string }>;
    glass: Readonly<{ composerSurface: string }>;
}> }>;

/** The selected solid input; embedded/custom hosts own the visible coat themselves. */
export function resolveComposerSurfacePaint(input: Readonly<{
    theme: ComposerPaintTheme;
    glass: boolean;
    embedded: boolean;
    customBackground?: unknown;
    glassPaint?: ThemePaint;
}>): ThemePaint {
    const paint = input.glass ? input.glassPaint ?? fixedThemePaint(input.theme.colors.glass.composerSurface)
        : tokenThemePaint(input.theme, 'control.input.background');
    return input.embedded || input.customBackground !== undefined ? fixedThemePaint(paint.color) : paint;
}

/**
 * Whether the composer should render with the opt-in "glass" surface — the
 * Liquid Glass tab bar's solid look (a `surface.base` fill + the tab bar's
 * stronger cast shadow) — rather than the default glass surface (a near-white
 * fill + a softer shadow).
 *
 * Both surfaces share the glass rim + inset depth and are fully solid, so this
 * applies on every platform (no native-blur dependency).
 */
export function isGlassComposerSurface(params: {
    setting: ComposerSurfaceStyle | undefined;
}): boolean {
    return params.setting === 'glass';
}
