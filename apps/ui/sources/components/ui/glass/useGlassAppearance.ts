import * as React from 'react';

import { useApplySettings } from '@/sync/store/settingsWriters';
import { useGlassMaterialSettings } from './useGlassMaterialSettings';

import {
    readGlassMaterials, readGlassPreset, resolveGlassIntensitySettingsDelta,
    resolveGlassPresetSettingsDelta, resolveGlassSurfaceSettingsDelta,
    type GlassPreset, type GlassSurfaceGroup, type GlassSurfaceMaterial,
} from './glassMaterial';

/** Shared Account owner for Settings, the Appearance popover and Personalize. */
export function useGlassAppearance() {
    const settings = useGlassMaterialSettings();
    const { glassBlurIntensity } = settings;
    const apply = useApplySettings();
    return React.useMemo(() => ({
        settings,
        materials: readGlassMaterials(settings),
        preset: readGlassPreset(settings),
        intensity: glassBlurIntensity ?? 'regular',
        selectPreset: (preset: GlassPreset) => apply(resolveGlassPresetSettingsDelta(settings, preset)),
        setIntensity: (intensity: 'light' | 'regular' | 'strong') => apply(resolveGlassIntensitySettingsDelta(settings, intensity)),
        updateSurface: (group: GlassSurfaceGroup, material: Partial<GlassSurfaceMaterial>) => apply(resolveGlassSurfaceSettingsDelta(settings, group, material)),
    }), [apply, settings, glassBlurIntensity]);
}
