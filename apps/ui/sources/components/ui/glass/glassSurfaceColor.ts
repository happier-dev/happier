import { parseThemeColor } from '@/theme/parseThemeColor';
import { deriveThemePaint, fixedThemePaint, type ThemePaint } from '@/theme/profiles/themePaint';
import { resolveGlassReadingCoatOpacity, resolveGlassSurfaceMaterial, type GlassMaterialSettings,
    type GlassSurfaceGroup, type GlassMaterialEnvironment, type GlassSurfaceMaterial } from './glassMaterial';

export type AtmosphereContentCoat = 'opaque' | 'reading';

export function resolveGlassSurfacePlaneMaterial(settings: GlassMaterialSettings, group: GlassSurfaceGroup,
    environment: GlassMaterialEnvironment = {}, coat?: AtmosphereContentCoat, dark = false): GlassSurfaceMaterial {
    if (group === 'content' && coat) {
        if (coat === 'opaque') return { blur: 'off', opacity: 1 };
        return { ...resolveGlassSurfaceMaterial(settings, group, environment).material, opacity: resolveGlassReadingCoatOpacity(settings, environment, dark) };
    }
    if (group === 'content' && (environment.atmosphereBehind === 'band' || environment.atmosphereBehind === 'wallpaper')) {
        return { blur: 'off', opacity: 0 };
    }
    return resolveGlassSurfaceMaterial(settings, group, environment).material;
}

/** Numeric renderer paint and its source share the same material decision. */
export function resolveGlassSurfacePaint(color: ThemePaint, group: GlassSurfaceGroup, settings: GlassMaterialSettings,
    environment: GlassMaterialEnvironment, tintAvailable: boolean, nested = true, translucentColor?: ThemePaint,
    plane = nested, coatOpacity?: number): ThemePaint {
    if (plane && resolveGlassSurfacePlaneMaterial(settings, group, environment).opacity === 0) return fixedThemePaint('transparent');
    if (!tintAvailable) return color;
    const { material } = resolveGlassSurfaceMaterial(settings, group, environment);
    const opacity = material.opacity === 1 ? 1 : nested ? 0 : coatOpacity ?? material.opacity;
    if (opacity === 1) return color;
    const parsed = parseThemeColor(color.color);
    if (parsed === null) return color;
    if (translucentColor !== undefined && material.opacity < 1) return parsed.alpha() < 1 ? color : translucentColor;
    return deriveThemePaint([color], value => {
        const input = parseThemeColor(value)!;
        return input.alpha(input.alpha() * opacity).hexa().toLowerCase();
    });
}

/** Existing renderer adapters keep their string API. */
export function resolveGlassSurfaceColor(color: string, group: GlassSurfaceGroup, settings: GlassMaterialSettings,
    environment: GlassMaterialEnvironment, tintAvailable: boolean, nested = true, translucentColor?: string,
    plane = nested, coatOpacity?: number): string {
    return resolveGlassSurfacePaint(fixedThemePaint(color), group, settings, environment, tintAvailable, nested,
        translucentColor === undefined ? undefined : fixedThemePaint(translucentColor), plane, coatOpacity).color;
}
