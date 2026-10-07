import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountProfileSchema } from '@happier-dev/protocol';

import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { initializeTerminalRouteRuntimeForTests, installTerminalRouteCommonModuleMocks } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { storage } from '@/sync/domains/state/storage';
import { profileDefaults } from '@/sync/domains/profiles/profile';

const navigation = vi.hoisted(() => ({ replace: vi.fn(), back: vi.fn() }));
installTerminalRouteCommonModuleMocks({
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
    it('renders the enabled Friends surface without redirecting /friends to /inbox', async () => {
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
        storage.setState({ profile, friendsLoaded: true, feedLoaded: true });
        navigation.replace.mockClear();
        const Page = (await import('@/app/(app)/friends/index')).default;
        const screen = await renderScreen(<InjectedAuthProvider credentials={connection.credentials}><Page /></InjectedAuthProvider>);

        await vi.waitFor(() => expect(screen.getTextContent()).toContain('friends.emptyTitle'));
        expect(navigation.replace).not.toHaveBeenCalledWith('/inbox');
    });
});
