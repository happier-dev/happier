import { afterEach, describe, expect, it, vi } from 'vitest';

import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { stubServerFeaturesFetch, stubServerFeaturesFetchFailure } from './serverFeaturesTestUtils';
import { renderHookAndCollectValues } from './serverFeatureHookHarness.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('useFriendsAllowUsernameSupport', () => {
    it('returns false when username support is disabled', async () => {
        vi.resetModules();
        await stubServerFeaturesFetch({ friendsAllowUsername: false });
        await getServerFeaturesSnapshot({ force: true });

        const { useFriendsAllowUsernameSupport } = await import('./useFriendsAllowUsernameSupport');
        const seen = await renderHookAndCollectValues(() => useFriendsAllowUsernameSupport());

        expect(seen.at(-1)).toBe(false);
    });

    it('returns true when username support is enabled', async () => {
        vi.resetModules();
        await stubServerFeaturesFetch({ friendsAllowUsername: true });
        await getServerFeaturesSnapshot({ force: true });

        const { useFriendsAllowUsernameSupport } = await import('./useFriendsAllowUsernameSupport');
        const seen = await renderHookAndCollectValues(() => useFriendsAllowUsernameSupport());

        expect(seen.at(-1)).toBe(true);
    });

    it('fails closed when the request fails', async () => {
        vi.resetModules();
        await stubServerFeaturesFetchFailure();
        await getServerFeaturesSnapshot({ force: true });

        const { useFriendsAllowUsernameSupport } = await import('./useFriendsAllowUsernameSupport');
        const seen = await renderHookAndCollectValues(() => useFriendsAllowUsernameSupport());

        expect(seen.at(-1)).toBe(false);
    });

    it('starts in loading state (undefined) before server features resolve', async () => {
        vi.resetModules();
        await stubServerFeaturesFetch({ friendsAllowUsername: false });

        const { useFriendsAllowUsernameSupport } = await import('./useFriendsAllowUsernameSupport');
        const seen = await renderHookAndCollectValues(() => useFriendsAllowUsernameSupport());

        expect(seen[0]).toBeUndefined();
    });
});
