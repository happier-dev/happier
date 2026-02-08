type ProviderState = { enabled: boolean; configured: boolean };

type WelcomeFeaturesOverrides = {
    signupMethods?: Array<{ id: string; enabled: boolean }>;
    requiredProviders?: string[];
    autoRedirectEnabled?: boolean;
    autoRedirectProviderId?: string | null;
    oauthProviders?: Record<string, ProviderState>;
    authProviders?: Record<string, ProviderState>;
    providerOffboardingIntervalSeconds?: number;
};

function createAuthProvidersWithDetails(
    providers: Record<string, ProviderState>,
    intervalSeconds: number,
): Record<
    string,
    {
        enabled: boolean;
        configured: boolean;
        restrictions: { usersAllowlist: boolean; orgsAllowlist: boolean; orgMatch: 'any' };
        offboarding: {
            enabled: boolean;
            intervalSeconds: number;
            mode: 'per-request-cache';
            source: 'github_app' | 'oauth_user_token';
        };
    }
> {
    return Object.fromEntries(
        Object.entries(providers).map(([id, state]) => [
            id,
            {
                enabled: state.enabled,
                configured: state.configured,
                restrictions: { usersAllowlist: false, orgsAllowlist: false, orgMatch: 'any' as const },
                offboarding: {
                    enabled: false,
                    intervalSeconds,
                    mode: 'per-request-cache' as const,
                    source: 'github_app' as const,
                },
            },
        ]),
    );
}

export function createWelcomeFeaturesResponse(
    overrides: WelcomeFeaturesOverrides = {},
): {
    features: {
        sharing: {
            session: { enabled: boolean };
            public: { enabled: boolean };
            contentKeys: { enabled: boolean };
            pendingQueueV2: { enabled: boolean };
        };
        voice: { enabled: boolean; configured: boolean; provider: null };
        social: {
            friends: { enabled: boolean; allowUsername: boolean; requiredIdentityProviderId: string | null };
        };
        oauth: { providers: Record<string, ProviderState> };
        auth: {
            signup: { methods: Array<{ id: string; enabled: boolean }> };
            login: { requiredProviders: string[] };
            ui: { autoRedirect: { enabled: boolean; providerId: string | null } };
            providers: ReturnType<typeof createAuthProvidersWithDetails>;
            misconfig: [];
        };
    };
} {
    const oauthProviders = overrides.oauthProviders ?? {
        github: { enabled: true, configured: true },
    };
    const authProviders = overrides.authProviders ?? oauthProviders;
    const intervalSeconds = overrides.providerOffboardingIntervalSeconds ?? 86400;

    return {
        features: {
            sharing: {
                session: { enabled: true },
                public: { enabled: true },
                contentKeys: { enabled: true },
                pendingQueueV2: { enabled: true },
            },
            voice: { enabled: false, configured: false, provider: null },
            social: {
                friends: {
                    enabled: false,
                    allowUsername: false,
                    requiredIdentityProviderId: null,
                },
            },
            oauth: { providers: oauthProviders },
            auth: {
                signup: {
                    methods:
                        overrides.signupMethods ?? [
                            { id: 'anonymous', enabled: true },
                            { id: 'github', enabled: true },
                        ],
                },
                login: { requiredProviders: overrides.requiredProviders ?? [] },
                ui: {
                    autoRedirect: {
                        enabled: overrides.autoRedirectEnabled ?? false,
                        providerId: overrides.autoRedirectProviderId ?? null,
                    },
                },
                providers: createAuthProvidersWithDetails(authProviders, intervalSeconds),
                misconfig: [],
            },
        },
    };
}
