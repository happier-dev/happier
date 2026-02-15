import { useServerFeaturesRuntimeSnapshot } from '@/sync/domains/features/featureDecisionRuntime';

/**
 * Returns:
 * - `null` while unknown (network error / not fetched yet)
 * - `true` when the server reports the OAuth provider is configured
 * - `false` when the server reports the OAuth provider is not configured
 */
export function useOAuthProviderConfigured(providerId: string): boolean | null {
    const id = providerId.toString().trim().toLowerCase();
    const snapshot = useServerFeaturesRuntimeSnapshot();

    if (!id || snapshot.status === 'loading') return null;
    if (snapshot.status !== 'ready') return false;

    const value = snapshot.features.features.oauth.providers[id]?.configured;
    return typeof value === 'boolean' ? value : false;
}
