import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeaturesResponse } from '@happier-dev/protocol';

import { createRootLayoutFeaturesResponse } from '@/dev/testkit/rootLayoutTestkit';

let cachedFeatures: FeaturesResponse | null = null;

function buildCachedFeatures(
    providerId: string,
    params: {
        displayName?: string;
        connectButtonColor?: string;
        badgeIconName?: string;
        supportsProfileBadge?: boolean;
    } = {},
): FeaturesResponse {
    const ui = params.displayName
        ? {
              displayName: params.displayName,
              ...(params.connectButtonColor ? { connectButtonColor: params.connectButtonColor } : {}),
              ...(params.badgeIconName ? { badgeIconName: params.badgeIconName } : {}),
              ...(params.supportsProfileBadge !== undefined ? { supportsProfileBadge: params.supportsProfileBadge } : {}),
          }
        : undefined;

    return createRootLayoutFeaturesResponse({
        capabilities: {
            oauth: { providers: { [providerId]: { enabled: true, configured: true } } },
            auth: {
                signup: { methods: [{ id: providerId, enabled: true }] },
                login: { requiredProviders: [] },
                providers: {
                    [providerId]: {
                        enabled: true,
                        configured: true,
                        ...(ui ? { ui } : {}),
                        restrictions: { usersAllowlist: false, orgsAllowlist: false, orgMatch: 'any' },
                        offboarding: {
                            enabled: false,
                            intervalSeconds: 86400,
                            mode: 'per-request-cache',
                            source: 'claims',
                        },
                    },
                },
            },
        },
    });
}

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getCachedReadyServerFeatures: () => cachedFeatures,
}));

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
