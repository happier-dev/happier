import { describe, expect, it } from 'vitest';

import { parseServerFeatures } from './serverFeaturesParse';

function createValidFeaturesResponse() {
    return {
        features: {
            bugReports: {
                enabled: true,
                providerUrl: 'https://reports.happier.dev',
                defaultIncludeDiagnostics: true,
                maxArtifactBytes: 10485760,
                acceptedArtifactKinds: ['ui-mobile', 'ui-desktop', 'cli', 'daemon', 'server', 'stack-service', 'user-note'],
                uploadTimeoutMs: 120000,
                contextWindowMs: 30 * 60 * 1000,
            },
            automations: { enabled: false, existingSessionTarget: false },
            sharing: {
                session: { enabled: true },
                public: { enabled: true },
                contentKeys: { enabled: true },
                pendingQueueV2: { enabled: false },
            },
            voice: { enabled: false, configured: false, provider: null },
            social: { friends: { enabled: true, allowUsername: false, requiredIdentityProviderId: 'github' } },
            oauth: { providers: { github: { enabled: true, configured: true } } },
            auth: {
                signup: { methods: [{ id: 'anonymous', enabled: true }] },
                login: { requiredProviders: [] },
                recovery: { providerReset: { enabled: false, providers: [] } },
                ui: { autoRedirect: { enabled: false, providerId: null }, recoveryKeyReminder: { enabled: true } },
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

        expect(parseServerFeatures(payload)).toBeNull();
    });

    it('rejects legacy /v1/features responses', () => {
        expect(
            parseServerFeatures({
                features: {
                    sessionSharing: true,
                    publicSharing: false,
                    pendingQueueV2: true,
                },
            }),
        ).toBeNull();
    });

    it('ignores legacy githubOAuth feature flags', () => {
        const base = createValidFeaturesResponse();
        const payload = {
            ...base,
            features: {
                ...base.features,
                githubOAuth: true,
            },
        };

        expect(parseServerFeatures(payload)).not.toBeNull();
    });

    it('accepts provider-agnostic offboarding sources in /v1/features', () => {
        const payload = createValidFeaturesResponse();
        payload.features.auth.providers.github.offboarding.source = 'oidc';

        const out = parseServerFeatures(payload);
        expect(out?.features.auth.providers.github.offboarding.source).toBe('oidc');
    });

    it('accepts responses from older servers without bugReports capability', () => {
        const payload = createValidFeaturesResponse();
        delete (payload.features as Record<string, unknown>).bugReports;

        const out = parseServerFeatures(payload);
        expect(out).not.toBeNull();
        expect(out?.features.bugReports.enabled).toBe(false);
        expect(out?.features.bugReports.providerUrl).toBeNull();
    });

    it('accepts responses from older servers without automations capability', () => {
        const payload = createValidFeaturesResponse();
        delete (payload.features as Record<string, unknown>).automations;

        const out = parseServerFeatures(payload);
        expect(out).not.toBeNull();
        expect(out?.features.automations.enabled).toBe(false);
        expect(out?.features.automations.existingSessionTarget).toBe(false);
    });

    it('fails closed for invalid bugReports payload while preserving other capabilities', () => {
        const payload = createValidFeaturesResponse();
        // Make bugReports invalid while keeping automations valid.
        payload.features.bugReports.providerUrl = 'not a url';
        (payload.features as unknown as Record<string, unknown>).automations = { enabled: true, existingSessionTarget: true };

        const out = parseServerFeatures(payload);
        expect(out).not.toBeNull();
        expect(out?.features.automations.enabled).toBe(true);
        expect(out?.features.automations.existingSessionTarget).toBe(true);
        expect(out?.features.bugReports.enabled).toBe(false);
    });
});

