import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubServerFeaturesFetch, stubServerFeaturesFetchFailure } from './serverFeaturesTestUtils';
import { renderHookAndCollectValues } from './serverFeatureHookHarness.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('useFriendsEnabled', () => {
    it('returns false when the server reports friends are disabled', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ friendsEnabled: false });
        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { 'social.friends': true },
        });

        const { useFriendsEnabled } = await import('./useFriendsEnabled');
        const seen = await renderHookAndCollectValues(() => useFriendsEnabled());

        expect(seen.at(-1)).toBe(false);
    });

    it('fails closed when the request fails', async () => {
        vi.resetModules();
        stubServerFeaturesFetchFailure();
        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { 'social.friends': true },
        });

        const { useFriendsEnabled } = await import('./useFriendsEnabled');
        const seen = await renderHookAndCollectValues(() => useFriendsEnabled());

        expect(seen.at(-1)).toBe(false);
    });

    it('returns true when local and server policy are enabled', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ friendsEnabled: true });
        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().getState().applySettingsLocal({
            experiments: true,
            featureToggles: { 'social.friends': true },
        });

        const { useFriendsEnabled } = await import('./useFriendsEnabled');
        const seen = await renderHookAndCollectValues(() => useFriendsEnabled());

        expect(seen.at(-1)).toBe(true);
    });

    it('returns false when local experiment gate is disabled', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ friendsEnabled: true });
        const { getStorage } = await import('@/sync/domains/state/storage');
        getStorage().getState().applySettingsLocal({
            experiments: false,
            featureToggles: { 'social.friends': true },
        });

        const { useFriendsEnabled } = await import('./useFriendsEnabled');
        const seen = await renderHookAndCollectValues(() => useFriendsEnabled());

        expect(seen.at(-1)).toBe(false);
    });
});
