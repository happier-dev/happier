import { useGlassMaterialSettings } from './useGlassMaterialSettings';
import { GLASS_BLUR_INTENSITY, resolveGlassSurfaceMaterial, type GlassSurfaceGroup } from './glassMaterial';
import { useGlassRuntimeEnvironment } from './glassRuntimeEnvironment';

export type GlassBlurSetting = Readonly<{
    blurEnabled: boolean;
    blurIntensity: number;
}>;

/**
 * The user's "Glass surfaces" blur preference (enable + resolved intensity),
 * shared by every `GlassPanel` (tab bar, jump-to-bottom button, glass composer,
 * …). The single place that knows the underlying setting keys, so generalizing
 * or migrating them touches only this hook.
 */
export function useGlassBlurSetting(group: GlassSurfaceGroup = 'floating'): GlassBlurSetting {
    const settings = useGlassMaterialSettings();
    const environment = useGlassRuntimeEnvironment();
    const intensitySetting = settings.glassBlurIntensity;
    const { material } = resolveGlassSurfaceMaterial(settings, group, environment);
    return {
        blurEnabled: material.blur !== 'off',
        blurIntensity: material.blur === 'off' ? GLASS_BLUR_INTENSITY[intensitySetting ?? 'regular'] : GLASS_BLUR_INTENSITY[material.blur],
    };
}
