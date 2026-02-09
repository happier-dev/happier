import { useServerFeatureValue } from './useServerFeatures';

/**
 * Returns:
 * - `undefined` while loading
 * - `true` when the server reports username-based Friends is enabled
 * - `false` when the server reports username-based Friends is disabled
 * - `null` when the request failed
 */
export function useFriendsAllowUsernameSupport(): boolean | null | undefined {
    return useServerFeatureValue({
        initial: undefined,
        select: (features) => {
            if (!features) return null;
            return features.features?.social?.friends?.allowUsername === true;
        },
    });
}
