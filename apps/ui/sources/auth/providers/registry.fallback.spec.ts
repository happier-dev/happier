import { beforeEach, describe, expect, it, vi } from 'vitest';

type CachedFeaturesShape = {
    features: {
        sharing: {
            session: { enabled: boolean };
            public: { enabled: boolean };
            contentKeys: { enabled: boolean };
            pendingQueueV2: { enabled: boolean };
        };
        voice: { enabled: boolean; configured: boolean; provider: null };
        social: { friends: { enabled: boolean; allowUsername: boolean; requiredIdentityProviderId: null } };
        oauth: { providers: Record<string, { enabled: boolean; configured: boolean }> };
        auth: {
            signup: { methods: Array<{ id: string; enabled: boolean }> };
            login: { requiredProviders: string[] };
            providers: Record<
                string,
                {
                    enabled: boolean;
                    configured: boolean;
                    ui?: {
                        displayName?: string;
                        connectButtonColor?: string;
                        badgeIconName?: string;
                        supportsProfileBadge?: boolean;
                    };
                    restrictions: { usersAllowlist: boolean; orgsAllowlist: boolean; orgMatch: 'any' };
                    offboarding: {
                        enabled: boolean;
                        intervalSeconds: number;
                        mode: 'per-request-cache';
                        source: 'claims';
                    };
                }
            >;
            misconfig: [];
        };
    };
};

let cachedFeatures: CachedFeaturesShape | null = null;

function buildCachedFeatures(
    providerId: string,
    params: {
        displayName?: string;
        connectButtonColor?: string;
        badgeIconName?: string;
        supportsProfileBadge?: boolean;
    } = {},
): CachedFeaturesShape {
    return {
        features: {
            sharing: {
                session: { enabled: true },
                public: { enabled: true },
                contentKeys: { enabled: true },
                pendingQueueV2: { enabled: true },
            },
            voice: { enabled: false, configured: false, provider: null },
            social: { friends: { enabled: false, allowUsername: false, requiredIdentityProviderId: null } },
            oauth: { providers: { [providerId]: { enabled: true, configured: true } } },
            auth: {
                signup: { methods: [{ id: providerId, enabled: true }] },
                login: { requiredProviders: [] },
                providers: {
                    [providerId]: {
                        enabled: true,
                        configured: true,
                        ...(params.displayName || params.connectButtonColor || params.badgeIconName || params.supportsProfileBadge
                            ? {
                                  ui: {
                                      ...(params.displayName ? { displayName: params.displayName } : {}),
                                      ...(params.connectButtonColor ? { connectButtonColor: params.connectButtonColor } : {}),
                                      ...(params.badgeIconName ? { badgeIconName: params.badgeIconName } : {}),
                                      ...(params.supportsProfileBadge !== undefined
                                          ? { supportsProfileBadge: params.supportsProfileBadge }
                                          : {}),
                                  },
                              }
                            : {}),
                        restrictions: { usersAllowlist: false, orgsAllowlist: false, orgMatch: 'any' },
                        offboarding: {
                            enabled: false,
                            intervalSeconds: 86400,
                            mode: 'per-request-cache',
                            source: 'claims',
                        },
                    },
                },
                misconfig: [],
            },
        },
    };
}

vi.mock('@/sync/apiFeatures', async () => {
    const actual = await vi.importActual<typeof import('@/sync/apiFeatures')>('@/sync/apiFeatures');
    return {
        ...actual,
        getCachedServerFeatures: () => cachedFeatures,
    };
});

describe('auth providers registry (fallback)', () => {
    beforeEach(() => {
        cachedFeatures = null;
        vi.resetModules();
    });

    it('returns null for blank provider ids', async () => {
        const { getAuthProvider } = await import('./registry');
        expect(getAuthProvider('')).toBeNull();
        expect(getAuthProvider('   ')).toBeNull();
    });

    it('uses cached provider UI metadata for unknown providers', async () => {
        cachedFeatures = buildCachedFeatures('okta', {
            displayName: 'Acme Okta',
            connectButtonColor: '#000000',
            badgeIconName: 'okta-badge',
            supportsProfileBadge: true,
        });

        const { getAuthProvider } = await import('./registry');
        const okta = getAuthProvider('okta');

        expect(okta).toBeTruthy();
        expect(okta?.id).toBe('okta');
        expect(okta?.displayName).toBe('Acme Okta');
        expect(okta?.connectButtonColor).toBe('#000000');
        expect(okta?.badgeIconName).toBe('okta-badge');
        expect(okta?.supportsProfileBadge).toBe(true);
    });

    it('normalizes provider id lookups and reuses cached fallback instances', async () => {
        cachedFeatures = buildCachedFeatures('okta', { displayName: 'Acme Okta' });
        const { getAuthProvider } = await import('./registry');

        const first = getAuthProvider('OKTA');
        const second = getAuthProvider('okta');
        expect(first).toBe(second);
    });

    it('falls back to capitalized provider id when UI metadata is missing', async () => {
        cachedFeatures = buildCachedFeatures('customsso');
        const { getAuthProvider } = await import('./registry');
        const provider = getAuthProvider('customsso');
        expect(provider?.displayName).toBe('Customsso');
    });
});
