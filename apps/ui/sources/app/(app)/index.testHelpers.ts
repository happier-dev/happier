import type { FeaturesResponse } from '@happier-dev/protocol';

import { createRootLayoutFeaturesResponse } from '@/dev/testkit/rootLayoutTestkit';

type ProviderState = { enabled: boolean; configured: boolean };

type WelcomeFeaturesOverrides = {
    signupMethods?: Array<{ id: string; enabled: boolean }>;
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
                signup: {
                    methods:
                        overrides.signupMethods ?? [
                            { id: 'anonymous', enabled: true },
                            { id: 'github', enabled: true },
                        ],
                },
                login: { requiredProviders: overrides.requiredProviders ?? [] },
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
