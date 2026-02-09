import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function createValidFeaturesResponse() {
    return {
        features: {
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

function createResponse(payload: unknown) {
    return {
        ok: true,
        json: async () => payload,
    };
}

describe('apiFeatures (voice)', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        globalThis.fetch = vi.fn() as unknown as typeof fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('parses server voice support from /v1/features', async () => {
        const payload = createValidFeaturesResponse();
        payload.features.voice.enabled = false;
        (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createResponse(payload));

        const { getServerFeatures } = await import('./apiFeatures');
        const out = await getServerFeatures({ force: true, timeoutMs: 50 });
        expect(out?.features.voice.enabled).toBe(false);
    });

    it('rejects /v1/features responses missing required sharing keys (no backward compatibility)', async () => {
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
        (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createResponse(payload));

        const { getServerFeatures } = await import('./apiFeatures');
        const out = await getServerFeatures({ force: true, timeoutMs: 50 });
        expect(out).toBeNull();
    });

    it('rejects legacy /v1/features responses (no backward compatibility)', async () => {
        (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
            createResponse({
                features: {
                    sessionSharing: true,
                    publicSharing: false,
                    pendingQueueV2: true,
                },
            }),
        );

        const { getServerFeatures } = await import('./apiFeatures');
        const out = await getServerFeatures({ force: true, timeoutMs: 50 });
        expect(out).toBeNull();
    });

    it('ignores legacy githubOAuth feature flags', async () => {
        const base = createValidFeaturesResponse();
        const payload = {
            ...base,
            features: {
                ...base.features,
                githubOAuth: true,
            },
        };
        (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createResponse(payload));

        const { getServerFeatures } = await import('./apiFeatures');
        const out = await getServerFeatures({ force: true, timeoutMs: 50 });
        expect(out).not.toBeNull();
    });

    it('accepts provider-agnostic offboarding sources in /v1/features', async () => {
        const payload = createValidFeaturesResponse();
        payload.features.auth.providers.github.offboarding.source = 'oidc';
        (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createResponse(payload));

        const { getServerFeatures } = await import('./apiFeatures');
        const out = await getServerFeatures({ force: true, timeoutMs: 50 });
        expect(out?.features.auth.providers.github.offboarding.source).toBe('oidc');
    });
});
