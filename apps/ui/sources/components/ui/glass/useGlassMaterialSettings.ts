import * as React from 'react';
import { useSettingsSelector } from '@/sync/domains/state/storage';
import type { Settings } from '@/sync/domains/settings/settings';
import type { GlassMaterialSettings } from './glassMaterial';

const GlassMaterialSettingsContext = React.createContext<GlassMaterialSettings | null>(null);
/** A static preview supplies its draft to the existing paints without mutating Account settings. */
export const GlassMaterialSettingsProvider = GlassMaterialSettingsContext.Provider;

export function useGlassMaterialSettings(): GlassMaterialSettings {
    const draft = React.useContext(GlassMaterialSettingsContext);
    const select = React.useCallback((settings: Settings): GlassMaterialSettings => draft ?? {
        glassBlurEnabled: settings.glassBlurEnabled,
        glassBlurIntensity: settings.glassBlurIntensity,
        glassSurfaceMaterials: settings.glassSurfaceMaterials,
    }, [draft]);
    return useSettingsSelector(select);
}
