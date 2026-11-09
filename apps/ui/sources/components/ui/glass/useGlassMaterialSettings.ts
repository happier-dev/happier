import * as React from 'react';
import { useSettingsSelector } from '@/sync/store/settingsReadHooks';
import type { Settings } from '@/sync/domains/settings/settings';
import type { GlassMaterialSettings } from './glassMaterial';
import { useSettingPreviewValue } from '@/sync/store/settingsPreview';

const GlassMaterialSettingsContext = React.createContext<GlassMaterialSettings | null>(null);
/** A static preview supplies its draft to the existing paints without mutating Account settings. */
export const GlassMaterialSettingsProvider = GlassMaterialSettingsContext.Provider;

export function useGlassMaterialSettings(): GlassMaterialSettings {
    const draft = React.useContext(GlassMaterialSettingsContext);
    const previewEnabled = useSettingPreviewValue('glassBlurEnabled');
    const previewIntensity = useSettingPreviewValue('glassBlurIntensity');
    const previewTint = useSettingPreviewValue('glassTintIntensity');
    const previewMaterials = useSettingPreviewValue('glassSurfaceMaterials');
    const select = React.useCallback((settings: Settings): GlassMaterialSettings => draft ?? {
        glassBlurEnabled: settings.glassBlurEnabled,
        glassBlurIntensity: settings.glassBlurIntensity,
        glassTintIntensity: settings.glassTintIntensity,
        glassSurfaceMaterials: settings.glassSurfaceMaterials,
    }, [draft]);
    const settings = useSettingsSelector(select, ['glassBlurEnabled', 'glassBlurIntensity', 'glassTintIntensity', 'glassSurfaceMaterials']);
    return React.useMemo(() => draft || previewEnabled === undefined && previewIntensity === undefined
        && previewTint === undefined && previewMaterials === undefined ? settings : {
            glassBlurEnabled: previewEnabled ?? settings.glassBlurEnabled,
            glassBlurIntensity: previewIntensity ?? settings.glassBlurIntensity,
            glassTintIntensity: previewTint ?? settings.glassTintIntensity,
            glassSurfaceMaterials: previewMaterials === undefined ? settings.glassSurfaceMaterials : previewMaterials,
        }, [draft, settings, previewEnabled, previewIntensity, previewTint, previewMaterials]);
}
