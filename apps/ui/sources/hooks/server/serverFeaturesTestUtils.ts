import { vi } from 'vitest';

import type { FeaturesResponse } from '@happier-dev/protocol';

type FixtureOverrides = {
    friendsEnabled?: boolean;
    friendsAllowUsername?: boolean;
    friendsRequiredIdentityProviderId?: string | null;
    voiceEnabled?: boolean;
    oauthProviders?: Record<string, { enabled: boolean; configured: boolean }>;
    authProviders?: Record<string, { enabled: boolean; configured: boolean }>;
};

export function buildServerFeaturesResponse(overrides: FixtureOverrides = {}): FeaturesResponse {
    const oauthProviders = overrides.oauthProviders ?? { github: { enabled: true, configured: true } };
    const authProviders = overrides.authProviders ?? {
        github: {
            enabled: true,
            configured: true,
        },
    };

    const authProvidersWithDetails = Object.fromEntries(
        Object.entries(authProviders).map(([id, state]) => [
            id,
            {
                enabled: state.enabled,
                configured: state.configured,
                restrictions: { usersAllowlist: false, orgsAllowlist: false, orgMatch: 'any' as const },
                offboarding: {
                    enabled: false,
                    intervalSeconds: 600,
                    mode: 'per-request-cache' as const,
                    source: 'oauth_user_token',
                },
            },
        ]),
    );

    return {
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
            sharing: {
                session: { enabled: true },
                public: { enabled: true },
                contentKeys: { enabled: true },
                pendingQueueV2: { enabled: false },
            },
            voice: {
                enabled: overrides.voiceEnabled ?? false,
                configured: false,
                provider: null,
            },
            social: {
                friends: {
                    enabled: overrides.friendsEnabled ?? true,
                    allowUsername: overrides.friendsAllowUsername ?? false,
                    requiredIdentityProviderId: overrides.friendsRequiredIdentityProviderId ?? null,
                },
            },
            oauth: {
                providers: oauthProviders,
            },
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
                providers: authProvidersWithDetails,
                misconfig: [],
            },
        },
    };
}

export function stubServerFeaturesFetch(overrides: FixtureOverrides = {}): void {
    const response = buildServerFeaturesResponse(overrides);
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
            ok: true,
            json: async () => response,
        })) as any,
    );
}

export function stubServerFeaturesFetchFailure(): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
            throw new Error('network down');
        }) as any,
    );
}
