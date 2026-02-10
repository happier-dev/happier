import { useProfile } from '@/sync/domains/state/storage';
import { authProviderRegistry, getAuthProvider, normalizeProviderId } from '@/auth/providers/registry';
import { resolveFriendsIdentityGate, type FriendsIdentityGate } from '@/components/friends/resolveFriendsIdentityGate';
import { useFriendsAllowUsernameSupport } from './useFriendsAllowUsernameSupport';
import { useFriendsRequiredIdentityProviderId } from './useFriendsRequiredIdentityProviderId';

type IdentityReason = 'ready' | 'loadingFeatures' | 'needsProvider' | 'needsUsername';

export type FriendsIdentityReadiness = Readonly<{
    isReady: boolean;
    isLoadingFeatures: boolean;
    reason: IdentityReason;
    requiredProviderId: string | null;
    requiredProviderDisplayName: string | null;
    requiredProviderConnected: boolean;
    requiredProviderLogin: string | null;
    gate: FriendsIdentityGate;
}>;

export function useFriendsIdentityReadiness(): FriendsIdentityReadiness {
    const profile = useProfile();
    const friendsAllowUsernameSupport = useFriendsAllowUsernameSupport();
    const requiredProviderIdFromServer = useFriendsRequiredIdentityProviderId();

    const fallbackProviderId = normalizeProviderId(profile.linkedProviders?.[0]?.id ?? authProviderRegistry[0]?.id ?? null);
    // `requiredProviderIdFromServer` is tri-state:
    // - `undefined`: still loading features -> fall back to a deterministic provider for copy/UI
    // - `null`: server explicitly requires no provider
    // - `string`: server requires that provider
    const requiredProviderId = normalizeProviderId(
        requiredProviderIdFromServer === undefined ? fallbackProviderId : requiredProviderIdFromServer,
    );

    const requiredIdentity = requiredProviderId
        ? (profile.linkedProviders ?? []).find((p) => normalizeProviderId(p.id) === requiredProviderId) ?? null
        : null;

    const gate = resolveFriendsIdentityGate({
        friendsAllowUsernameSupport: friendsAllowUsernameSupport ?? null,
        profileUsername: profile.username ?? null,
        requiredProviderConnected: Boolean(requiredIdentity),
        requiredProviderLogin: requiredIdentity?.login ?? null,
    });

    const isLoadingFeatures =
        friendsAllowUsernameSupport === undefined ||
        requiredProviderIdFromServer === undefined;
    const isReady = !isLoadingFeatures && gate.isReady;

    let reason: IdentityReason;
    if (isReady) {
        reason = 'ready';
    } else if (isLoadingFeatures) {
        reason = 'loadingFeatures';
    } else if (gate.gateVariant === 'provider') {
        reason = 'needsProvider';
    } else {
        reason = 'needsUsername';
    }

    return {
        isReady,
        isLoadingFeatures,
        reason,
        requiredProviderId,
        requiredProviderDisplayName: requiredProviderId ? (getAuthProvider(requiredProviderId)?.displayName ?? requiredProviderId) : null,
        requiredProviderConnected: Boolean(requiredIdentity),
        requiredProviderLogin: requiredIdentity?.login ?? null,
        gate,
    };
}
