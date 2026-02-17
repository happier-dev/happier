import { useServerFeaturesRuntimeSnapshot } from '@/sync/domains/features/featureDecisionRuntime';

/**
 * Returns:
 * - `undefined` while loading
 * - `true` when the server reports username-based Friends is enabled
 * - `false` when the server reports username-based Friends is disabled
 * - `null` when the request failed
 */
export function useFriendsAllowUsernameSupport(): boolean | null | undefined {
    const snapshot = useServerFeaturesRuntimeSnapshot();
    if (snapshot.status === 'loading') return undefined;
    if (snapshot.status !== 'ready') return false;
    return snapshot.features.capabilities.social.friends.allowUsername === true;
}
