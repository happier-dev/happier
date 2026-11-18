import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { parseThemeColor } from '@/theme/parseThemeColor';
import { happierMaterialBackgroundColor, happierMaterialInnerBackgroundColor } from '@happier-dev/plugin-ui/presentation';

import { resolveGlassBackdropMap, resolveGlassBackdropTone, resolveGlassSurfaceMaterial, type GlassSurfaceGroup } from './glassMaterial';
import { useGlassMaterialSettings } from './useGlassMaterialSettings';
import { useGlassRuntimeEnvironment } from './glassRuntimeEnvironment';
import { glassSurfaceTintColor, resolveGlassSurfacePlaneMaterial } from './glassSurfacePaint';
import { resolveGlassCapability } from './resolveGlassCapability';
import { drawsTintWithoutBlur, getBlurViewComponent, isNativeBlurAvailable } from './blurMaterial';
import { getGlassViewComponent, useLiquidGlassAvailable } from './liquidGlass';
import { resolveGlassSurfaceColor } from './glassSurfaceColor';
export { resolveGlassSurfaceColor, resolveGlassSurfacePaint } from './glassSurfaceColor';

export function useGlassSurfaceColor(color: string, group: GlassSurfaceGroup, nested = true, tintAvailable?: boolean, plane = nested): string {
    const { theme } = useUnistyles();
    const colors = theme.colors;
    const settings = useGlassMaterialSettings();
    const environment = useGlassRuntimeEnvironment();
    const liquidGlassAvailable = useLiquidGlassAvailable();
    // Outer arrows/fades/container paint follows the same capability and SDK loaders as GlassSurface.
    const capability = resolveGlassCapability({ ...environment, settings, surfaceGroup: group, liquidGlassAvailable,
        blurAvailable: isNativeBlurAvailable(), webBlurAvailable: Platform.OS === 'web', reduceTransparency: environment.reduceTransparency === true });
    const available = tintAvailable ?? (Platform.OS === 'web' || drawsTintWithoutBlur(group) || capability === 'tint'
        || (capability === 'blur' && getBlurViewComponent() !== null)
        || (capability === 'liquidGlass' && getGlassViewComponent() !== null));
    const tint = nested || !available ? color : glassSurfaceTintColor({ color, ink: colors.text.primary, controlFill: colors.surface.selected, dark: theme.dark, settings, group, environment, page: colors.surface.base });
    const map = !nested && available && Platform.OS === 'web'
        ? resolveGlassBackdropMap(settings, group, theme.dark, environment, { page: colors.surface.base, solid: color, ink: colors.text.primary, controlFill: colors.surface.selected })
        : null;
    const coatOpacity = map?.opaqueCoat ? 1 : map?.opacity;
    // A CSS token's spelling stays the same when its live theme value changes.
    return React.useMemo(() => resolveGlassSurfaceColor(tint, group, settings, environment, available, nested, undefined, plane, coatOpacity), [colors, tint, group, settings, environment, nested, available, plane, coatOpacity]);
}

/** Independent arrow and fade paint consumes the same backdrop treatment as its surface of `solid` paint. */
export function useGlassSurfaceBackdropTone(group: GlassSurfaceGroup, solid: string): string {
    const { theme } = useUnistyles();
    const settings = useGlassMaterialSettings();
    const environment = useGlassRuntimeEnvironment();
    return resolveGlassBackdropTone(settings, group, theme.dark, environment, { page: theme.colors.surface.base, solid, ink: theme.colors.text.primary, controlFill: theme.colors.surface.selected });
}

/** Native controls share their containing material; SDK adapters need its concrete paint. */
export function useGlassMaterialColorResolver(containingGroup: GlassSurfaceGroup | null = null, plane = false) {
    const { theme } = useUnistyles();
    const colors = theme.colors;
    const settings = useGlassMaterialSettings();
    const environment = useGlassRuntimeEnvironment();
    const concrete = React.useCallback((input: Readonly<{ color: string; role?: GlassSurfaceGroup; nested: boolean; translucentColor?: string }>) =>
        resolveGlassSurfaceColor(input.color, input.role ?? containingGroup ?? 'content', settings, environment, true, input.nested || containingGroup !== null, input.translucentColor, plane && input.translucentColor === 'transparent'), [colors, settings, environment, containingGroup, plane]);
    // Web controls bind once to the containing material's CSS payload. Presets repaint that
    // payload without publishing a new callback to every descendant control and document tab.
    const web = React.useCallback((input: Readonly<{ color: string; role?: GlassSurfaceGroup; nested: boolean; translucentColor?: string }>) => {
        const group = input.role ?? containingGroup ?? 'content';
        const parsed = parseThemeColor(input.color);
        const color = parsed === null ? input.color : input.translucentColor === undefined
            ? happierMaterialBackgroundColor(input.color, group, true, input.nested || containingGroup !== null)
            : happierMaterialInnerBackgroundColor(input.color, input.translucentColor, group, true, parsed.alpha() < 1);
        return plane && input.translucentColor === 'transparent'
            ? `var(--happier-glass-${group}-plane-background-color, ${color})` : color;
    }, [colors, containingGroup, plane]);
    return Platform.OS === 'web' ? web : concrete;
}
