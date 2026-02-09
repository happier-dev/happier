import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubServerFeaturesFetch, stubServerFeaturesFetchFailure } from './serverFeaturesTestUtils';
import { renderHookAndCollectValues } from './serverFeatureHookHarness.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('useInboxFriendsEnabled', () => {
    it('returns false when the server reports friends are disabled', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ friendsEnabled: false });

        const { useInboxFriendsEnabled } = await import('./useInboxFriendsEnabled');
        const seen = await renderHookAndCollectValues(() => useInboxFriendsEnabled());

        expect(seen.at(-1)).toBe(false);
    });

    it('fails open to true when the request fails', async () => {
        vi.resetModules();
        stubServerFeaturesFetchFailure();

        const { useInboxFriendsEnabled } = await import('./useInboxFriendsEnabled');
        const seen = await renderHookAndCollectValues(() => useInboxFriendsEnabled());

        expect(seen.at(-1)).toBe(true);
    });

    it('returns true when the server reports friends are enabled', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ friendsEnabled: true });

        const { useInboxFriendsEnabled } = await import('./useInboxFriendsEnabled');
        const seen = await renderHookAndCollectValues(() => useInboxFriendsEnabled());

        expect(seen.at(-1)).toBe(true);
    });
});
