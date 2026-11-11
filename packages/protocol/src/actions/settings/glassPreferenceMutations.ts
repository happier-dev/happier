import type { GlassSurfaceMaterials, GlassSurfaceGroup, GlassSurfaceMaterial, GlassBlurStep } from '../../account/settings/glassSurfaceMaterials.js';
import { resolveGlassTintValues } from '../../account/settings/glassTint.js';
export { DEFAULT_GLASS_TINT_INTENSITY, readGlassTintIntensity, resolveGlassTintValues } from '../../account/settings/glassTint.js';

export type { GlassBlurStep, GlassSurfaceGroup, GlassSurfaceMaterial, GlassSurfaceMaterials };
export const GLASS_PRESETS = ['solid', 'auto', 'everywhere', 'clear'] as const;
export type GlassPreset = typeof GLASS_PRESETS[number];
export type GlassMaterialChoice = GlassPreset | 'custom';
export const GLASS_SURFACE_GROUPS = ['chrome', 'sidebar', 'content', 'card', 'floating'] as const;
export const GLASS_BLUR_STEPS = ['off', 'light', 'regular', 'strong'] as const;
export const GLASS_BLUR_INTENSITY = { off: 0, light: 25, regular: 50, strong: 80 } as const;
/** Strong matches the reference's 24px frost through the existing blur control. */
export const GLASS_BLUR_RADIUS_PX = { off: 0, light: 5, regular: 10, strong: 24 } as const;
/** Lab coats are defaults only. Custom opacity is never clamped for legibility. */
// Owner, 2026-10-25: Regular and Strong shell glass stay 70–75 % opaque, so the picture shows through the title bar.
const PRESET_OPACITY = { light: 0.62, regular: 0.70, strong: 0.75 } as const;
const CONTENT_OPACITY = { light: 0.78, regular: 0.84, strong: 0.90 } as const;

export type GlassMaterialSettings = Readonly<{
    glassBlurEnabled?: boolean;
    glassBlurIntensity?: 'light' | 'regular' | 'strong';
    glassTintIntensity?: number;
    glassSurfaceMaterials?: Omit<GlassSurfaceMaterials, 'card'> & Partial<Pick<GlassSurfaceMaterials, 'card'>> | null;
}>;

export function glassPresetMaterials(preset: GlassPreset, intensity: 'light' | 'regular' | 'strong' = 'regular'): GlassSurfaceMaterials {
    const solid: GlassSurfaceMaterial = { blur: 'off', opacity: 1 };
    const glass: GlassSurfaceMaterial = { blur: intensity, opacity: PRESET_OPACITY[intensity] };
    // Floating tasks need the reference's frost even when surrounding planes use Light.
    const floating: GlassSurfaceMaterial = { blur: 'strong', opacity: 0.02 };
    // Elements only turn glass where something shows through (a background or the desktop). Their coat
    // is faint, as in the monocode reference: the heavy blur and the backdrop tone carry the material.
    const card: GlassSurfaceMaterial = { blur: 'strong', opacity: 0.25 };
    if (preset === 'solid') return { chrome: solid, sidebar: solid, content: solid, card: solid, floating: solid };
    if (preset === 'everywhere') return { chrome: glass, sidebar: glass, content: glass, card, floating };
    if (preset === 'clear') return {
        chrome: { blur: intensity, opacity: 0.08 },
        sidebar: { blur: intensity, opacity: 0.08 },
        content: { blur: intensity, opacity: 0.1 },
        card: { blur: 'strong', opacity: 0.15 },
        floating,
    };
    // The sidebar column stands on the chrome coat: no separate lighter plate under the title bar (owner
    // 2026-11-11, desktop #25a; replaces W3's 18% paper lift). Stored Auto tables with the old lift read as Custom.
    return {
        chrome: glass,
        sidebar: glass,
        content: { blur: intensity, opacity: CONTENT_OPACITY[intensity] },
        card,
        floating,
    };
}

/** Null is the predecessor/default input, not another material mode. */
export function readGlassMaterials(settings: GlassMaterialSettings): GlassSurfaceMaterials {
    if (settings.glassBlurEnabled === false) return glassPresetMaterials('solid');
    const materials = settings.glassSurfaceMaterials;
    if (!materials) return glassPresetMaterials('auto', settings.glassBlurIntensity);
    if (materials.card) return materials as GlassSurfaceMaterials;
    const preset = matchGlassPreset(materials, settings.glassBlurIntensity);
    return { ...materials, card: materials.card ?? glassPresetMaterials(preset === 'custom' ? 'auto' : preset, settings.glassBlurIntensity).card };
}

function matchGlassPreset(materials: NonNullable<GlassMaterialSettings['glassSurfaceMaterials']>, intensity: GlassMaterialSettings['glassBlurIntensity']): GlassMaterialChoice {
    for (const preset of GLASS_PRESETS) {
        const candidate = glassPresetMaterials(preset, intensity);
        // Elements has an independent binary toggle, not an exemption for authored coats.
        if (GLASS_SURFACE_GROUPS.every(group => {
            const material = materials[group];
            if (material?.authoredOpacity === true) return false;
            if (group === 'card' && (!material || (material.blur === 'off' && material.opacity === 1))) return true;
            return material?.blur === candidate[group].blur && material.opacity === candidate[group].opacity;
        })) return preset;
    }
    return 'custom';
}

export function readGlassPreset(settings: GlassMaterialSettings): GlassMaterialChoice {
    return matchGlassPreset(readGlassMaterials(settings), settings.glassBlurIntensity);
}

/**
 * The materials a named preset renders with: its stored table, with the Elements and floating coats of
 * the selected tint (12 when unset). Solid groups, the Solid preset and authored (custom) tables
 * keep their exact values.
 */
export function readGlassTintedMaterials(settings: GlassMaterialSettings): GlassSurfaceMaterials {
    const materials = readGlassMaterials(settings);
    const preset = matchGlassPreset(materials, settings.glassBlurIntensity);
    if (preset === 'custom' || preset === 'solid') return materials;
    const coats = resolveGlassTintValues(settings.glassTintIntensity);
    const tinted = (material: GlassSurfaceMaterial, opacity: number) => material.opacity < 1 ? { ...material, opacity } : material;
    return { ...materials,
        card: tinted(materials.card, preset === 'clear' ? coats.clearCardCoat : coats.cardCoat),
        floating: tinted(materials.floating, coats.floatingCoat) };
}

export function resolveGlassTintSettingsDelta(_settings: GlassMaterialSettings, tint: number) {
    return { glassTintIntensity: tint };
}

/** Elements intent survives Solid, while the effective material remains solid. */
function readCardChoice(settings: GlassMaterialSettings): GlassSurfaceMaterial {
    return settings.glassSurfaceMaterials?.card ?? readGlassMaterials({ ...settings, glassBlurEnabled: true }).card;
}

export function readGlassSurfaceMode(settings: GlassMaterialSettings, group: GlassSurfaceGroup): 'glass' | 'solid' {
    const material = group === 'card' ? readCardChoice(settings) : readGlassMaterials(settings)[group];
    return material.blur === 'off' && material.opacity === 1 ? 'solid' : 'glass';
}

export function resolveGlassPresetSettingsDelta(settings: GlassMaterialSettings, preset: GlassPreset) {
    const intensity = preset === 'clear' ? 'strong' : settings.glassBlurIntensity;
    // Solid is the existing enable switch; keep Auto underneath it so re-enabling
    // the predecessor switch still restores Auto while Elements intent survives.
    const materials = glassPresetMaterials(preset === 'solid' ? 'auto' : preset, intensity);
    const card = readCardChoice(settings);
    return {
        glassBlurEnabled: preset !== 'solid',
        ...(preset === 'clear' ? { glassBlurIntensity: 'strong' as const } : {}),
        glassSurfaceMaterials: { ...materials, card: readGlassSurfaceMode(settings, 'card') === 'solid' || preset === 'solid' ? card : materials.card },
    };
}

function resolveGlassSurfaceDelta(settings: GlassMaterialSettings, group: GlassSurfaceGroup, update: (current: GlassSurfaceMaterial) => GlassSurfaceMaterial) {
    // Elements edits preserve the configured planes even while Solid masks them.
    // Other layers edit their effective Solid state without erasing Elements intent.
    const current = group === 'card' ? readGlassMaterials({ ...settings, glassBlurEnabled: true })
        : { ...readGlassMaterials(settings), card: readCardChoice(settings) };
    const material = update(current[group]);
    const glassSurfaceMaterials = { ...current, [group]: material };
    return {
        ...(group === 'card' ? {} : { glassBlurEnabled: GLASS_SURFACE_GROUPS.some(key => key !== 'card' && (glassSurfaceMaterials[key].blur !== 'off' || glassSurfaceMaterials[key].opacity < 1)) }),
        glassSurfaceMaterials,
    };
}

export function resolveGlassSurfaceSettingsDelta(settings: GlassMaterialSettings, group: GlassSurfaceGroup, patch: Partial<GlassSurfaceMaterial>) {
    return resolveGlassSurfaceDelta(settings, group, current => ({ ...current, ...patch,
        ...(group === 'card' && patch.opacity !== undefined ? { authoredOpacity: true as const } : {}) }));
}

export function resolveGlassSurfaceModeSettingsDelta(settings: GlassMaterialSettings, group: GlassSurfaceGroup, mode: 'glass' | 'solid') {
    // Restore the configured shell's default Elements coat, including Clear, after an authored edit.
    const { card: _card, ...planes } = readGlassMaterials({ ...settings, glassBlurEnabled: true });
    const preset = group === 'card' ? matchGlassPreset(planes, settings.glassBlurIntensity) : readGlassPreset(settings);
    // A binary mode writes the default coat afresh, retiring any authored-opacity intent.
    return resolveGlassSurfaceDelta(settings, group, () => mode === 'solid' ? { blur: 'off', opacity: 1 }
        : glassPresetMaterials(preset === 'solid' || preset === 'custom' ? 'auto' : preset, settings.glassBlurIntensity)[group]);
}

export function resolveGlassIntensitySettingsDelta(settings: GlassMaterialSettings, intensity: 'light' | 'regular' | 'strong') {
    const preset = readGlassPreset(settings);
    return {
        glassBlurIntensity: intensity,
        glassSurfaceMaterials: preset === 'custom'
            ? Object.fromEntries(GLASS_SURFACE_GROUPS.map(group => {
                const material = readGlassMaterials(settings)[group];
                return [group, { ...material, blur: material.blur === 'off' ? 'off' : intensity }];
            })) as GlassSurfaceMaterials
            : { ...glassPresetMaterials(preset === 'solid' ? 'auto' : preset, intensity), card: readGlassSurfaceMode(settings, 'card') === 'solid' || preset === 'solid'
                ? readCardChoice(settings) : glassPresetMaterials(preset, intensity).card },
    };
}
