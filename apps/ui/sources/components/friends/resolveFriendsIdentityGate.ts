export type FriendsUsernameHint =
    | Readonly<{ key: 'friends.username.preferredNotAvailable' }>
    | Readonly<{ key: 'friends.username.preferredNotAvailableWithLogin'; params: { login: string } }>;

export type FriendsIdentityGate = Readonly<{
    isReady: boolean;
    gateVariant: 'provider' | 'username';
    initialUsername?: string;
    usernameHint?: FriendsUsernameHint;
}>;

export function resolveFriendsIdentityGate(params: {
    friendsAllowUsernameSupport: boolean | null;
    profileUsername: string | null;
    requiredProviderConnected: boolean;
    requiredProviderLogin: string | null;
}): FriendsIdentityGate {
    const allowUsername = params.friendsAllowUsernameSupport === true;
    const username = params.profileUsername?.trim() || null;
    const requiredProviderConnected = params.requiredProviderConnected === true;
    const requiredProviderLogin = params.requiredProviderLogin?.trim() || null;

    // Username-only mode: only require a username.
    if (allowUsername) {
        if (username) {
            return { isReady: true, gateVariant: 'username' };
        }
        return {
            isReady: false,
            gateVariant: 'username',
            ...(requiredProviderLogin ? { initialUsername: requiredProviderLogin } : {}),
        };
    }

    // Provider-required mode: require the identity provider first, then require a username
    // (needed for discovery and sharing).
    if (!requiredProviderConnected) {
        return { isReady: false, gateVariant: 'provider' };
    }
    if (username) {
        return { isReady: true, gateVariant: 'username' };
    }

    const usernameHint: FriendsUsernameHint = requiredProviderLogin
        ? { key: 'friends.username.preferredNotAvailableWithLogin', params: { login: requiredProviderLogin } }
        : { key: 'friends.username.preferredNotAvailable' };

    return {
        isReady: false,
        gateVariant: 'username',
        ...(requiredProviderLogin ? { initialUsername: requiredProviderLogin } : {}),
        usernameHint,
    };
}
