import * as React from 'react';
import { Platform } from 'react-native';
import Color from 'color';

import { resolveGlassSurfaceMaterial, type GlassMaterialEnvironment, type GlassMaterialSettings, type GlassSurfaceGroup } from './glassMaterial';
import { useGlassMaterialSettings } from './useGlassMaterialSettings';
import { useGlassRuntimeEnvironment } from './glassRuntimeEnvironment';

/** Renderer SDKs need concrete colors rather than CSS material variables. */
export function resolveGlassSurfaceColor(color: string, group: GlassSurfaceGroup, settings: GlassMaterialSettings, environment: GlassMaterialEnvironment, tintAvailable: boolean, nested = true): string {
    if (!tintAvailable) return color;
    const { material } = resolveGlassSurfaceMaterial(settings, group, environment);
    const opacity = nested && material.opacity < 1 ? 0 : material.opacity;
    if (opacity === 1) return color;
    const parsed = Color(color);
    return parsed.alpha(parsed.alpha() * opacity).hexa().toLowerCase();
}

export function useGlassSurfaceColor(color: string, group: GlassSurfaceGroup, nested = true): string {
    const settings = useGlassMaterialSettings();
    const environment = useGlassRuntimeEnvironment();
    return React.useMemo(() => resolveGlassSurfaceColor(color, group, settings, environment, Platform.OS === 'web' || Platform.OS === 'android', nested), [color, group, settings, environment, nested]);
}
