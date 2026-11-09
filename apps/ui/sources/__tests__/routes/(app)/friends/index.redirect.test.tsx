import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';

import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { initializeTerminalRouteRuntimeForTests, installTerminalRouteCommonModuleMocks } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { storage } from '@/sync/domains/state/storage';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { buildUiFeatureToggleChange } from '@/sync/domains/features/featureRegistry';

const navigation = vi.hoisted(() => ({ replace: vi.fn(), back: vi.fn(), push: vi.fn(), width: 390 }));
installTerminalRouteCommonModuleMocks({
    reactNative: async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock(
        { platformOS: 'android' },
        { useWindowDimensions: () => ({ width: navigation.width, height: 844, scale: 1, fontScale: 1 }) },
    ),
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        pathname: '/friends', router: navigation,
    }).module,
});
await initializeTerminalRouteRuntimeForTests();

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
afterEach(async () => {
    await standardCleanup();
    await connection?.dispose();
    connection = undefined;
    resetServerFeaturesClientForTests();
});

describe('/friends redirect', () => {
    it.each([390, 1024])('opens friend search once from the enabled Friends header at width %i', async (width) => {
        navigation.width = width;
        navigation.push.mockClear();
        const profile = AccountProfileSchema.parse({ ...profileDefaults, id: 'viewer', username: 'viewer' });
        const features = buildServerFeaturesResponse({ friendsEnabled: true, friendsAllowUsername: true });
        connection = await restoreServerAccountForTest({
            serverUrl: 'https://friends-route.example.test', accountId: 'viewer',
            request: async (input) => {
                const path = new URL(String(input)).pathname;
                if (path === '/v1/features') return Response.json(features);
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                return new Response('{}', { status: 404 });
            },
        });
        expect((await getServerFeaturesSnapshot({ serverId: connection.home.id, force: true })).status).toBe('ready');
        storage.getState().applySettingsLocal({ experiments: true,
            ...buildUiFeatureToggleChange(storage.getState().settings, 'social.friends', true) });
        storage.setState({ profile, friendsLoaded: true, feedLoaded: true });
        navigation.replace.mockClear();
        const { FriendsPage } = await import('@/app/(app)/friends/index');
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const screen = await renderScreen(<InjectedAuthProvider credentials={connection.credentials}>
            <DestinationInstanceHost tabId="friends" ref={{ kind: 'friends', params: {} }} pathname="/friends"
                focused visible phone={width === 390} navigation={{ push: navigation.push, replace: navigation.replace, back: navigation.back }}>
                <FriendsPage />
            </DestinationInstanceHost>
        </InjectedAuthProvider>);

        await vi.waitFor(() => expect(screen.getTextContent()).toContain('friends.emptyTitle'));
        expect(navigation.replace).not.toHaveBeenCalledWith('/inbox');
        const buttons = screen.findAllHostsByTestId('friends-add-friend');
        expect(buttons).toHaveLength(1);
        expect(screen.findByTestId('friends-add-friend')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('friends-add-friend');
        expect(navigation.push).toHaveBeenCalledWith('/friends/search');

        await act(async () => { storage.getState().applyProfile({ ...profile, username: null, linkedProviders: [] }); });
        const button = screen.findByTestId('friends-add-friend');
        expect(button?.props.disabled).toBe(true);
        navigation.push.mockClear();
        await screen.pressByTestIdAsync('friends-add-friend');
        expect(navigation.push).not.toHaveBeenCalled();
    });
});
