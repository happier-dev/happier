import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storageStore';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { renderHookAndCollectValues } from './serverFeatureHookHarness.testHelpers';
import { stubServerFeaturesFetch, stubServerFeaturesFetchFailure } from './serverFeaturesTestUtils';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('useFriendsIdentityReadiness', () => {
    it('returns needsUsername when username mode is enabled and no provider is required by server features', async () => {
        vi.resetModules();
        storage.getState().applyProfile({ ...profileDefaults, username: null, linkedProviders: [] });
        await stubServerFeaturesFetch({ friendsAllowUsername: true, friendsRequiredIdentityProviderId: null });
        await getServerFeaturesSnapshot({ force: true });

        const { useFriendsIdentityReadiness } = await import('./useFriendsIdentityReadiness');

        const seen = await renderHookAndCollectValues(() => useFriendsIdentityReadiness());

        expect(seen.at(-1)?.reason).toBe('needsUsername');
        expect(seen.at(-1)?.requiredProviderId).toBe(null);
        expect(seen.at(-1)?.gate.gateVariant).toBe('username');
    });

    it('returns needsProvider when provider mode is enabled and required provider is missing', async () => {
        vi.resetModules();
        storage.getState().applyProfile({ ...profileDefaults, username: null, linkedProviders: [] });
        await stubServerFeaturesFetch({ friendsAllowUsername: false, friendsRequiredIdentityProviderId: 'github' });
        await getServerFeaturesSnapshot({ force: true });

        const { useFriendsIdentityReadiness } = await import('./useFriendsIdentityReadiness');

        const seen = await renderHookAndCollectValues(() => useFriendsIdentityReadiness());

        expect(seen.at(-1)?.reason).toBe('needsProvider');
        expect(seen.at(-1)?.requiredProviderId).toBe('github');
    });

    it('returns ready when required provider is connected and username is present', async () => {
        vi.resetModules();
        storage.getState().applyProfile({
            ...profileDefaults,
            username: 'octocat',
            linkedProviders: [{
                id: 'github',
                login: 'octocat',
                displayName: 'Octocat',
                avatarUrl: '',
                profileUrl: '',
                showOnProfile: true,
            }],
        });
        await stubServerFeaturesFetch({ friendsAllowUsername: false, friendsRequiredIdentityProviderId: 'github' });
        await getServerFeaturesSnapshot({ force: true });

        const { useFriendsIdentityReadiness } = await import('./useFriendsIdentityReadiness');

        const seen = await renderHookAndCollectValues(() => useFriendsIdentityReadiness());

        expect(seen.at(-1)?.reason).toBe('ready');
        expect(seen.at(-1)?.requiredProviderConnected).toBe(true);
    });
});
