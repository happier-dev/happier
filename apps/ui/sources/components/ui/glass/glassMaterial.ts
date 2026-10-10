import { readGlassMaterials, readGlassPreset } from '@happier-dev/protocol/actions/settings/glassPreferenceMutations';
import type { GlassMaterialSettings, GlassSurfaceGroup } from '@happier-dev/protocol/actions/settings/glassPreferenceMutations';
export { GLASS_PRESETS, GLASS_SURFACE_GROUPS, GLASS_BLUR_STEPS, GLASS_BLUR_INTENSITY, GLASS_BLUR_RADIUS_PX, glassPresetMaterials, readGlassMaterials, readGlassPreset, resolveGlassPresetSettingsDelta, resolveGlassSurfaceSettingsDelta, resolveGlassIntensitySettingsDelta } from '@happier-dev/protocol/actions/settings/glassPreferenceMutations';
export type { GlassBlurStep, GlassSurfaceGroup, GlassSurfaceMaterial, GlassSurfaceMaterials, GlassPreset, GlassMaterialChoice, GlassMaterialSettings } from '@happier-dev/protocol/actions/settings/glassPreferenceMutations';

export type GlassMaterialEnvironment = Readonly<{
    desktopWindow?: boolean;
    nativeWindowMaterialLive?: boolean;
    reduceTransparency?: boolean;
    highContrast?: boolean;
    windowActive?: boolean;
}>;

/** Stored choices survive accessibility and window-focus overrides. Never fade foreground content. */
export function resolveGlassSurfaceMaterial(settings: GlassMaterialSettings, group: GlassSurfaceGroup, environment: GlassMaterialEnvironment = {}) {
    const requested = readGlassMaterials(settings)[group];
    const reason = environment.reduceTransparency ? 'reduceTransparency'
        : environment.windowActive === false ? 'inactiveWindow'
        : group !== 'floating' && environment.desktopWindow !== true && readGlassPreset(settings) === 'auto' ? 'unsupported'
        : environment.desktopWindow === true && group !== 'floating' && environment.nativeWindowMaterialLive !== true ? 'unavailable'
        : null;
    return {
        material: reason ? { blur: 'off' as const, opacity: 1 } : requested,
        reason,
    };
}

/** Fixed backdrop treatment for named floating materials; custom paint remains authored. */
export function resolveGlassBackdropTone(settings: GlassMaterialSettings, group: GlassSurfaceGroup, dark: boolean, environment: GlassMaterialEnvironment = {}): string {
    if (group !== 'floating' || readGlassPreset(settings) === 'custom'
        || resolveGlassSurfaceMaterial(settings, group, environment).material.opacity === 1) return '';
    // Preserve the backdrop's range and hue before contrast: the light recipe
    // mirrors the same lifted dark curve, rather than clipping everything white.
    return dark ? 'contrast(0.55) brightness(0.5) saturate(1.4)'
        : 'invert(1) contrast(0.55) brightness(0.5) invert(1) saturate(1.4)';
}
