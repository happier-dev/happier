import type { FeaturesResponse as RootLayoutFeatures } from '@happier-dev/protocol';

const BASE_ROOT_LAYOUT_FEATURES: RootLayoutFeatures = {
    features: {
        bugReports: {
            enabled: true,
            providerUrl: 'https://reports.happier.dev',
            defaultIncludeDiagnostics: true,
            maxArtifactBytes: 10 * 1024 * 1024,
            acceptedArtifactKinds: ['ui-mobile', 'daemon', 'server', 'cli'],
            uploadTimeoutMs: 20_000,
            contextWindowMs: 30 * 60 * 1_000,
        },
        automations: {
            enabled: true,
            existingSessionTarget: false,
        },
        connectedServices: {
            enabled: true,
            webOauthProxyEnabled: true,
            quotas: { enabled: true },
        },
        updates: {
            ota: { enabled: true },
        },
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
            recovery: {
                providerReset: { enabled: false, providers: [] },
            },
            ui: {
                autoRedirect: { enabled: false, providerId: null },
                recoveryKeyReminder: { enabled: true },
            },
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
    const nextConnectedServices: Partial<RootLayoutFeatures['features']['connectedServices']> = nextFeatures.connectedServices ?? {};
    const nextUpdates: Partial<RootLayoutFeatures['features']['updates']> = nextFeatures.updates ?? {};
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
            automations: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.automations,
                ...(nextFeatures.automations ?? {}),
            },
            connectedServices: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.connectedServices,
                ...nextConnectedServices,
                quotas: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.connectedServices.quotas,
                    ...(nextConnectedServices.quotas ?? {}),
                },
            },
            updates: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.updates,
                ...nextUpdates,
                ota: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.updates.ota,
                    ...(nextUpdates.ota ?? {}),
                },
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
                recovery: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.auth.recovery,
                    ...(nextAuth.recovery ?? {}),
                },
                ui: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.auth.ui,
                    ...(nextAuth.ui ?? {}),
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
