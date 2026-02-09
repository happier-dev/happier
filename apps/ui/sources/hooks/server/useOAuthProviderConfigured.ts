import { useServerFeatureValue } from './useServerFeatures';

/**
 * Returns:
 * - `null` while unknown (network error / not fetched yet)
 * - `true` when the server reports the OAuth provider is configured
 * - `false` when the server reports the OAuth provider is not configured
 */
export function useOAuthProviderConfigured(providerId: string): boolean | null {
    const id = providerId.toString().trim().toLowerCase();

    return useServerFeatureValue({
        initial: null,
        deps: [id],
        select: (features) => {
            if (!id || !features) return null;
            const value = features.features?.oauth?.providers?.[id]?.configured;
            return typeof value === 'boolean' ? value : null;
        },
    });
}
