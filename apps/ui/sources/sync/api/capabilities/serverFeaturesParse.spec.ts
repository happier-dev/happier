import { describe, expect, it } from 'vitest';

import { parseServerFeatures } from './serverFeaturesParse';

function createValidFeaturesResponse() {
    return {
        features: {
            bugReports: { enabled: true },
            automations: { enabled: false, existingSessionTarget: { enabled: false } },
            sharing: {
                session: { enabled: true },
                public: { enabled: true },
                contentKeys: { enabled: true },
                pendingQueueV2: { enabled: false },
            },
            voice: { enabled: false },
            social: { friends: { enabled: true } },
            auth: {
                recovery: { providerReset: { enabled: false } },
                ui: { recoveryKeyReminder: { enabled: true } },
            },
        },
        capabilities: {
            bugReports: {
                providerUrl: 'https://reports.happier.dev',
                defaultIncludeDiagnostics: true,
                maxArtifactBytes: 10485760,
                acceptedArtifactKinds: ['ui-mobile', 'ui-desktop', 'cli', 'daemon', 'server', 'stack-service', 'user-note'],
                uploadTimeoutMs: 120000,
                contextWindowMs: 30 * 60 * 1000,
            },
            voice: { configured: false, provider: null, requested: false, disabledByBuildPolicy: false },
            social: { friends: { allowUsername: false, requiredIdentityProviderId: 'github' } },
            oauth: { providers: { github: { enabled: true, configured: true } } },
            auth: {
                signup: { methods: [{ id: 'anonymous', enabled: true }] },
                login: { requiredProviders: [] },
                recovery: { providerReset: { providers: [] } },
                ui: { autoRedirect: { enabled: false, providerId: null } },
                providers: {
                    github: {
                        enabled: true,
                        configured: true,
                        restrictions: { usersAllowlist: false, orgsAllowlist: false, orgMatch: 'any' },
                        offboarding: {
                            enabled: false,
                            intervalSeconds: 600,
                            mode: 'per-request-cache',
                            source: 'oauth_user_token',
                        },
                    },
                },
                misconfig: [],
            },
        },
    };
}

describe('serverFeaturesParse', () => {
    it('parses server voice support from /v1/features', () => {
        const payload = createValidFeaturesResponse();
        payload.features.voice.enabled = false;

        const out = parseServerFeatures(payload);
        expect(out?.features.voice.enabled).toBe(false);
    });

    it('rejects /v1/features responses missing required sharing keys', () => {
        const base = createValidFeaturesResponse();
        const payload = {
            ...base,
            features: {
                ...base.features,
                sharing: {
                    session: { enabled: true },
                    public: { enabled: true },
                },
            },
        };

        const out = parseServerFeatures(payload);
        expect(out).not.toBeNull();
        expect(out?.features.sharing.session.enabled).toBe(true);
        expect(out?.features.sharing.public.enabled).toBe(true);
        expect(out?.features.sharing.contentKeys.enabled).toBe(false);
        expect(out?.features.sharing.pendingQueueV2.enabled).toBe(false);
    });

    it('accepts provider-agnostic offboarding sources in /v1/features', () => {
        const payload = createValidFeaturesResponse();
        payload.capabilities.auth.providers.github.offboarding.source = 'oidc';

        const out = parseServerFeatures(payload);
        expect(out?.capabilities.auth.providers.github.offboarding.source).toBe('oidc');
    });
});
