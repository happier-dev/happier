import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubServerFeaturesFetch, stubServerFeaturesFetchFailure } from './serverFeaturesTestUtils';
import { renderHookAndCollectValues } from './serverFeatureHookHarness.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('useOAuthProviderConfigured', () => {
    it('starts in loading state before the server features snapshot resolves', async () => {
        vi.resetModules();

        const { useOAuthProviderConfigured } = await import('./useOAuthProviderConfigured');
        const seen = await renderHookAndCollectValues(() => useOAuthProviderConfigured('github'));

        expect(seen[0]).toBeNull();
    });

    it('returns false when the provider is not configured', async () => {
        vi.resetModules();
        await stubServerFeaturesFetch({ oauthProviders: { github: { enabled: true, configured: false } } });

        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        await getServerFeaturesSnapshot({ force: true });

        const { useOAuthProviderConfigured } = await import('./useOAuthProviderConfigured');
        const seen = await renderHookAndCollectValues(() => useOAuthProviderConfigured('github'));

        expect(seen.at(-1)).toBe(false);
    });

    it('returns true when the provider is configured', async () => {
        vi.resetModules();
        await stubServerFeaturesFetch({ oauthProviders: { github: { enabled: true, configured: true } } });

        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        await getServerFeaturesSnapshot({ force: true });

        const { useOAuthProviderConfigured } = await import('./useOAuthProviderConfigured');
        const seen = await renderHookAndCollectValues(() => useOAuthProviderConfigured('github'));

        expect(seen.at(-1)).toBe(true);
    });

    it('fails closed when the request fails', async () => {
        vi.resetModules();
        await stubServerFeaturesFetchFailure();

        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        await getServerFeaturesSnapshot({ force: true });

        const { useOAuthProviderConfigured } = await import('./useOAuthProviderConfigured');
        const seen = await renderHookAndCollectValues(() => useOAuthProviderConfigured('github'));

        expect(seen.at(-1)).toBe(false);
    });

    it('normalizes provider id input before reading config state', async () => {
        vi.resetModules();
        await stubServerFeaturesFetch({ oauthProviders: { github: { enabled: true, configured: true } } });

        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        await getServerFeaturesSnapshot({ force: true });

        const { useOAuthProviderConfigured } = await import('./useOAuthProviderConfigured');
        const seen = await renderHookAndCollectValues(() => useOAuthProviderConfigured(' GITHUB '));

        expect(seen.at(-1)).toBe(true);
    });
});
