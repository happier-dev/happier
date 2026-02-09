import { normalizeProviderId } from '@/auth/providers/registry';
import { useServerFeatureValue } from './useServerFeatures';

/**
 * Returns:
 * - `undefined` while loading
 * - a provider id string when the server reports a required identity provider for Friends
 * - `null` when the server reports no required provider or the request failed
 */
export function useFriendsRequiredIdentityProviderId(): string | null | undefined {
    return useServerFeatureValue({
        initial: undefined,
        select: (features) => {
            if (!features) return null;
            const raw = features.features?.social?.friends?.requiredIdentityProviderId;
            return normalizeProviderId(raw) ?? null;
        },
    });
}
