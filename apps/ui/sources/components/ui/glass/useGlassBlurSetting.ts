import { useSetting } from '@/sync/domains/state/storage';

const BLUR_INTENSITY: Record<'light' | 'regular' | 'strong', number> = {
    light: 25,
    regular: 50,
    strong: 80,
};

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
export function useGlassBlurSetting(): GlassBlurSetting {
    const blurEnabled = useSetting('glassBlurEnabled');
    const intensitySetting = useSetting('glassBlurIntensity');
    return {
        blurEnabled,
        blurIntensity: BLUR_INTENSITY[intensitySetting] ?? BLUR_INTENSITY.regular,
    };
}
