import { fixedThemePaint, tokenThemePaint, type ThemePaint } from '@/theme/profiles/themePaint';
import type { Theme } from '@/theme';
import { resolveGlassSurfaceCompositionPaint, type GlassSurfaceCompositionContext } from '@/components/ui/glass/glassSurfacePaint';
export type { GlassSurfaceCompositionContext } from '@/components/ui/glass/glassSurfacePaint';

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

export function resolveComposerMaterialPaint(input: Parameters<typeof resolveComposerSurfacePaint>[0] & Readonly<{
    theme: Theme;
    material?: GlassSurfaceCompositionContext;
}>): ThemePaint {
    const solid = resolveComposerSurfacePaint(input);
    if (!input.material || input.embedded || input.customBackground !== undefined) return fixedThemePaint(solid.color);
    const result = resolveGlassSurfaceCompositionPaint({ solid, page: tokenThemePaint(input.theme, 'surface.base'),
        ink: tokenThemePaint(input.theme, 'text.primary'), controlFill: tokenThemePaint(input.theme, 'surface.selected'),
        dark: input.theme.dark, context: input.material });
    return result.coat ?? result.background;
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
