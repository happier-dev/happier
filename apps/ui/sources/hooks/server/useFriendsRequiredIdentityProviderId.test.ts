import { afterEach, describe, expect, it, vi } from 'vitest';

import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { stubServerFeaturesFetch, stubServerFeaturesFetchFailure } from './serverFeaturesTestUtils';
import { renderHookAndCollectValues } from './serverFeatureHookHarness.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('useFriendsRequiredIdentityProviderId', () => {
    it('returns null when no provider is required', async () => {
        vi.resetModules();
        await stubServerFeaturesFetch({ friendsRequiredIdentityProviderId: null });
        await getServerFeaturesSnapshot({ force: true });

        const { useFriendsRequiredIdentityProviderId } = await import('./useFriendsRequiredIdentityProviderId');
        const seen = await renderHookAndCollectValues(() => useFriendsRequiredIdentityProviderId());

        expect(seen.at(-1)).toBeNull();
    });

    it('returns normalized provider id when required', async () => {
        vi.resetModules();
        await stubServerFeaturesFetch({ friendsRequiredIdentityProviderId: ' GITHUB ' });
        await getServerFeaturesSnapshot({ force: true });

        const { useFriendsRequiredIdentityProviderId } = await import('./useFriendsRequiredIdentityProviderId');
        const seen = await renderHookAndCollectValues(() => useFriendsRequiredIdentityProviderId());

        expect(seen.at(-1)).toBe('github');
    });

    it('returns null when the request fails', async () => {
        vi.resetModules();
        await stubServerFeaturesFetchFailure();
        await getServerFeaturesSnapshot({ force: true });

        const { useFriendsRequiredIdentityProviderId } = await import('./useFriendsRequiredIdentityProviderId');
        const seen = await renderHookAndCollectValues(() => useFriendsRequiredIdentityProviderId());

        expect(seen.at(-1)).toBeNull();
    });

    it('returns null when required provider id is blank after normalization', async () => {
        vi.resetModules();
        await stubServerFeaturesFetch({ friendsRequiredIdentityProviderId: '   ' });
        await getServerFeaturesSnapshot({ force: true });

        const { useFriendsRequiredIdentityProviderId } = await import('./useFriendsRequiredIdentityProviderId');
        const seen = await renderHookAndCollectValues(() => useFriendsRequiredIdentityProviderId());

        expect(seen.at(-1)).toBeNull();
    });
});
