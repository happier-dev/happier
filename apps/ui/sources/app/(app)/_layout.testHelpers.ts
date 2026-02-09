type RootLayoutFeatures = {
    features: {
        sharing: {
            session: { enabled: boolean };
            public: { enabled: boolean };
            contentKeys: { enabled: boolean };
            pendingQueueV2: { enabled: boolean };
        };
        voice: {
            enabled: boolean;
            configured: boolean;
            provider: string | null;
        };
        social: {
            friends: {
                enabled: boolean;
                allowUsername: boolean;
                requiredIdentityProviderId: string | null;
            };
        };
        oauth: {
            providers: Record<string, { enabled: boolean; configured: boolean }>;
        };
        auth: {
            signup: { methods: Array<{ id: string; enabled: boolean }> };
            login: { requiredProviders: string[] };
            providers: Record<string, unknown>;
            misconfig: string[];
        };
    };
};

const BASE_ROOT_LAYOUT_FEATURES: RootLayoutFeatures = {
    features: {
        sharing: {
            session: { enabled: true },
            public: { enabled: true },
            contentKeys: { enabled: true },
            pendingQueueV2: { enabled: false },
        },
        voice: { enabled: false, configured: false, provider: null },
        social: {
            friends: {
                enabled: true,
                allowUsername: false,
                requiredIdentityProviderId: 'github',
            },
        },
        oauth: { providers: { github: { enabled: true, configured: true } } },
        auth: {
            signup: { methods: [{ id: 'anonymous', enabled: true }] },
            login: { requiredProviders: [] },
            providers: {
                github: {
                    enabled: true,
                    configured: true,
                    restrictions: { usersAllowlist: false, orgsAllowlist: false, orgMatch: 'any' },
                    offboarding: { enabled: false, intervalSeconds: 600, mode: 'per-request-cache', source: 'oauth_user_token' },
                },
            },
            misconfig: [],
        },
    },
};

export function createRootLayoutFeaturesResponse(overrides?: Partial<RootLayoutFeatures['features']>): RootLayoutFeatures {
    const nextFeatures: Partial<RootLayoutFeatures['features']> = overrides ?? {};
    const nextAuth: Partial<RootLayoutFeatures['features']['auth']> = nextFeatures.auth ?? {};
    const nextSocial: Partial<RootLayoutFeatures['features']['social']> = nextFeatures.social ?? {};
    const nextSharing: Partial<RootLayoutFeatures['features']['sharing']> = nextFeatures.sharing ?? {};
    const nextOauth: Partial<RootLayoutFeatures['features']['oauth']> = nextFeatures.oauth ?? {};
    return {
        features: {
            ...BASE_ROOT_LAYOUT_FEATURES.features,
            ...nextFeatures,
            sharing: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.sharing,
                ...nextSharing,
            },
            voice: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.voice,
                ...(nextFeatures.voice ?? {}),
            },
            social: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.social,
                ...nextSocial,
                friends: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.social.friends,
                    ...(nextSocial.friends ?? {}),
                },
            },
            oauth: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.oauth,
                ...nextOauth,
                providers: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.oauth.providers,
                    ...(nextOauth.providers ?? {}),
                },
            },
            auth: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.auth,
                ...nextAuth,
                signup: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.auth.signup,
                    ...(nextAuth.signup ?? {}),
                },
                login: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.auth.login,
                    ...(nextAuth.login ?? {}),
                },
                providers: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.auth.providers,
                    ...(nextAuth.providers ?? {}),
                },
                misconfig: nextAuth.misconfig ?? BASE_ROOT_LAYOUT_FEATURES.features.auth.misconfig,
            },
        },
    };
}

export function createOkFetchResponse<T>(payload: T): Promise<Response> {
    const response = {
        ok: true,
        json: async () => payload,
    };
    return Promise.resolve(response as Response);
}
