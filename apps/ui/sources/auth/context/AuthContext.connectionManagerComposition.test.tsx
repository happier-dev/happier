import React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryListResponseV1Schema } from '@happier-dev/protocol/account/authoringMemory';
import { ActionAutomationIndexV1Schema, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { createMachineDataEncryptionKeyV1 } from '@happier-dev/protocol/machines/machineStoredContent';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';

const nativeStorage = vi.hoisted(() => ({
    values: new Map<string, string>(),
    beforeRead: undefined as ((key: string) => Promise<void>) | undefined,
}));
const nativeStorageBoundary = {
    getItemAsync: async (key: string) => { await nativeStorage.beforeRead?.(key); return nativeStorage.values.get(key) ?? null; },
    setItemAsync: async (key: string, value: string) => { nativeStorage.values.set(key, value); },
    deleteItemAsync: async (key: string) => { nativeStorage.values.delete(key); },
};
installTokenStorageWebPlatformMocks({ secureStore: () => nativeStorageBoundary });
// Install storage and transport boundaries before runtime-bearing helpers load their consumers.
const { initializeAuthRouteRuntimeForTests } = await import('@/dev/testkit/harness/authRouteRuntimeHarness');
const { createPlainAccountEncryptionCurrentnessFixture } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
const { encodeBase64 } = await import('@/encryption/base64');
const { createEncryptionFromAuthCredentials } = await import('@/auth/encryption/createEncryptionFromAuthCredentials');
// Route replacement is an external navigation boundary; mounted Action and Auth lifetimes remain real.
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// Reset before the real manager starts: its generation state shares this runtime's lifetime.
// Rewinding only serverProfiles between tests leaves the manager ahead of every new target.
(await import('@/sync/domains/server/serverProfiles')).resetServerProfilesRuntimeForTests();
await initializeAuthRouteRuntimeForTests();

describe('AuthContext with the production connection manager', () => {
    let restoreStorage: (() => void) | undefined;
    let restoreLocks: (() => void) | undefined;
    let restorePlatform: (() => void) | undefined;

    afterEach(async () => {
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        const { resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        resetRuntimeFetch();
        nativeStorage.beforeRead = undefined;
        nativeStorage.values.clear();
        restorePlatform?.();
        restorePlatform = undefined;
        vi.restoreAllMocks();
        restoreLocks?.();
        restoreStorage?.();
        vi.unstubAllGlobals();
    });

    it('completes Plain login and applies its transport while Account bootstrap is pending', async () => {
        restoreStorage = installLocalStorageMock().restore;
        restoreLocks = installWebLockManagerMock().restore;
        vi.stubGlobal('window', { location: { origin: 'https://origin.example.test' } });
        vi.stubGlobal('document', {});
        const mode = createDeferred<Response>();
        const modeStarted = createDeferred<void>();
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(async input => {
            const url = new URL(String(input));
            if (url.origin !== 'https://login-pending.example.test') throw new Error(`Unexpected Home: ${url.origin}`);
            if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.pathname === '/v1/account/encryption') {
                modeStarted.resolve();
                return await mode.promise;
            }
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v1/machines') {
                return Response.json([]);
            }
            if (url.pathname === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (url.pathname === AUTHORING_MEMORY_ROUTE_V1) return Response.json(AuthoringMemoryListResponseV1Schema.parse({ rows: [] }));
            if (url.pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json(createPlainProjectAccountRowListFixture());
            if (url.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: {
                encryption: { plaintextStorage: { enabled: true } }, e2ee: { keylessAccounts: { enabled: true } },
            } }));
            return new Response('{}', { status: 404 });
        });
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const home = await profiles.upsertServerProfile({ serverUrl: 'https://login-pending.example.test' });
        await profiles.setActiveServerId(home.id, { scope: 'device' });
        // This independent Plain Account must not seed the later recovery Account's retained projection.
        const credentials = { token: 'e30.eyJzdWIiOiJhY2NvdW50LXBlbmRpbmctbG9naW4ifQ.pending-login' };
        const connection = await import('@/sync/runtime/orchestration/connectionManager');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { AuthProvider, getCurrentAuth } = await import('./AuthContext');
        const screen = await renderScreen(React.createElement(AuthProvider, {
            initialCredentials: null, children: React.createElement(React.Fragment, null),
        }));
        try {
            await act(async () => {
                await expect(getCurrentAuth()!.loginWithCredentials(credentials)).resolves.toEqual({ kind: 'completed' });
                await modeStarted.promise;
            });
            expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toEqual(credentials);
            expect(getCurrentAuth()).toMatchObject({ isAuthenticated: true, credentials });
            // Plain credentials have no encryption material to resolve before the transport applies.
            // Account content bootstrap can still be pending after that connection is available.
            expect(connection.isAppliedActiveServerRuntimeAvailable()).toBe(true);
            mode.resolve(Response.json({ mode: 'plain', updatedAt: 1 }));
            await act(async () => {
                await connection.switchConnectionToActiveServer();
            });
            expect(connection.isAppliedActiveServerRuntimeAvailable()).toBe(true);
        } finally {
            mode.resolve(Response.json({ mode: 'plain', updatedAt: 1 }));
            await connection.switchConnectionToActiveServer();
            await screen.unmount();
        }
    });

    it('opens an E2EE Machine when recovery-key login supersedes a pending token-only Sync bootstrap', async () => {
        restoreStorage = installLocalStorageMock().restore;
        restoreLocks = installWebLockManagerMock().restore;
        vi.stubGlobal('window', { location: { origin: 'https://origin.example.test' } });
        vi.stubGlobal('document', {});
        const secret = new Uint8Array(32).fill(21);
        const credentials = { token: 'e30.eyJzdWIiOiJhY2NvdW50LWEifQ.recovery', secret: encodeBase64(secret, 'base64url') };
        const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } });
        const machineKey = createMachineDataEncryptionKeyV1({ material: material.material, randomBytes: length => new Uint8Array(length).fill(22) });
        const fixture = createMachineFixture({ id: 'recovered-machine' });
        const producer = await createEncryptionFromAuthCredentials(credentials);
        await producer.initializeMachines(new Map([[fixture.id, machineKey.encryptionKey]]));
        const metadata = await producer.getMachineEncryption(fixture.id)!.encryptMetadata(fixture.metadata!);
        const row = { ...fixture, metadata, revokedAt: null, installationId: 'recovered-installation',
            dataEncryptionKey: encodeBase64(machineKey.dataEncryptionKey),
            access: { custodian: { accountId: 'account-a', displayName: 'Test Account' }, role: 'manage', resourceMode: 'e2ee', accessState: 'ready' } };
        const modeStarted = createDeferred<void>();
        let holdMode = true;
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            if (url.origin !== 'https://restore.example.test') throw new Error(`Unexpected Home: ${url.origin}`);
            if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.pathname === '/v1/account/encryption') {
                if (holdMode) {
                    modeStarted.resolve();
                    return await new Promise<Response>((_resolve, reject) => {
                        const abort = () => reject(new DOMException('Credential request retired', 'AbortError'));
                        if (init?.signal?.aborted) abort();
                        else init?.signal?.addEventListener('abort', abort, { once: true });
                    });
                }
                return Response.json({ mode: 'e2ee', updatedAt: 1 });
            }
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json({ mode: 'e2ee', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint),
                updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' } });
            if (url.pathname === '/v1/machines') return Response.json([row]);
            if (url.pathname === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (url.pathname === AUTHORING_MEMORY_ROUTE_V1) return Response.json(AuthoringMemoryListResponseV1Schema.parse({ rows: [] }));
            if (url.pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json(ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', coverage: 'complete', rows: [] }));
            if (url.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            return new Response('{}', { status: 404 });
        });
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const home = await profiles.upsertServerProfile({ serverUrl: 'https://restore.example.test' });
        await profiles.setActiveServerId(home.id, { scope: 'device' });
        const connection = await import('@/sync/runtime/orchestration/connectionManager');
        const tokenOnly = { token: credentials.token };
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, tokenOnly)).toBe(true);
        const { AuthProvider, getCurrentAuth } = await import('./AuthContext');
        const screen = await renderScreen(React.createElement(AuthProvider, { initialCredentials: tokenOnly, children: React.createElement(React.Fragment, null) }));
        // The old HTTP request is canceled by credential retirement. Keep the
        // production switch in flight so restore must rebind through its owner.
        const priorSwitch = connection.switchConnectionToActiveServer().catch(error => error);
        try {
            await modeStarted.promise;
            const { sync } = await import('@/sync/sync');
            expect(sync.encryption).toBeNull();
            holdMode = false;
            await act(async () => { expect(await getCurrentAuth()!.loginWithCredentials(credentials)).toEqual({ kind: 'completed' }); });
            await act(async () => { await priorSwitch; });
            await flushHookEffects({ cycles: 30 });
            expect(sync.getCredentials()).toEqual(credentials);
            expect(sync.encryption).not.toBeNull();
            const { storage } = await import('@/sync/domains/state/storage');
            await vi.waitFor(() => expect(storage.getState().machines[fixture.id]).toMatchObject({
                metadata: fixture.metadata, availability: { kind: 'available' },
            }));
        } finally {
            holdMode = false;
            await screen.unmount();
        }
    });

    it('refreshes same-Account Auth transport while retaining captured Action authority', async () => {
        restoreStorage = installLocalStorageMock().restore;
        restoreLocks = installWebLockManagerMock().restore;
        vi.stubGlobal('window', { location: { origin: 'https://origin.example.test' } });
        vi.stubGlobal('document', {});
        const mode = createDeferred<Response>();
        let holdMode = false;
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(async input => {
            const url = new URL(String(input));
            if (url.origin !== 'https://credential.example.test') throw new Error(`Unexpected Home: ${url.origin}`);
            if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.pathname === '/test/captured-action') return Response.json({ ok: true });
            if (url.pathname === '/v1/account/encryption') return holdMode ? mode.promise : Response.json({ mode: 'plain', updatedAt: 1 });
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
        const home = await profiles.upsertServerProfile({ serverUrl: 'https://credential.example.test' });
        await profiles.setActiveServerId(home.id, { scope: 'device' });
        const original = { token: 'e30.eyJzdWIiOiJhY2NvdW50LWEifQ.original' };
        const refreshed = { token: 'e30.eyJzdWIiOiJhY2NvdW50LWEifQ.refreshed' };
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, original)).toBe(true);
        const connection = await import('@/sync/runtime/orchestration/connectionManager');
        await connection.switchConnectionToActiveServer();
        const { storage } = await import('@/sync/domains/state/storage');
        storage.getState().activateProfileScope({ serverId: profiles.resolveServerProfileScopeIdForIdentifier(home.id), accountId: 'account-a' });
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected current Account owner');
        const { AuthProvider, getCurrentAuth } = await import('./AuthContext');
        const screen = await renderScreen(React.createElement(AuthProvider, {
            initialCredentials: original, children: React.createElement(React.Fragment, null),
        }));
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const actionAccount = await captureLazyActionAccountContext(home.id);
        const actionRetired = vi.fn();
        actionAccount.accountLifetime.onRetire(actionRetired);
        const reapplied = createDeferred<void>();
        const release = connection.subscribeAppliedActiveServerRuntimeAvailability(available => {
            if (available) reapplied.resolve();
        });
        try {
            await act(async () => {
                expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { ...original })).toBe(true);
            });
            expect(captureActiveServerAccountScopeLifetime()).toBe(lifetime);
            expect(lifetime.isCurrent()).toBe(true);
            holdMode = true;
            expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, refreshed)).toBe(true);
            expect(lifetime.isCurrent()).toBe(false);
            expect(connection.isAppliedActiveServerRuntimeAvailable()).toBe(false);
            expect(actionAccount.accountLifetime.isCurrent()).toBe(true);
            expect(actionRetired).not.toHaveBeenCalled();
            mode.resolve(Response.json({ mode: 'plain', updatedAt: 1 }));
            await act(async () => { await reapplied.promise; });
            await flushHookEffects({ cycles: 30 });
            expect(getCurrentAuth()).toMatchObject({ isAuthenticated: true, credentials: refreshed });
            const replacement = captureActiveServerAccountScopeLifetime();
            expect(replacement).not.toBe(lifetime);
            expect(replacement?.isCurrent()).toBe(true);
            expect(replacement?.scope).toEqual(lifetime.scope);
            await expect(actionAccount.runPrepared(async () => (await actionAccount.request('/test/captured-action')).json())).resolves.toEqual({ ok: true });
        } finally {
            mode.resolve(Response.json({ mode: 'plain', updatedAt: 1 }));
            actionAccount.dispose();
            release();
            await screen.unmount();
        }
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
        expect(await TokenStorage.setCredentialsForServerUrl(homeA.serverUrl, { serverId: homeA.id }, homeACredentials)).toBe(true);
        expect(await TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, homeBCredentials)).toBe(true);
        // Device-local storage is the external persistence port; TokenStorage, the connection
        // and Sync owners above it decide whether this delayed Home A result can still be applied.
        const deviceStorage = await import('@/auth/storage/deviceLocalStorage');
        const readDeviceString = deviceStorage.readDeviceLocalStorageString;
        vi.spyOn(deviceStorage, 'readDeviceLocalStorageString').mockImplementation(async (key) => {
            const raw = await readDeviceString(key);
            if (holdHomeARead && raw?.includes(homeACredentials.token)) {
                staleCredentialReadStarted.resolve();
                await releaseStaleCredentialRead.promise;
            }
            return raw;
        });
        const connection = await import('@/sync/runtime/orchestration/connectionManager');
        await connection.switchConnectionToActiveServer();
        expect(connection.getAppliedActiveServerId()).toBe(homeA.id);
        const { AuthProvider, getCurrentAuth } = await import('./AuthContext');
        const screen = await renderScreen(React.createElement(AuthProvider, {
            initialCredentials: homeACredentials, children: React.createElement(React.Fragment, null),
        }));
        try {
            // Finish the mounted provider's initial refresh before delaying a new read.
            await connection.switchConnectionToActiveServer();
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

    it.each([
        { name: 'approved focused sign-out', entrypoint: 'approval' },
        { name: 'reverse-dispatched focused sign-out', entrypoint: 'reverse' },
        { name: 'unrelated reverse-dispatch scope loss', entrypoint: 'reverse-loss' },
        { name: 'approved all-credentials forget', entrypoint: 'forget' },
        { name: 'approved all-credentials forget with failed navigation', entrypoint: 'forget-navigation' },
        { name: 'stale all-credentials forget', entrypoint: 'stale-forget' },
        { name: 'mounted focused sign-out during its own route replacement', entrypoint: 'mounted-signout' },
        { name: 'mounted workspace sign-out without returning to Account', entrypoint: 'mounted-workspace-signout' },
        { name: 'mounted focused sign-out after unrelated caller unmount', entrypoint: 'mounted-cancel' },
        { name: 'mounted focused sign-out with failed own route replacement', entrypoint: 'mounted-navigation-failure' },
        { name: 'approved Account deletion with renewed resource review', entrypoint: 'delete' },
        { name: 'waived Account deletion with exact retained-resource dispositions', entrypoint: 'delete-waived' },
        { name: 'refused Account deletion', entrypoint: 'delete-reject' },
        { name: 'retired Account deletion confirmation', entrypoint: 'delete-stale' },
        { name: 'cancelled Account resource removal review', entrypoint: 'delete-resource-cancel' },
    ] as const)('runs $name through the real Auth owner with exact credential custody', async ({ entrypoint }) => {
        restoreStorage = installLocalStorageMock().restore;
        restoreLocks = installWebLockManagerMock().restore;
        if (entrypoint === 'stale-forget') {
            // Native secure-storage reads provide a real asynchronous custody boundary.
            const { Platform } = await import('react-native');
            const previous = Object.getOwnPropertyDescriptor(Platform, 'OS');
            Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
            restorePlatform = () => {
                if (previous) Object.defineProperty(Platform, 'OS', previous);
            };
        }
        vi.stubGlobal('window', { location: { origin: 'https://origin.example.test' } });
        vi.stubGlobal('document', {});
        const workspace = entrypoint === 'mounted-workspace-signout';
        const routeWrites: string[] = [];
        const location = { origin: 'https://origin.example.test', pathname: '/settings/account', search: '', hash: '' };
        const history = { state: null as unknown,
            replaceState: (state: unknown, _unused: string, href?: string | URL | null) => {
                history.state = state;
                if (!href) return;
                const next = new URL(href, location.origin);
                location.pathname = next.pathname; location.search = next.search; location.hash = next.hash;
                routeWrites.push(next.pathname);
            },
            pushState: (state: unknown, unused: string, href?: string | URL | null) => history.replaceState(state, unused, href),
            go: () => {},
        };
        if (workspace) {
            const { Platform } = await import('react-native');
            const previous = Object.getOwnPropertyDescriptor(Platform, 'OS');
            Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
            restorePlatform = () => { if (previous) Object.defineProperty(Platform, 'OS', previous); };
            const events = new EventTarget();
            vi.stubGlobal('window', { location, history, sessionStorage: { getItem: () => 'main' },
                addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
                dispatchEvent: events.dispatchEvent.bind(events) });
        }
        const { ACCOUNT_ERASURE_HTTP_PATH_V1, ACCOUNT_ERASURE_CONFIRMATION_V1, AccountErasureRequestV1Schema } = await import('@happier-dev/protocol/auth/accountErasure');
        const { createManagedResourceDependencyFixture } = await import('@/dev/testkit/fixtures/managedResourceDependencyFixtures');
        let retainedResources: ReturnType<typeof createManagedResourceDependencyFixture>[] = [];
        const erasureRequests: import('@happier-dev/protocol/auth/accountErasure').AccountErasureRequestV1[] = [];
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === ACCOUNT_ERASURE_HTTP_PATH_V1) {
                erasureRequests.push(AccountErasureRequestV1Schema.parse(JSON.parse(String(init?.body))));
                return erasureRequests.length <= retainedResources.length
                    ? Response.json({ error: 'account_erasure_managed_resources_review_required',
                        resources: [retainedResources[erasureRequests.length - 1]] }, { status: 409 })
                    : Response.json({ status: 'deleted' });
            }
            if (url.pathname === '/test/approval') return Response.json({ ok: true });
            if (url.pathname === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1) return Response.json(ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }));
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
        const home = await profiles.upsertServerProfile({ serverUrl: 'https://action-logout.test' });
        const otherHome = await profiles.upsertServerProfile({ serverUrl: 'https://action-keep.test' });
        retainedResources = [7, 8].map(revision => ({ ...createManagedResourceDependencyFixture(revision),
            homeId: home.id, custodianAccountId: 'account-a' }));
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const credentials = { token: createAccountTokenForTests('account-a', { currentAccount: true }) };
        const other = { token: createAccountTokenForTests('account-b', { currentAccount: true }) };
        const replacement = { token: createAccountTokenForTests('replacement-account', { currentAccount: true }) };
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials);
        await TokenStorage.setCredentialsForServerUrl(otherHome.serverUrl, { serverId: otherHome.id }, other);
        await profiles.setActiveServerId(home.id, { scope: 'device' });
        await (await import('@/sync/runtime/orchestration/connectionManager')).switchConnectionToActiveServer();
        (await import('@/sync/domains/state/storage')).storage.getState().activateProfileScope({ serverId: home.id, accountId: 'account-a' });
        const { AuthProvider, useAuth } = await import('./AuthContext');
        const mounted = entrypoint.startsWith('mounted');
        const { useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution');
        let author: ReturnType<typeof useMountedActionExecution> | undefined;
        let removeAuthor: (() => void) | undefined;
        function MountedAccountAuthor() {
            author = useMountedActionExecution({ serverId: home.id, accountId: 'account-a' });
            return null;
        }
        function NavigationOwner() {
            const [visible, setVisible] = React.useState(true);
            removeAuthor = () => { setVisible(false); };
            return visible ? React.createElement(MountedAccountAuthor) : null;
        }
        let children: React.ReactElement = mounted ? React.createElement(NavigationOwner) : React.createElement(React.Fragment, null);
        let restoreWorkspaceSettings: (() => void) | undefined;
        if (workspace) {
            const { WorkspaceProvider } = await import('@/components/appShell/workspace/WorkspaceProvider');
            const { resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
            const { storage } = await import('@/sync/domains/state/storage');
            const previous = { isDataReady: storage.getState().isDataReady, settings: storage.getState().settings };
            restoreWorkspaceSettings = () => storage.setState(previous);
            storage.setState({ isDataReady: true, settings: { ...storage.getState().settings, workspaceTabsSyncEnabled: false } });
            const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
                externalSessions: false, inbox: false, workflows: false, friends: false,
            } });
            const authorElement = children;
            function AccountWorkspace() {
                return React.createElement(WorkspaceProvider, { enabled: useAuth().isAuthenticated,
                    catalog, children: authorElement });
            }
            children = React.createElement(AccountWorkspace);
        }
        const screen = await renderScreen(React.createElement(AuthProvider, { initialCredentials: credentials, children }));
        const account = await (await import('@/sync/ops/actions/actionAccountContext')).captureLazyActionAccountContext(home.id);
        const { createUiAccountLifecycleAction } = await import('@/sync/ops/actions/accountLifecycleActionDeps');
        const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
        const { createActionExecutorBoundaryFixture } = await import('@/dev/testkit/fixtures/actionExecutorBoundary');
        const { ApprovalRequestV2Schema } = await import('@happier-dev/protocol/approvals/approvalRequestV1');
        const { ActionsSettingsV1Schema } = await import('@happier-dev/protocol/actions/actionSettings');


        const { Modal } = await import('@/modal/ModalManager');
        type Presentation = Parameters<Parameters<typeof Modal.registerProvider>[0]['showModal']>[0];
        const presentations: { id: string; config: Presentation }[] = [];
        // Only dialog presentation and human input are external. The real manager owns pending dialog resolution.
        const releasePresentation = entrypoint.startsWith('delete') ? Modal.registerProvider({
            showModal: config => {
                const id = `account-dialog-${presentations.length}`;
                presentations.push({ id, config });
                return id;
            },
            hideModal: () => {}, hideAllModals: () => {}, updateCustomModalProps: () => {},
        }) : undefined;
        let request: import('@happier-dev/protocol/approvals/approvalRequestV1').ApprovalRequestV2 | null = null;
        const confirmations: { resolve: (confirmed: boolean) => void }[] = [];
        const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: { 'account.signOut': { approvalRequiredSurfaces: ['ui'] } },
            ...(entrypoint === 'delete-waived' ? { approvalWaivedSurfaces: { 'account.delete': ['agent'] } } : {}) });
        let credentialReplacedDuringGuard = false;
        if (entrypoint === 'stale-forget') {
            // Another actor installs its credential during the actual OS keychain read.
            // TokenStorage parsing, first-key custody and Auth admission are not mocked.
            nativeStorage.beforeRead = async key => {
                if (!key.includes('pending_external_auth')) return;
                nativeStorage.beforeRead = undefined;
                await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, replacement);
                credentialReplacedDuringGuard = true;
            };
        }
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            accountLifecycleAction: createUiAccountLifecycleAction(account, async () => {
                if (entrypoint === 'forget-navigation') throw new Error('Navigation unavailable');
            }),
            readActionsSettings: () => settings,
            presentUserActionConfirmation: () => new Promise<boolean>(resolve => { confirmations.push({ resolve }); }),
            isApprovalExecutionOriginCurrent: async () => account.accountLifetime.isCurrent(),
            approvalsCreate: async input => {
                request = ApprovalRequestV2Schema.parse(input.request);
                return { artifactId: 'logout' };
            },
        }));
        const context = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
            serverId: home.id, expectedAccountId: 'account-a', runtimeAccountId: 'account-a', actionRequestId: 'leave-home' };
        let pendingOwnAction: ReturnType<typeof executor.execute> | undefined;
        try {
            if (mounted) {
                await flushHookEffects({ cycles: 10 });
                expect(author?.ready).toBe(true);
                if (!author || !removeAuthor) throw new Error('Expected mounted Account author');
                const execute = author.execute;
                const remove = removeAuthor;
                const { router } = await import('expo-router');
                const replace = vi.spyOn(router, 'replace').mockImplementation(() => {
                    if (entrypoint === 'mounted-navigation-failure') throw new Error('Navigation unavailable');
                    if (workspace) {
                        act(() => { history.replaceState(history.state, '', '/'); });
                        return;
                    }
                    // Expo navigation unmounts the Account route, not the app's Auth provider.
                    act(() => { remove(); });
                });
                routeWrites.length = 0;
                if (entrypoint === 'mounted-cancel') await act(async () => { remove(); });
                const result = await execute('account.signOut', { serverId: home.id, accountId: 'account-a' });
                expect(await TokenStorage.getCredentialsForServerUrl(otherHome.serverUrl, { serverId: otherHome.id })).toEqual(other);
                if (entrypoint === 'mounted-cancel') {
                    expect(result).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
                    expect(replace).not.toHaveBeenCalled();
                    expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toEqual(credentials);
                } else if (entrypoint === 'mounted-navigation-failure') {
                    // The signed-in page is retired before credentials are removed, so a route that cannot
                    // be left keeps the credentials and reports the failure instead of a receipt.
                    expect(replace).toHaveBeenCalledWith('/');
                    expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toEqual(credentials);
                    expect(result).toMatchObject({ ok: false });
                } else {
                    if (workspace) {
                        expect(routeWrites).toContain('/');
                        expect(routeWrites).not.toContain('/settings/account');
                        expect(location.pathname).toBe('/');
                    } else expect(replace).toHaveBeenCalledWith('/');
                    expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toBeNull();
                    expect(result).toEqual({ ok: true, result: { status: 'signed_out' } });
                }
                return;
            }
            if (entrypoint === 'reverse' || entrypoint === 'reverse-loss') {
                const { createUiClientActionReverseHandler } = await import('@/sync/ops/actions/clientActionReverseDispatch');
                const receive = createUiClientActionReverseHandler({ serverId: home.id, accountId: 'account-a',
                    isCurrent: () => { try { account.assertCurrent(); return true; } catch { return false; } } });
                if (entrypoint === 'reverse-loss') {
                    const { registerPendingNavigationRuntime } = await import('@/activity/source/pendingNavigationRuntime');
                    // Mounted navigation is the UI effect boundary; Account and credential retirement stay real.
                    const release = registerPendingNavigationRuntime(async () => {
                        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, replacement);
                        return { status: 'opened' };
                    });
                    try {
                        const received = await receive({ v: 1, actionId: 'session.pending.next', input: {},
                            context: { surface: 'agent', authority: 'account_automation' },
                        }, { signal: new AbortController().signal });
                        expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toEqual(replacement);
                        expect(await TokenStorage.getCredentialsForServerUrl(otherHome.serverUrl, { serverId: otherHome.id })).toEqual(other);
                        // A committed Next navigation may retire its starting Account scope; only its closed,
                        // status-only completion survives that (accountAuthorityRetirementStatuses).
                        expect(received).toEqual({ v: 1, execution: { ok: true, result: { status: 'opened' } } });
                        return;
                    } finally { release(); }
                }
                const received = await receive({ v: 1, actionId: 'account.signOut',
                    input: { serverId: home.id, accountId: 'account-a' },
                    context: { surface: 'agent', authority: 'account_automation' },
                }, { signal: new AbortController().signal });
                expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toBeNull();
                expect(await TokenStorage.getCredentialsForServerUrl(otherHome.serverUrl, { serverId: otherHome.id })).toEqual(other);
                expect(received).toEqual({ v: 1, execution: { ok: true, result: { status: 'signed_out' } } });
                return;
            }
            const forgetting = entrypoint === 'forget' || entrypoint === 'forget-navigation' || entrypoint === 'stale-forget';
            const deleting = entrypoint.startsWith('delete');
            const actionId = deleting ? 'account.delete' : forgetting ? 'account.credentials.forgetAll' : 'account.signOut';
            if (entrypoint === 'delete-waived') {
                const pending = executor.execute('account.delete', { serverId: home.id, accountId: 'account-a' },
                    { ...context, surface: 'agent', authority: 'account_automation', actionsSettings: settings });
                try {
                    const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
                    await waitForHomeGovernance(() => expect(presentations.length > 0 || erasureRequests.length > 0).toBe(true));
                    expect(presentations).toEqual([]);
                    expect(await pending).toMatchObject({ ok: true, result: { status: 'deleted' } });
                    expect(request).toBeNull();
                    expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toBeNull();
                    expect(await TokenStorage.getCredentialsForServerUrl(otherHome.serverUrl, { serverId: otherHome.id })).toEqual(other);
                } finally {
                    for (const presentation of presentations) {
                        if (presentation.config.type === 'prompt') Modal.resolvePrompt(presentation.id, null);
                        if (presentation.config.type === 'confirm') Modal.resolveConfirm(presentation.id, false);
                    }
                    await pending;
                }
                return;
            }
            pendingOwnAction = executor.execute(actionId, { serverId: home.id, accountId: 'account-a',
                ...(forgetting ? { scope: 'all-credentials' } : {}) }, context);
            await vi.waitFor(() => expect(confirmations).toHaveLength(1));
            expect(request).toBeNull();
            expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toEqual(credentials);
            if (deleting) {
                expect(presentations).toEqual([]);
                expect(erasureRequests).toEqual([]);
                if (entrypoint === 'delete-stale') {
                    await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, replacement);
                }
                confirmations[0]!.resolve(entrypoint !== 'delete-reject');
                if (entrypoint === 'delete' || entrypoint === 'delete-resource-cancel') {
                    const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
                    for (const [index, resource] of retainedResources.entries()) {
                        await waitForHomeGovernance(() => expect(presentations[index]?.config.type).toBe('confirm'));
                        const presentation = presentations[index];
                        const { describeManagedRemovalResource } = await import('@/components/settings/machines/managed/reviewManagedResourceRemoval');
                        // `showModal` receives a non-distributive Omit of the modal union, so read the confirm field structurally.
                        expect(presentation.config.type === 'confirm' && 'messageParagraphs' in presentation.config ? presentation.config.messageParagraphs : undefined)
                            .toContainEqual({ text: describeManagedRemovalResource(resource) });
                        expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toEqual(credentials);
                        Modal.resolveConfirm(presentation.id, entrypoint !== 'delete-resource-cancel');
                        Modal.hide(presentation.id);
                        if (entrypoint === 'delete-resource-cancel') break;
                    }
                }
                const settled = await pendingOwnAction;
                expect(request).toBeNull();
                expect(await TokenStorage.getCredentialsForServerUrl(otherHome.serverUrl, { serverId: otherHome.id })).toEqual(other);
                if (entrypoint === 'delete') {
                    expect(erasureRequests).toEqual([{ confirmation: ACCOUNT_ERASURE_CONFIRMATION_V1 },
                        ...retainedResources.map(resource => ({ confirmation: ACCOUNT_ERASURE_CONFIRMATION_V1,
                            managedResourceDispositions: [{ managedId: resource.managedId,
                                expectedIntentRevision: resource.intentRevision, expectedAllocation: resource.allocation,
                                expectedResource: resource.resource, expectedNativeOperationRef: resource.nativeOperationRef,
                                expectedRecovery: resource.recovery, responsibility: 'manual' }],
                        }))]);
                    expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toBeNull();
                    expect(settled).toMatchObject({ ok: true, result: { status: 'deleted' } });
                } else {
                    expect(erasureRequests).toHaveLength(entrypoint === 'delete-resource-cancel' ? 1 : 0);
                    expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id }))
                        .toEqual(entrypoint === 'delete-stale' ? replacement : credentials);
                    if (entrypoint === 'delete-reject') expect(settled).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
                }
                return;
            }
            confirmations[0]!.resolve(true);
            const approved = await pendingOwnAction;
            expect(request).toBeNull();
            if (entrypoint === 'stale-forget') {
                expect(credentialReplacedDuringGuard).toBe(true);
                expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toEqual(replacement);
                expect(await TokenStorage.getCredentialsForServerUrl(otherHome.serverUrl, { serverId: otherHome.id })).toEqual(other);
                expect(approved).toMatchObject({ ok: false });
                return;
            }
            if (entrypoint === 'forget-navigation') {
                // The signed-in page is retired before any credential is removed: a route that cannot be
                // left keeps every credential and reports the failure.
                expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toEqual(credentials);
                expect(await TokenStorage.getCredentialsForServerUrl(otherHome.serverUrl, { serverId: otherHome.id })).toEqual(other);
                expect(approved).toMatchObject({ ok: false, errorCode: 'action_failed', error: 'Navigation unavailable' });
                return;
            }
            expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toBeNull();
            expect(await TokenStorage.getCredentialsForServerUrl(otherHome.serverUrl, { serverId: otherHome.id })).toEqual(forgetting ? null : other);
            expect(approved).toMatchObject({ ok: true, result: { status: forgetting ? 'forgotten' : 'signed_out' } });
        } finally {
            for (const confirmation of confirmations) confirmation.resolve(false);
            for (const presentation of presentations) {
                if (presentation.config.type === 'prompt') Modal.resolvePrompt(presentation.id, null);
                else if (presentation.config.type === 'confirm') Modal.resolveConfirm(presentation.id, false);
                else if (presentation.config.type === 'alert') Modal.resolveAlert(presentation.id);
            }
            await pendingOwnAction;
            releasePresentation?.(); account.dispose(); await screen.unmount();
            restoreWorkspaceSettings?.();
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
            const replace = vi.fn().mockImplementationOnce(async () => { throw new Error('Navigation unavailable'); });
            const failure = await completeAccountDeletion({ target, deleteCurrentAccount: options => deleteCurrentAccount(original, options), replace,
                logout: options => auth.logout({ ...options, target: { serverId: homeA.id, serverUrl: homeA.serverUrl }, expectedCredentials: original }),
            }).then(() => null, (error: unknown) => error);
            expect(failure).toBeInstanceOf(AccountDeletedLocalCleanupError);
            if (!(failure instanceof AccountDeletedLocalCleanupError)) throw new Error('Expected retryable Account deletion cleanup');
            expect(erasures).toEqual([homeA.serverUrl]);
            await act(async () => { await profiles.setActiveServerId(homeB.id, { scope: 'device' }); await auth.refreshFromActiveServer(); });
            expect(getCurrentAuth()?.credentials).toEqual(other);
            await act(async () => { await expect(failure.retryLocalCleanup()).resolves.toEqual({ kind: 'completed', erasure: { status: 'deleted' } }); });
            expect(erasures).toEqual([homeA.serverUrl]);
            expect(await TokenStorage.getCredentialsForServerUrl(homeA.serverUrl, { serverId: homeA.id })).toBeNull();
            expect(await TokenStorage.getCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id })).toEqual(other);
            expect(getCurrentAuth()).toMatchObject({ isAuthenticated: true, credentials: other });
        } finally { await screen.unmount(); }
    });
});
