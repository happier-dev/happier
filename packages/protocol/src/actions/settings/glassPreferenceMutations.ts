import type { AccountSettings } from '../../account/settings/accountSettings.js';
type GlassSurfaceMaterials = NonNullable<AccountSettings['glassSurfaceMaterials']>;
type GlassSurfaceGroup = keyof GlassSurfaceMaterials;
type GlassSurfaceMaterial = GlassSurfaceMaterials[GlassSurfaceGroup];
type GlassBlurStep = GlassSurfaceMaterial['blur'];

export type { GlassBlurStep, GlassSurfaceGroup, GlassSurfaceMaterial, GlassSurfaceMaterials };
export const GLASS_PRESETS = ['solid', 'auto', 'everywhere', 'clear'] as const;
export type GlassPreset = typeof GLASS_PRESETS[number];
export type GlassMaterialChoice = GlassPreset | 'custom';
export const GLASS_SURFACE_GROUPS = ['chrome', 'sidebar', 'content', 'floating'] as const;
export const GLASS_BLUR_STEPS = ['off', 'light', 'regular', 'strong'] as const;
export const GLASS_BLUR_INTENSITY = { off: 0, light: 25, regular: 50, strong: 80 } as const;
/** Strong matches the reference's 24px frost through the existing blur control. */
export const GLASS_BLUR_RADIUS_PX = { off: 0, light: 5, regular: 10, strong: 24 } as const;
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
    // Floating tasks need the reference's frost even when surrounding planes use Light.
    const floating: GlassSurfaceMaterial = { blur: 'strong', opacity: 0.02 };
    if (preset === 'solid') return { chrome: solid, sidebar: solid, content: solid, floating: solid };
    if (preset === 'everywhere') return { chrome: glass, sidebar: glass, content: glass, floating };
    if (preset === 'clear') return {
        chrome: { blur: intensity, opacity: 0.08 },
        sidebar: { blur: intensity, opacity: 0.08 },
        content: { blur: intensity, opacity: 0.1 },
        floating,
    };
    // W3: the sidebar's 18% paper lift over chrome is represented as its own
    // equivalent coat, so callers never need to compose or repeat the tint.
    return {
        chrome: glass,
        sidebar: { blur: intensity, opacity: 1 - (1 - glass.opacity) * 0.82 },
        content: { blur: intensity, opacity: CONTENT_OPACITY[intensity] },
        floating,
    };
}

/** Null is the predecessor/default input, not another material mode. */
export function readGlassMaterials(settings: GlassMaterialSettings): GlassSurfaceMaterials {
    if (settings.glassBlurEnabled === false) return glassPresetMaterials('solid');
    return settings.glassSurfaceMaterials ?? glassPresetMaterials('auto', settings.glassBlurIntensity);
}

export function readGlassPreset(settings: GlassMaterialSettings): GlassMaterialChoice {
    const materials = readGlassMaterials(settings);
    for (const preset of GLASS_PRESETS) {
        const candidate = glassPresetMaterials(preset, settings.glassBlurIntensity);
        if (GLASS_SURFACE_GROUPS.every(group => materials[group].blur === candidate[group].blur
            && materials[group].opacity === candidate[group].opacity)) return preset;
    }
    return 'custom';
}

export function resolveGlassPresetSettingsDelta(settings: GlassMaterialSettings, preset: GlassPreset) {
    const intensity = preset === 'clear' ? 'strong' : settings.glassBlurIntensity;
    return {
        glassBlurEnabled: preset !== 'solid',
        ...(preset === 'clear' ? { glassBlurIntensity: 'strong' as const } : {}),
        glassSurfaceMaterials: preset === 'everywhere' || preset === 'clear' ? glassPresetMaterials(preset, intensity) : null,
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


