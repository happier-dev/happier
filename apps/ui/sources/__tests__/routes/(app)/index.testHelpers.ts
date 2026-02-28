import type { FeaturesResponse } from '@happier-dev/protocol';

import { createRootLayoutFeaturesResponse } from '@/dev/testkit/rootLayoutTestkit';

type ProviderState = { enabled: boolean; configured: boolean };

type WelcomeFeaturesOverrides = {
    signupMethods?: Array<{ id: string; enabled: boolean }>;
    loginMethods?: Array<{ id: string; enabled: boolean }>;
    authMethods?: FeaturesResponse['capabilities']['auth']['methods'];
    authMtlsEnabled?: boolean;
    requiredProviders?: string[];
    autoRedirectEnabled?: boolean;
    autoRedirectProviderId?: string | null;
    recoveryProviderResetEnabled?: boolean;
    recoveryProviderResetProviders?: string[];
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
): FeaturesResponse {
    const oauthProviders = overrides.oauthProviders ?? {
        github: { enabled: true, configured: true },
    };
    const authProviders = overrides.authProviders ?? oauthProviders;
    const intervalSeconds = overrides.providerOffboardingIntervalSeconds ?? 86400;
    const providerResetEnabled = overrides.recoveryProviderResetEnabled ?? false;
    const providerResetProviders = overrides.recoveryProviderResetProviders ?? [];

    const signupMethods =
        overrides.signupMethods ?? [
            { id: 'anonymous', enabled: true },
            { id: 'github', enabled: true },
        ];

    const loginMethods = overrides.loginMethods ?? [{ id: 'key_challenge', enabled: true }];

    const derivedAuthMethods = [
        {
            id: 'key_challenge',
            actions: [
                { id: 'login' as const, enabled: loginMethods.some((m) => m.id === 'key_challenge' && m.enabled), mode: 'keyed' as const },
                { id: 'provision' as const, enabled: signupMethods.some((m) => m.id === 'anonymous' && m.enabled), mode: 'keyed' as const },
            ],
            ui: { displayName: 'Device key', iconHint: null },
        },
        {
            id: 'mtls',
            actions: [{ id: 'login' as const, enabled: loginMethods.some((m) => m.id === 'mtls' && m.enabled), mode: 'keyless' as const }],
            ui: { displayName: 'Certificate', iconHint: null },
        },
        ...signupMethods
            .filter((m) => m.id !== 'anonymous' && m.enabled)
            .map((m) => ({
                id: m.id,
                actions: [{ id: 'provision' as const, enabled: true, mode: 'keyed' as const }],
                ui: { displayName: m.id, iconHint: null },
            })),
    ] satisfies NonNullable<FeaturesResponse['capabilities']['auth']['methods']>;

    return createRootLayoutFeaturesResponse({
        features: {
            sharing: {
                session: { enabled: true },
                public: { enabled: true },
                contentKeys: { enabled: true },
                pendingQueueV2: { enabled: true },
            },
            voice: { enabled: false, happierVoice: { enabled: false } },
            social: {
                friends: {
                    enabled: false,
                },
            },
            auth: {
                ...(overrides.authMtlsEnabled
                    ? {
                          mtls: { enabled: true },
                      }
                    : {}),
                recovery: {
                    providerReset: { enabled: providerResetEnabled },
                },
                ui: {
                    recoveryKeyReminder: { enabled: true },
                },
            },
        },
        capabilities: {
            voice: { configured: false, provider: null, requested: false, disabledByBuildPolicy: false },
            social: {
                friends: {
                    allowUsername: false,
                    requiredIdentityProviderId: null,
                },
            },
            oauth: { providers: oauthProviders },
            auth: {
                methods: overrides.authMethods ?? derivedAuthMethods,
                signup: {
                    methods: signupMethods,
                },
                login: { methods: loginMethods, requiredProviders: overrides.requiredProviders ?? [] },
                recovery: { providerReset: { providers: providerResetEnabled ? providerResetProviders : [] } },
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
    });
}
