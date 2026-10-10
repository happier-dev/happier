import * as React from 'react';
import { Platform } from 'react-native';
import Color from 'color';
import { useUnistyles } from 'react-native-unistyles';

import { resolveGlassBackdropTone, resolveGlassSurfaceMaterial, type GlassMaterialEnvironment, type GlassMaterialSettings, type GlassSurfaceGroup } from './glassMaterial';
import { useGlassMaterialSettings } from './useGlassMaterialSettings';
import { useGlassRuntimeEnvironment } from './glassRuntimeEnvironment';
import { glassSurfaceTintColor } from './glassSurfacePaint';
import { resolveGlassCapability } from './resolveGlassCapability';
import { getBlurViewComponent } from './blurMaterial';
import { getGlassViewComponent, useLiquidGlassAvailable } from './liquidGlass';
import { readGlassDocumentColor } from './glassDocumentPresentation';

/** Renderer SDKs need concrete colors rather than CSS material variables. */
export function resolveGlassSurfaceColor(color: string, group: GlassSurfaceGroup, settings: GlassMaterialSettings, environment: GlassMaterialEnvironment, tintAvailable: boolean, nested = true, translucentColor?: string): string {
    if (!tintAvailable) return color;
    const { material } = resolveGlassSurfaceMaterial(settings, group, environment);
    const opacity = nested && material.opacity < 1 ? 0 : material.opacity;
    if (opacity === 1) return color;
    const concreteColor = color.trim().startsWith('var(')
        ? typeof document === 'undefined' ? null : readGlassDocumentColor(document, color)
        : color;
    if (concreteColor === null) return color;
    const parsed = Color(concreteColor);
    if (translucentColor !== undefined && material.opacity < 1) {
        return parsed.alpha() < 1 ? color : translucentColor;
    }
    return parsed.alpha(parsed.alpha() * opacity).hexa().toLowerCase();
}

export function useGlassSurfaceColor(color: string, group: GlassSurfaceGroup, nested = true, tintAvailable?: boolean): string {
    const { theme } = useUnistyles();
    const settings = useGlassMaterialSettings();
    const environment = useGlassRuntimeEnvironment();
    const liquidGlassAvailable = useLiquidGlassAvailable();
    // Outer arrows/fades/container paint follows the same capability and SDK loaders as GlassSurface.
    const capability = resolveGlassCapability({ ...environment, settings, surfaceGroup: group, liquidGlassAvailable,
        blurAvailable: Platform.OS === 'ios', webBlurAvailable: Platform.OS === 'web', reduceTransparency: environment.reduceTransparency === true });
    const available = tintAvailable ?? (Platform.OS === 'web' || Platform.OS === 'android'
        || (capability === 'blur' && getBlurViewComponent() !== null)
        || (capability === 'liquidGlass' && getGlassViewComponent() !== null));
    const tint = nested || !available ? color : glassSurfaceTintColor({ color, ink: theme.colors.text.primary, dark: theme.dark, settings, group, environment });
    return React.useMemo(() => resolveGlassSurfaceColor(tint, group, settings, environment, available, nested), [tint, group, settings, environment, nested, available]);
}

/** Independent arrow paint consumes the same static backdrop treatment as its surface. */
export function useGlassSurfaceBackdropTone(group: GlassSurfaceGroup): string {
    const { theme } = useUnistyles();
    const settings = useGlassMaterialSettings();
    const environment = useGlassRuntimeEnvironment();
    return resolveGlassBackdropTone(settings, group, theme.dark, environment);
}

/** Native controls share their containing material; SDK adapters need its concrete paint. */
export function useGlassMaterialColorResolver(containingGroup: GlassSurfaceGroup | null = null) {
    const settings = useGlassMaterialSettings();
    const environment = useGlassRuntimeEnvironment();
    return React.useCallback((input: Readonly<{ color: string; role?: GlassSurfaceGroup; nested: boolean; translucentColor?: string }>) =>
        resolveGlassSurfaceColor(input.color, input.role ?? containingGroup ?? 'content', settings, environment, true, input.nested || containingGroup !== null, input.translucentColor), [settings, environment, containingGroup]);
}
