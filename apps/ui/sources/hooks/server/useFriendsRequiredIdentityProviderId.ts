import { normalizeProviderId } from '@/auth/providers/registry';
import { useServerFeaturesRuntimeSnapshot } from '@/sync/domains/features/featureDecisionRuntime';

/**
 * Returns:
 * - `undefined` while loading
 * - a provider id string when the server reports a required identity provider for Friends
 * - `null` when the server reports no required provider or the request failed
 */
export function useFriendsRequiredIdentityProviderId(): string | null | undefined {
    const snapshot = useServerFeaturesRuntimeSnapshot();
    if (snapshot.status === 'loading') return undefined;
    if (snapshot.status !== 'ready') return null;
    return normalizeProviderId(snapshot.features.features.social.friends.requiredIdentityProviderId) ?? null;
}
