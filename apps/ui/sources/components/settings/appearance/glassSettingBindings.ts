import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import {
    GLASS_BLUR_STEPS, readGlassMaterials, readGlassPreset,
    resolveGlassIntensitySettingsDelta, resolveGlassPresetSettingsDelta, resolveGlassSurfaceSettingsDelta,
    type GlassMaterialSettings, type GlassPreset, type GlassSurfaceGroup,
} from '@/components/ui/glass/glassMaterial';

const isPreset = (value: unknown): value is GlassPreset => value === 'solid' || value === 'auto' || value === 'everywhere';
const isIntensity = (value: unknown): value is NonNullable<GlassMaterialSettings['glassBlurIntensity']> => value === 'light' || value === 'regular' || value === 'strong';

export const glassPresetStorageBinding: SettingStorageBinding = {
    scope: 'account', kind: 'owner', access: 'read_write',
    allowedValues: ['solid', 'auto', 'everywhere'],
    read: readGlassPreset,
    parse: value => isPreset(value) ? { success: true, value } : { success: false },
    mutate: (settings, value) => isPreset(value) ? resolveGlassPresetSettingsDelta(settings, value) : null,
};

export const glassIntensityStorageBinding: SettingStorageBinding = {
    scope: 'account', kind: 'owner', access: 'read_write',
    allowedValues: ['light', 'regular', 'strong'],
    read: settings => settings.glassBlurIntensity ?? 'regular',
    parse: value => isIntensity(value) ? { success: true, value } : { success: false },
    mutate: (settings, value) => isIntensity(value) ? resolveGlassIntensitySettingsDelta(settings, value) : null,
};

/** Generic settings Actions consume the same mutations as the shared material controls. */
export function glassSurfaceStorageBinding(group: GlassSurfaceGroup, field: 'blur' | 'opacity'): SettingStorageBinding {
    return {
        scope: 'account', kind: 'owner', access: 'read_write',
        ...(field === 'blur' ? { allowedValues: GLASS_BLUR_STEPS } : {}),
        read: settings => readGlassMaterials(settings)[group][field],
        parse: value => {
            if (field === 'opacity') return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
                ? { success: true, value } : { success: false };
            return value === 'off' || value === 'light' || value === 'regular' || value === 'strong'
                ? { success: true, value } : { success: false };
        },
        mutate: (settings, value) => {
            if (field === 'opacity') return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
                ? resolveGlassSurfaceSettingsDelta(settings, group, { opacity: value }) : null;
            return value === 'off' || value === 'light' || value === 'regular' || value === 'strong'
                ? resolveGlassSurfaceSettingsDelta(settings, group, { blur: value }) : null;
        },
    };
}
