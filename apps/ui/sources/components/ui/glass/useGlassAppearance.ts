import * as React from 'react';

import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { APPEARANCE_GLASS_SETTINGS } from '@/components/settings/appearance/appearanceSettings';
import { useGlassMaterialSettings } from './useGlassMaterialSettings';

import {
    readGlassMaterials, readGlassPreset, readGlassTintIntensity,
    type GlassPreset, type GlassSurfaceGroup,
} from './glassMaterial';

/** Shared Account owner for Settings, the Appearance popover and Personalize. */
export function useGlassAppearance() {
    const settings = useGlassMaterialSettings();
    const { glassBlurIntensity, glassTintIntensity } = settings;
    const { setSetting } = useSettingActionFeedback();
    return React.useMemo(() => {
        const surfaceSettings = {
            content: APPEARANCE_GLASS_SETTINGS.settings.glassWindow,
            chrome: APPEARANCE_GLASS_SETTINGS.settings.glassChrome,
            sidebar: APPEARANCE_GLASS_SETTINGS.settings.glassSidebar,
            card: APPEARANCE_GLASS_SETTINGS.settings.glassElements,
            floating: APPEARANCE_GLASS_SETTINGS.settings.glassFloating,
        };
        return {
            settings,
            materials: readGlassMaterials(settings),
            preset: readGlassPreset(settings),
            intensity: glassBlurIntensity ?? 'regular',
            tint: readGlassTintIntensity(glassTintIntensity),
            selectPreset: (preset: GlassPreset) => setSetting(APPEARANCE_GLASS_SETTINGS.settings.glassPreset, preset),
            setIntensity: (intensity: 'light' | 'regular' | 'strong') => setSetting(APPEARANCE_GLASS_SETTINGS.settings.glassIntensity, intensity),
            setTint: (tint: number) => setSetting(APPEARANCE_GLASS_SETTINGS.settings.glassTint, tint),
            setSurfaceMode: (group: GlassSurfaceGroup, mode: 'glass' | 'solid') => setSetting(surfaceSettings[group], mode),
        };
    }, [setSetting, settings, glassBlurIntensity, glassTintIntensity]);
}
