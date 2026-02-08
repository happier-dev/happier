import { afterEach, describe, expect, it, vi } from 'vitest';

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
        stubServerFeaturesFetch({ friendsRequiredIdentityProviderId: null });

        const { useFriendsRequiredIdentityProviderId } = await import('./useFriendsRequiredIdentityProviderId');
        const seen = await renderHookAndCollectValues(() => useFriendsRequiredIdentityProviderId());

        expect(seen.at(-1)).toBeNull();
    });

    it('returns normalized provider id when required', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ friendsRequiredIdentityProviderId: ' GITHUB ' });

        const { useFriendsRequiredIdentityProviderId } = await import('./useFriendsRequiredIdentityProviderId');
        const seen = await renderHookAndCollectValues(() => useFriendsRequiredIdentityProviderId());

        expect(seen.at(-1)).toBe('github');
    });

    it('returns null when the request fails', async () => {
        vi.resetModules();
        stubServerFeaturesFetchFailure();

        const { useFriendsRequiredIdentityProviderId } = await import('./useFriendsRequiredIdentityProviderId');
        const seen = await renderHookAndCollectValues(() => useFriendsRequiredIdentityProviderId());

        expect(seen.at(-1)).toBeNull();
    });

    it('returns null when required provider id is blank after normalization', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ friendsRequiredIdentityProviderId: '   ' });

        const { useFriendsRequiredIdentityProviderId } = await import('./useFriendsRequiredIdentityProviderId');
        const seen = await renderHookAndCollectValues(() => useFriendsRequiredIdentityProviderId());

        expect(seen.at(-1)).toBeNull();
    });
});
