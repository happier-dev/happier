import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubServerFeaturesFetch, stubServerFeaturesFetchFailure } from './serverFeaturesTestUtils';
import { renderHookAndCollectValues } from './serverFeatureHookHarness.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('useOAuthProviderConfigured', () => {
    it('returns false when the provider is not configured', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ oauthProviders: { github: { enabled: true, configured: false } } });

        const { useOAuthProviderConfigured } = await import('./useOAuthProviderConfigured');
        const seen = await renderHookAndCollectValues(() => useOAuthProviderConfigured('github'));

        expect(seen.at(-1)).toBe(false);
    });

    it('returns true when the provider is configured', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ oauthProviders: { github: { enabled: true, configured: true } } });

        const { useOAuthProviderConfigured } = await import('./useOAuthProviderConfigured');
        const seen = await renderHookAndCollectValues(() => useOAuthProviderConfigured('github'));

        expect(seen.at(-1)).toBe(true);
    });

    it('returns null when the request fails', async () => {
        vi.resetModules();
        stubServerFeaturesFetchFailure();

        const { useOAuthProviderConfigured } = await import('./useOAuthProviderConfigured');
        const seen = await renderHookAndCollectValues(() => useOAuthProviderConfigured('github'));

        expect(seen.at(-1)).toBe(null);
    });

    it('normalizes provider id input before reading config state', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ oauthProviders: { github: { enabled: true, configured: true } } });

        const { useOAuthProviderConfigured } = await import('./useOAuthProviderConfigured');
        const seen = await renderHookAndCollectValues(() => useOAuthProviderConfigured(' GITHUB '));

        expect(seen.at(-1)).toBe(true);
    });
});
