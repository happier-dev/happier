import { vi } from 'vitest';

import type { FeaturesResponse } from '@happier-dev/protocol';

type FixtureOverrides = {
    friendsEnabled?: boolean;
    friendsAllowUsername?: boolean;
    friendsRequiredIdentityProviderId?: string | null;
    voiceEnabled?: boolean;
    happierVoiceEnabled?: boolean;
    voiceConfigured?: boolean;
    automationsEnabled?: boolean;
    automationsExistingSessionTarget?: boolean;
    connectedServicesEnabled?: boolean;
    connectedServicesQuotasEnabled?: boolean;
    updatesOtaEnabled?: boolean;
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

    const voiceEnabled = overrides.voiceEnabled ?? false;
    const happierVoiceEnabled = overrides.happierVoiceEnabled ?? voiceEnabled;
    const voiceConfigured = overrides.voiceConfigured ?? happierVoiceEnabled;

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
            bugReports: { enabled: true },
            automations: {
                enabled: overrides.automationsEnabled ?? true,
                existingSessionTarget: { enabled: overrides.automationsExistingSessionTarget ?? false },
            },
            connectedServices: {
                enabled: overrides.connectedServicesEnabled ?? true,
                quotas: {
                    enabled: overrides.connectedServicesQuotasEnabled ?? false,
                },
            },
            updates: {
                ota: {
                    enabled: overrides.updatesOtaEnabled ?? true,
                },
            },
            sharing: {
                session: { enabled: true },
                public: { enabled: true },
                contentKeys: { enabled: true },
                pendingQueueV2: { enabled: false },
            },
            voice: {
                enabled: voiceEnabled,
                happierVoice: { enabled: happierVoiceEnabled },
            },
            social: {
                friends: {
                    enabled: overrides.friendsEnabled ?? true,
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
            voice: {
                configured: voiceConfigured,
                provider: voiceConfigured ? 'elevenlabs' : null,
                requested: voiceEnabled,
                disabledByBuildPolicy: false,
            },
            social: {
                friends: {
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
                    providerReset: { providers: [] },
                },
                ui: {
                    autoRedirect: { enabled: false, providerId: null },
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
