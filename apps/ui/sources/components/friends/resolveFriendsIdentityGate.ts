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

export type FriendsIdentityConnectOption =
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'connect'; providerId: string; providerName: string }>
    | Readonly<{ kind: 'notConfigured'; providerName: string }>;

/**
 * Whether the identity step offers to connect the Friends identity provider, named. Only a provider this Home
 * configured is offered (`capabilities.oauth.providers[id].configured`); on the username step an unconfigured one is
 * simply absent, and when Friends requires it the step says it is missing instead of showing a control that cannot work.
 * `providerConfigured` is `null` while the Home's features load: nothing is offered yet.
 */
export function resolveFriendsIdentityConnectOption(params: Readonly<{
    gateVariant: FriendsIdentityGate['gateVariant'];
    requiredProviderId: string | null;
    requiredProviderName: string | null;
    providerConnected: boolean;
    providerConfigured: boolean | null;
}>): FriendsIdentityConnectOption {
    if (!params.requiredProviderId || params.providerConnected || params.providerConfigured === null) return { kind: 'none' };
    const providerName = params.requiredProviderName ?? params.requiredProviderId;
    if (params.providerConfigured) return { kind: 'connect', providerId: params.requiredProviderId, providerName };
    return params.gateVariant === 'provider' ? { kind: 'notConfigured', providerName } : { kind: 'none' };
}
