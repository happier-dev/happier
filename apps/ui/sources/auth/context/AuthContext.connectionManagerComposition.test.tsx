import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryListResponseV1Schema } from '@happier-dev/protocol';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';

import { createDeferred, renderScreen } from '@/dev/testkit';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { initializeTerminalRouteRuntimeForTests } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';

installTokenStorageWebPlatformMocks();
// Reset before the real manager starts: its generation state shares this runtime's lifetime.
// Rewinding only serverProfiles between tests leaves the manager ahead of every new target.
(await import('@/sync/domains/server/serverProfiles')).resetServerProfilesRuntimeForTests();
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
            if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (url.pathname === AUTHORING_MEMORY_ROUTE_V1) return Response.json(AuthoringMemoryListResponseV1Schema.parse({ rows: [] }));
            if (url.pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json(createPlainProjectAccountRowListFixture());
            if (url.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: {
                encryption: { plaintextStorage: { enabled: true } }, e2ee: { keylessAccounts: { enabled: true } },
            } }));
            return new Response('{}', { status: 404 });
        });

        const profiles = await import('@/sync/domains/server/serverProfiles');
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

    it('retries confirmed Account deletion cleanup for original Home A while Home B remains focused and signed in', async () => {
        restoreStorage = installLocalStorageMock().restore;
        restoreLocks = installWebLockManagerMock().restore;
        vi.stubGlobal('window', { location: { origin: 'https://origin.example.test' } });
        vi.stubGlobal('document', {});
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const erasures: string[] = [];
        setRuntimeFetch(async input => {
            const url = new URL(String(input));
            if (!['https://erase-a.example.test', 'https://erase-b.example.test'].includes(url.origin)) throw new Error(`Unexpected Home: ${url.origin}`);
            if (url.pathname === '/v1/auth/account/delete') { erasures.push(url.origin); return Response.json({ status: 'deleted' }); }
            if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (url.pathname === AUTHORING_MEMORY_ROUTE_V1) return Response.json(AuthoringMemoryListResponseV1Schema.parse({ rows: [] }));
            if (url.pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json(createPlainProjectAccountRowListFixture());
            if (url.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: {
                encryption: { plaintextStorage: { enabled: true } }, e2ee: { keylessAccounts: { enabled: true } },
            } }));
            return new Response('{}', { status: 404 });
        });
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const homeA = await profiles.upsertServerProfile({ serverUrl: 'https://erase-a.example.test', name: 'Erase A' });
        const homeB = await profiles.upsertServerProfile({ serverUrl: 'https://erase-b.example.test', name: 'Keep B' });
        const original = { token: 'e30.eyJzdWIiOiJhY2NvdW50LWEifQ.signature' };
        const other = { token: 'e30.eyJzdWIiOiJhY2NvdW50LWIifQ.signature' };
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await expect(TokenStorage.setCredentialsForServerUrl(homeA.serverUrl, { serverId: homeA.id }, original)).resolves.toBe(true);
        await expect(TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, other)).resolves.toBe(true);
        await profiles.setActiveServerId(homeA.id, { scope: 'device' });
        const connection = await import('@/sync/runtime/orchestration/connectionManager');
        await connection.switchConnectionToActiveServer();
        const { storage } = await import('@/sync/domains/state/storage');
        storage.getState().activateProfileScope({ serverId: profiles.resolveServerProfileScopeIdForIdentifier(homeA.id), accountId: 'account-a' });
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const target = captureActiveServerAccountScopeLifetime();
        if (!target) throw new Error('Expected original Home A Account lifetime');
        const { AuthProvider, getCurrentAuth } = await import('./AuthContext');
        const { AccountDeletedLocalCleanupError, completeAccountDeletion } = await import('@/components/settings/account/accountDeletionLifecycle');
        const { deleteCurrentAccount } = await import('@/sync/api/account/deleteCurrentAccount');
        const screen = await renderScreen(React.createElement(AuthProvider, { initialCredentials: original, children: React.createElement(React.Fragment, null) }));
        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected real Auth provider');
            const replace = vi.fn().mockImplementationOnce(() => { throw new Error('Navigation unavailable'); });
            const failure = await completeAccountDeletion({ target, deleteCurrentAccount: options => deleteCurrentAccount(original, options), replace,
                logout: options => auth.logout({ ...options, target: { serverId: homeA.id, serverUrl: homeA.serverUrl }, expectedCredentials: original }),
            }).then(() => null, (error: unknown) => error);
            expect(failure).toBeInstanceOf(AccountDeletedLocalCleanupError);
            expect(erasures).toEqual([homeA.serverUrl]);
            await act(async () => { await profiles.setActiveServerId(homeB.id, { scope: 'device' }); await auth.refreshFromActiveServer(); });
            expect(getCurrentAuth()?.credentials).toEqual(other);
            await act(async () => { await expect((failure as AccountDeletedLocalCleanupError).retryLocalCleanup()).resolves.toEqual({ kind: 'completed' }); });
            expect(erasures).toEqual([homeA.serverUrl]);
            expect(await TokenStorage.getCredentialsForServerUrl(homeA.serverUrl, { serverId: homeA.id })).toBeNull();
            expect(await TokenStorage.getCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id })).toEqual(other);
            expect(getCurrentAuth()).toMatchObject({ isAuthenticated: true, credentials: other });
        } finally { await screen.unmount(); }
    });
});
