import type { FeaturesResponse as RootLayoutFeatures } from '@happier-dev/protocol';

type RootLayoutFeaturesOverrides = Omit<Partial<RootLayoutFeatures>, 'features' | 'capabilities'> & Readonly<{
    features?: Omit<Partial<RootLayoutFeatures['features']>, 'automations' | 'connectedServices' | 'updates' | 'sharing' | 'social' | 'auth'> & Readonly<{
        automations?: Partial<RootLayoutFeatures['features']['automations']>;
        connectedServices?: Partial<RootLayoutFeatures['features']['connectedServices']>;
        updates?: Partial<RootLayoutFeatures['features']['updates']>;
        sharing?: Partial<RootLayoutFeatures['features']['sharing']>;
        social?: Partial<RootLayoutFeatures['features']['social']>;
        auth?: Partial<RootLayoutFeatures['features']['auth']>;
    }>;
    capabilities?: Omit<Partial<RootLayoutFeatures['capabilities']>, 'oauth' | 'social' | 'auth'> & Readonly<{
        oauth?: Partial<RootLayoutFeatures['capabilities']['oauth']>;
        social?: Partial<RootLayoutFeatures['capabilities']['social']>;
        auth?: Partial<RootLayoutFeatures['capabilities']['auth']>;
    }>;
}>;

const BASE_ROOT_LAYOUT_FEATURES: RootLayoutFeatures = {
    features: {
        bugReports: { enabled: true },
        automations: {
            enabled: true,
            existingSessionTarget: { enabled: false },
        },
        connectedServices: {
            enabled: true,
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
        voice: { enabled: false, happierVoice: { enabled: false } },
        social: {
            friends: {
                enabled: true,
            },
        },
        auth: {
            recovery: {
                providerReset: { enabled: false },
            },
            ui: {
                recoveryKeyReminder: { enabled: true },
            },
        },
    },
    capabilities: {
        bugReports: {
            providerUrl: 'https://reports.happier.dev',
            defaultIncludeDiagnostics: true,
            maxArtifactBytes: 10 * 1024 * 1024,
            acceptedArtifactKinds: ['ui-mobile', 'daemon', 'server', 'cli'],
            uploadTimeoutMs: 20_000,
            contextWindowMs: 30 * 60 * 1_000,
        },
        voice: { configured: false, provider: null, requested: false, disabledByBuildPolicy: false },
        social: {
            friends: {
                allowUsername: false,
                requiredIdentityProviderId: 'github',
            },
        },
        oauth: { providers: { github: { enabled: true, configured: true } } },
        auth: {
            signup: { methods: [{ id: 'anonymous', enabled: true }] },
            login: { requiredProviders: [] },
            recovery: {
                providerReset: { providers: [] },
            },
            ui: {
                autoRedirect: { enabled: false, providerId: null },
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

export function createRootLayoutFeaturesResponse(overrides?: RootLayoutFeaturesOverrides): RootLayoutFeatures {
    const next = overrides ?? {};
    const nextFeatures: NonNullable<RootLayoutFeaturesOverrides['features']> = next.features ?? {};
    const nextCapabilities: NonNullable<RootLayoutFeaturesOverrides['capabilities']> = next.capabilities ?? {};

    const nextAuth: Partial<RootLayoutFeatures['features']['auth']> = nextFeatures.auth ?? {};
    const nextSocial: Partial<RootLayoutFeatures['features']['social']> = nextFeatures.social ?? {};
    const nextSharing: Partial<RootLayoutFeatures['features']['sharing']> = nextFeatures.sharing ?? {};
    const nextConnectedServices: Partial<RootLayoutFeatures['features']['connectedServices']> =
        nextFeatures.connectedServices ?? {};
    const nextUpdates: Partial<RootLayoutFeatures['features']['updates']> = nextFeatures.updates ?? {};
    const nextAutomations: Partial<RootLayoutFeatures['features']['automations']> = nextFeatures.automations ?? {};

    const nextCapabilitiesAuth: Partial<RootLayoutFeatures['capabilities']['auth']> = nextCapabilities.auth ?? {};
    const nextCapabilitiesSocial: Partial<RootLayoutFeatures['capabilities']['social']> = nextCapabilities.social ?? {};
    const nextCapabilitiesOauth: Partial<RootLayoutFeatures['capabilities']['oauth']> = nextCapabilities.oauth ?? {};
    const nextCapabilitiesAuthRecovery: Partial<RootLayoutFeatures['capabilities']['auth']['recovery']> =
        nextCapabilitiesAuth.recovery ?? {};
    const nextCapabilitiesAuthUi: Partial<RootLayoutFeatures['capabilities']['auth']['ui']> =
        nextCapabilitiesAuth.ui ?? {};
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
                ...nextAutomations,
                existingSessionTarget: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.automations.existingSessionTarget,
                    ...(nextAutomations.existingSessionTarget ?? {}),
                },
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
            auth: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.auth,
                ...nextAuth,
                recovery: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.auth.recovery,
                    ...(nextAuth.recovery ?? {}),
                },
                ui: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.auth.ui,
                    ...(nextAuth.ui ?? {}),
                },
            },
        },
        capabilities: {
            ...BASE_ROOT_LAYOUT_FEATURES.capabilities,
            ...nextCapabilities,
            voice: {
                ...BASE_ROOT_LAYOUT_FEATURES.capabilities.voice,
                ...(nextCapabilities.voice ?? {}),
            },
            social: {
                ...BASE_ROOT_LAYOUT_FEATURES.capabilities.social,
                ...nextCapabilitiesSocial,
                friends: {
                    ...BASE_ROOT_LAYOUT_FEATURES.capabilities.social.friends,
                    ...(nextCapabilitiesSocial.friends ?? {}),
                },
            },
            oauth: {
                ...BASE_ROOT_LAYOUT_FEATURES.capabilities.oauth,
                ...nextCapabilitiesOauth,
                providers: {
                    ...BASE_ROOT_LAYOUT_FEATURES.capabilities.oauth.providers,
                    ...(nextCapabilitiesOauth.providers ?? {}),
                },
            },
            auth: {
                ...BASE_ROOT_LAYOUT_FEATURES.capabilities.auth,
                ...nextCapabilitiesAuth,
                signup: {
                    ...BASE_ROOT_LAYOUT_FEATURES.capabilities.auth.signup,
                    ...(nextCapabilitiesAuth.signup ?? {}),
                },
                login: {
                    ...BASE_ROOT_LAYOUT_FEATURES.capabilities.auth.login,
                    ...(nextCapabilitiesAuth.login ?? {}),
                },
                recovery: {
                    ...BASE_ROOT_LAYOUT_FEATURES.capabilities.auth.recovery,
                    ...nextCapabilitiesAuthRecovery,
                    providerReset: {
                        ...BASE_ROOT_LAYOUT_FEATURES.capabilities.auth.recovery.providerReset,
                        ...(nextCapabilitiesAuthRecovery.providerReset ?? {}),
                    },
                },
                ui: {
                    ...BASE_ROOT_LAYOUT_FEATURES.capabilities.auth.ui,
                    ...nextCapabilitiesAuthUi,
                    autoRedirect: {
                        ...BASE_ROOT_LAYOUT_FEATURES.capabilities.auth.ui.autoRedirect,
                        ...(nextCapabilitiesAuthUi.autoRedirect ?? {}),
                    },
                },
                providers: {
                    ...BASE_ROOT_LAYOUT_FEATURES.capabilities.auth.providers,
                    ...(nextCapabilitiesAuth.providers ?? {}),
                },
                misconfig: nextCapabilitiesAuth.misconfig ?? BASE_ROOT_LAYOUT_FEATURES.capabilities.auth.misconfig,
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
