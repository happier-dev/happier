import { storage } from '@/sync/domains/state/storageStore';
import { act } from 'react-test-renderer';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';
import { createSessionFixture, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const profileState = vi.hoisted(() => ({
    resolveProfile: null as null | ((profile: unknown) => void),
    // A real auth context keeps one credentials object for the session.
    auth: { credentials: { token: 'token' } },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ params: { id: 'user-1' } }).module;
});
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => profileState.auth,
}));
vi.mock('@/hooks/session/useNavigateToSession', () => ({ useNavigateToSession: () => vi.fn() }));
vi.mock('@/track', () => ({ trackFriendsConnect: vi.fn() }));
// The social API is the network boundary.
vi.mock('@/sync/api/social/apiFriends', () => ({
    getUserProfile: vi.fn(() => new Promise((resolve) => {
        profileState.resolveProfile = resolve;
    })),
}));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { default: UserProfileScreen } = await import('@/app/(app)/user/[id]');
beforeEach(async () => { await homes.reset(); });
afterEach(async () => {
    profileState.resolveProfile = null;
    setScreenSharingPrivacyActive(false);
    await standardCleanup();
    await homes.reset();
});

describe('UserProfileScreen states', () => {
    it('removes private shared Sessions from the friend list and restores them when sharing ends', async () => {
        const serverId = await homes.addHome({ name: 'Friends', serverUrl: 'https://friend-privacy.test', accountId: 'viewer' });
        await homes.selectHomes([serverId]);
        const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
        const { tryWriteServerEnabledBitInPlace } = await import('@happier-dev/protocol/features/serverEnabledBit');
        const features = createRootLayoutFeaturesResponse();
        expect(tryWriteServerEnabledBitInPlace(features, 'sharing.session', true)).toBe(true);
        homes.answer(serverId, '/v1/features', { body: features });
        homes.answer(serverId, '/v1/features/authenticated', { body: features });
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        storage.setState({ isDataReady: true, sessions: {
            private: createSessionFixture({ id: 'private', serverId, owner: 'user-1', metadata: { name: 'Secret launch', path: '/secret', host: 'tester.local' } }),
            public: createSessionFixture({ id: 'public', serverId, owner: 'user-1', metadata: { name: 'Public plan', path: '/public', host: 'tester.local' } }),
        } });
        const screen = await renderScreen(<UserProfileScreen />);
        await flushHookEffects();
        await act(async () => {
            profileState.resolveProfile?.({ id: 'user-1', firstName: 'Ada', lastName: null, username: 'ada', bio: null,
                avatar: null, status: 'friend', publicKey: null });
        });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Secret launch'));
        expect(screen.getTextContent()).toContain('Public plan');
        await act(async () => {
            storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { [serverId]: ['private'] } });
            storage.getState().setSessionTagAssignmentsOptimistic(serverId, 'private', ['private']);
            setScreenSharingPrivacyActive(true);
        });
        expect(screen.getTextContent()).not.toContain('Secret launch');
        expect(screen.getTextContent()).toContain('Public plan');
        await act(async () => setScreenSharingPrivacyActive(false));
        expect(screen.getTextContent()).toContain('Secret launch');
    });

    it('keeps the page header while the person loads and when they are not found', async () => {
        const screen = await renderScreen(React.createElement(UserProfileScreen));
        await flushHookEffects({ cycles: 2, turns: 1 });

        // Loading: the page keeps its identity instead of a bare spinner.
        expect(screen.findAllByProps({ testID: 'user-profile.header' }).length).toBeGreaterThan(0);

        await React.act(async () => {
            profileState.resolveProfile?.(null);
            await flushHookEffects({ cycles: 2, turns: 1 });
        });

        expect(screen.getTextContent()).toContain('errors.userNotFound');
        expect(screen.findAllByProps({ testID: 'user-profile.header' }).length).toBeGreaterThan(0);
    });
});
