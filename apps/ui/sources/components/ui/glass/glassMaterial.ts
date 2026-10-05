import type { GlassBlurStep, GlassSurfaceGroup, GlassSurfaceMaterial, GlassSurfaceMaterials } from '@happier-dev/protocol';

export type { GlassBlurStep, GlassSurfaceGroup, GlassSurfaceMaterial, GlassSurfaceMaterials };
export type GlassPreset = 'solid' | 'auto' | 'everywhere';
export type GlassMaterialChoice = GlassPreset | 'custom';
export const GLASS_SURFACE_GROUPS = ['chrome', 'sidebar', 'content', 'floating'] as const;
export const GLASS_BLUR_STEPS = ['off', 'light', 'regular', 'strong'] as const;
export const GLASS_BLUR_INTENSITY = { off: 0, light: 25, regular: 50, strong: 80 } as const;
/** Lab coats are defaults only. Custom opacity is never clamped for legibility. */
const PRESET_OPACITY = { light: 0.62, regular: 0.70, strong: 0.80 } as const;
const CONTENT_OPACITY = { light: 0.78, regular: 0.84, strong: 0.90 } as const;

export type GlassMaterialSettings = Readonly<{
    glassBlurEnabled?: boolean;
    glassBlurIntensity?: 'light' | 'regular' | 'strong';
    glassSurfaceMaterials?: GlassSurfaceMaterials | null;
}>;

export function glassPresetMaterials(preset: GlassPreset, intensity: 'light' | 'regular' | 'strong' = 'regular'): GlassSurfaceMaterials {
    const solid: GlassSurfaceMaterial = { blur: 'off', opacity: 1 };
    const glass: GlassSurfaceMaterial = { blur: intensity, opacity: PRESET_OPACITY[intensity] };
    if (preset === 'solid') return { chrome: solid, sidebar: solid, content: solid, floating: solid };
    if (preset === 'everywhere') return { chrome: glass, sidebar: glass, content: glass, floating: glass };
    // W3: the sidebar's 18% paper lift over chrome is represented as its own
    // equivalent coat, so callers never need to compose or repeat the tint.
    return {
        chrome: glass,
        sidebar: { blur: intensity, opacity: 1 - (1 - glass.opacity) * 0.82 },
        content: { blur: intensity, opacity: CONTENT_OPACITY[intensity] },
        floating: { blur: intensity, opacity: 0.90 },
    };
}

/** Null is the predecessor/default input, not another material mode. */
export function readGlassMaterials(settings: GlassMaterialSettings): GlassSurfaceMaterials {
    if (settings.glassBlurEnabled === false) return glassPresetMaterials('solid');
    return settings.glassSurfaceMaterials ?? glassPresetMaterials('auto', settings.glassBlurIntensity);
}

export function readGlassPreset(settings: GlassMaterialSettings): GlassMaterialChoice {
    const materials = readGlassMaterials(settings);
    for (const preset of ['solid', 'auto', 'everywhere'] as const) {
        const candidate = glassPresetMaterials(preset, settings.glassBlurIntensity);
        if (GLASS_SURFACE_GROUPS.every(group => materials[group].blur === candidate[group].blur
            && materials[group].opacity === candidate[group].opacity)) return preset;
    }
    return 'custom';
}

export function resolveGlassPresetSettingsDelta(settings: GlassMaterialSettings, preset: GlassPreset) {
    return {
        glassBlurEnabled: preset !== 'solid',
        glassSurfaceMaterials: preset === 'everywhere' ? glassPresetMaterials(preset, settings.glassBlurIntensity) : null,
    };
}

export function resolveGlassSurfaceSettingsDelta(settings: GlassMaterialSettings, group: GlassSurfaceGroup, patch: Partial<GlassSurfaceMaterial>) {
    const current = readGlassMaterials(settings);
    const material = { ...current[group], ...patch };
    const glassSurfaceMaterials = { ...current, [group]: material };
    return {
        glassBlurEnabled: GLASS_SURFACE_GROUPS.some(key => glassSurfaceMaterials[key].blur !== 'off' || glassSurfaceMaterials[key].opacity < 1),
        glassSurfaceMaterials,
    };
}

export function resolveGlassIntensitySettingsDelta(settings: GlassMaterialSettings, intensity: 'light' | 'regular' | 'strong') {
    const preset = readGlassPreset(settings);
    return {
        glassBlurIntensity: intensity,
        glassSurfaceMaterials: preset === 'auto' ? null : preset === 'custom'
            ? Object.fromEntries(GLASS_SURFACE_GROUPS.map(group => {
                const material = readGlassMaterials(settings)[group];
                return [group, { ...material, blur: material.blur === 'off' ? 'off' : intensity }];
            })) as GlassSurfaceMaterials
            : glassPresetMaterials(preset, intensity),
    };
}

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
