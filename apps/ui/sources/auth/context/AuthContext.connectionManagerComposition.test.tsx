import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createDeferred, renderScreen } from '@/dev/testkit';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { initializeTerminalRouteRuntimeForTests } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';

installTokenStorageWebPlatformMocks();
await initializeTerminalRouteRuntimeForTests();

describe('AuthContext with the production connection manager', () => {
    let restoreStorage: (() => void) | undefined;
    let restoreLocks: (() => void) | undefined;

    afterEach(async () => {
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        const { resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        resetRuntimeFetch();
        vi.restoreAllMocks();
        restoreLocks?.();
        restoreStorage?.();
        vi.unstubAllGlobals();
    });

    it('keeps Home B credentials when B is requested while Home A already-applied credentials are still loading', async () => {
        restoreStorage = installLocalStorageMock().restore;
        restoreLocks = installWebLockManagerMock().restore;
        vi.stubGlobal('window', { location: { origin: 'https://origin.example.test' } });
        vi.stubGlobal('document', {});
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(async (input) => {
            const url = new URL(String(input));
            if (!['https://a.example.test', 'https://b.example.test'].includes(url.origin)) {
                throw new Error(`Unexpected Home request origin: ${url.origin}`);
            }
            if (url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: {
                encryption: { plaintextStorage: { enabled: true } }, e2ee: { keylessAccounts: { enabled: true } },
            } }));
            return new Response('{}', { status: 404 });
        });

        const profiles = await import('@/sync/domains/server/serverProfiles');
        profiles.resetServerProfilesRuntimeForTests();
        const homeA = await profiles.upsertServerProfile({ serverUrl: 'https://a.example.test', name: 'Home A' });
        const homeB = await profiles.upsertServerProfile({ serverUrl: 'https://b.example.test', name: 'Home B' });
        await profiles.setActiveServerId(homeA.id, { scope: 'device' });
        const homeACredentials = { token: 'e30.eyJzdWIiOiJhY2NvdW50LWEifQ.signature' };
        const homeBCredentials = { token: 'e30.eyJzdWIiOiJhY2NvdW50LWIifQ.signature' };
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const staleCredentialReadStarted = createDeferred<void>();
        const releaseStaleCredentialRead = createDeferred<void>();
        let holdHomeARead = false;
        // Persistence is the external boundary; the connection and Sync owners
        // decide whether this delayed Home A result can still be applied.
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (serverUrl) => {
            if (serverUrl === homeA.serverUrl) {
                if (holdHomeARead) {
                    staleCredentialReadStarted.resolve();
                    await releaseStaleCredentialRead.promise;
                }
                return homeACredentials;
            }
            if (serverUrl === homeB.serverUrl) return homeBCredentials;
            throw new Error(`Unexpected credential endpoint: ${serverUrl}`);
        });
        const connection = await import('@/sync/runtime/orchestration/connectionManager');
        await connection.switchConnectionToActiveServer();
        expect(connection.getAppliedActiveServerId()).toBe(homeA.id);
        const { AuthProvider, getCurrentAuth } = await import('./AuthContext');
        const screen = await renderScreen(React.createElement(AuthProvider, {
            initialCredentials: homeACredentials, children: React.createElement(React.Fragment, null),
        }));
        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected AuthContext to be mounted');
            holdHomeARead = true;
            const staleRefresh = auth.refreshFromActiveServer();
            await staleCredentialReadStarted.promise;
            await profiles.setActiveServerId(homeB.id, { scope: 'device' });
            const newerRefresh = auth.refreshFromActiveServer();
            releaseStaleCredentialRead.resolve();
            await act(async () => { await Promise.all([staleRefresh, newerRefresh]); });
            expect(getCurrentAuth()).toMatchObject({ isAuthenticated: true, credentials: homeBCredentials });
            expect(connection.getAppliedActiveServerSnapshot()).toMatchObject({ serverId: homeB.id, serverUrl: homeB.serverUrl });
            expect(connection.isAppliedActiveServerRuntimeAvailable()).toBe(true);
        } finally {
            releaseStaleCredentialRead.resolve();
            await screen.unmount();
        }
    });
});
