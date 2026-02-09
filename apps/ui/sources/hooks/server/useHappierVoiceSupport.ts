import { useServerFeatureValue } from './useServerFeatures';

/**
 * Returns:
 * - `null` while unknown (network error / not fetched yet)
 * - `true` when the server reports Happier Voice is available
 * - `false` when the server explicitly reports voice is unavailable/misconfigured
 */
export function useHappierVoiceSupport(): boolean | null {
    return useServerFeatureValue({
        initial: null,
        select: (features) => {
            if (!features) return null;
            return features.features?.voice?.enabled === true;
        },
    });
}
