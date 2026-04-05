import { useServerFeaturesRuntimeSnapshot } from '@/sync/domains/features/featureDecisionRuntime';

/**
 * Returns:
 * - `null` while the server snapshot is still loading
 * - `true` when the server reports the OAuth provider is configured
 * - `false` when the server reports the OAuth provider is not configured or the request failed
 */
export function useOAuthProviderConfigured(providerId: string): boolean | null {
    const id = providerId.toString().trim().toLowerCase();
    const snapshot = useServerFeaturesRuntimeSnapshot();

    if (!id) return null;
    if (snapshot.status === 'loading') return null;
    if (snapshot.status !== 'ready') return false;

    const value = snapshot.features.capabilities.oauth.providers[id]?.configured;
    return typeof value === 'boolean' ? value : false;
}
