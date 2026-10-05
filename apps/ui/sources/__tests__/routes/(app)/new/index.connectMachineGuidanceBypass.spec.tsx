import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { act } from 'react-test-renderer';
import { SessionDraftAddressV2Schema } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { ExpoRouterParams } from '@/dev/testkit/mocks/router';

installTokenStorageWebPlatformMocks();
installDisconnectedServerSocketBoundary();
const routeState = vi.hoisted<{
    params: ExpoRouterParams;
    setParams: ReturnType<typeof vi.fn>;
    listeners: Set<() => void>;
}>(() => ({
    params: {}, setParams: vi.fn(), listeners: new Set(),
}));
vi.mock('expo-router', async () => {
    const module = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        pathname: '/new', params: () => routeState.params,
        router: { setParams: routeState.setParams },
    }).module;
    // This route needs reactive framework-param delivery, which the canonical
    // navigation boundary's snapshot-only hook does not supply.
    return { ...module, useLocalSearchParams: () => React.useSyncExternalStore(
        (listener) => { routeState.listeners.add(listener); return () => { routeState.listeners.delete(listener); }; },
        () => routeState.params,
        () => routeState.params,
    ) };
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/sync/domains/state/browserRecordStorage', async () =>
    (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());

const importBrowser = installLocalStorageMock();
const importLocks = installWebLockManagerMock();
const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
setRuntimeFetch(async () => { throw new Error('Unexpected New Session HTTP request before fixture arrangement'); });
// Load the app-entry producer before capturing the public facade's singleton.
await loadSyncSingletonForTests();
const [
    { AuthProvider, setCurrentAuth }, { default: Route }, { upsertAndActivateServer },
    { TokenStorage }, { storage }, { createDirectoryHttpFixture },
    { restoreConnectionToActiveServer, disconnectActiveServerConnection },
    { stopAllEndpointSupervisorsForTests }, { apiSocket }, { clearPersistence },
    { saveHomeViewState, removeServerProfile },
    { clearBrowserRecords }, { prepareSessionDraftPersistenceStorage },
    { getActiveServerAccountScope }, { profileDefaults }, { fetchAccountEncryptionMode }, { sync },
    { ensureSessionDraftRepositoryHydrated, resetSessionDraftRepositoryForTests, getSessionDraftSnapshot, writeNewSessionDraft },
] = [
    await import('@/auth/context/AuthContext'), await import('@/app/(app)/new'), await import('@/sync/domains/server/serverRuntime'),
    await import('@/auth/storage/tokenStorage'), await import('@/sync/domains/state/storage'),
    await import('@/sync/ops/accountDirectory/accountDirectoryTestFixtures'), await import('@/sync/runtime/orchestration/connectionManager'),
    await import('@/sync/runtime/connectivity/endpointSupervisorPool'), await import('@/sync/api/session/apiSocket'),
    await import('@/sync/domains/state/persistence'), await import('@/sync/domains/server/serverProfiles'),
    await import('@/sync/domains/state/browserRecordStorage'), await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage'),
    await import('@/sync/domains/scope/activeServerAccountScope'), await import('@/sync/domains/profiles/profile'),
    await import('@/sync/api/account/apiAccountEncryptionMode'), await import('@/sync/sync'),
    await import('@/sync/ops/sessionDrafts/sessionDraftRepository'),
];
resetRuntimeFetch();
importLocks.restore();
importBrowser.restore();
const initialStorageState = storage.getState();
const homes: Array<Readonly<{ id: string; serverUrl: string }>> = [];

const draftId = '4a506d8a-85bd-4c42-a662-6f502f3acc45';
let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
let restoreBrowser: (() => void) | undefined;
let restoreLocks: (() => void) | undefined;
let scope: ServerAccountScope;
let credentials: AuthCredentials;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json' },
});

beforeEach(async () => {
    routeState.params = {};
    routeState.setParams.mockClear();
    routeState.setParams.mockImplementation((params: ExpoRouterParams) => {
        routeState.params = { ...routeState.params, ...params };
        for (const listener of routeState.listeners) listener();
    });
    restoreBrowser = installLocalStorageMock().restore;
    restoreLocks = installWebLockManagerMock().restore;
    setRuntimeFetch(async (input) => {
        const url = new URL(String(input));
        expect(url.origin).toBe('https://new-session.example.test');
        if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return json({});
        if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') {
            const home = homes.find((candidate) => candidate.serverUrl === url.origin);
            if (!home) throw new Error('New Session features requested before Home creation completed');
            return json(createRootLayoutFeaturesResponse({
                capabilities: { serverIdentity: { serverIdentityId: home.id }, server: { canonicalServerUrl: home.serverUrl } },
            }));
        }
        if (url.pathname === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
        if (url.pathname === '/v1/account/encryption/currentness') return json({
            mode: 'plain', version: 1, settingsVersion: 0, updatedAt: 0, signingKeyFingerprint: null, contentKeyFingerprint: null,
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
        });
        return json({ error: 'not-found' }, 404);
    });
    // Reset only the IndexedDB boundary fixture, before the real repository opens it.
    await clearBrowserRecords();
    await prepareSessionDraftPersistenceStorage();
    const home = await upsertAndActivateServer({ serverUrl: 'https://new-session.example.test', name: 'New Session Home' });
    homes.push(home);
    credentials = { token: createDirectoryHttpFixture().token };
    expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials)).toBe(true);
    await restoreConnectionToActiveServer(credentials);
    const applied = getActiveServerAccountScope();
    if (!applied) throw new Error('Expected a real applied Home/Account lifetime');
    scope = applied;
    storage.getState().applyProfileForScope(scope, {
        ...profileDefaults, id: scope.accountId,
    });
    storage.getState().applySettingsLocal({
        newSessionOrdinaryEntryDraftId: null, useEnhancedSessionWizard: false,
    });
    storage.getState().applyMachines([], true, { sourceServerId: scope.serverId });
    await saveHomeViewState({
        version: 1, groups: [], activeTargetKind: 'server', activeTargetId: scope.serverId,
    });
    const mode = await fetchAccountEncryptionMode(credentials);
    expect(mode.mode).toBe('plain');
    sync.reconfigureSessionDraftRepositoryForAccountMode(credentials, mode.mode);
    await ensureSessionDraftRepositoryHydrated(scope);
});

afterEach(async () => {
    try {
        await screen?.unmount();
        screen = undefined;
        await disconnectActiveServerConnection();
        apiSocket.disconnect();
        await stopAllEndpointSupervisorsForTests();
        setCurrentAuth(null);
        for (const home of homes) {
            expect(await TokenStorage.clearPendingExternalAuth({ serverId: home.id, serverUrl: home.serverUrl })).toBe(true);
            expect(await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toBe(true);
            await removeServerProfile(home.id);
        }
        homes.length = 0;
        await clearPersistence();
        resetSessionDraftRepositoryForTests();
        storage.setState(initialStorageState, true);
    } finally {
        resetRuntimeFetch();
        vi.restoreAllMocks();
        restoreLocks?.();
        restoreBrowser?.();
    }
});

async function mountRoute() {
    screen = await renderScreen(<AuthProvider initialCredentials={credentials}><Route /></AuthProvider>);
    return screen;
}

describe('/new connect-machine guidance bypass', () => {
    it('resolves a bare route through the ordinary-entry owner and preserves its origin', async () => {
        await mountRoute();
        const generatedDraftId = routeState.params.draftId;
        expect(SessionDraftAddressV2Schema.safeParse({ kind: 'newSession', draftId: generatedDraftId }).success).toBe(true);
        expect(routeState.setParams).toHaveBeenCalledWith({ draftId: generatedDraftId, draftOrigin: 'ordinary' });
        if (typeof generatedDraftId !== 'string') throw new Error('Expected a canonical generated route draft id');
        expect(storage.getState().settings.newSessionOrdinaryEntryDraftId).toBeNull();
        expect(getSessionDraftSnapshot(
            scope, { kind: 'newSession', draftId: generatedDraftId })?.materialized ?? false).toBe(false);
    });
    it('remembers only a materialized draft opened from ordinary entry', async () => {
        routeState.params = { draftId, draftOrigin: 'ordinary' };
        writeNewSessionDraft({ scope, draftId, patch: { text: 'A meaningful saved draft' }, materializationIntent: 'userEdit' });
        await mountRoute();
        expect(storage.getState().settings.newSessionOrdinaryEntryDraftId).toBe(draftId);
    });
    it('renders the new-session screen when a machine+directory intent is present', async () => {
        const rendered = await mountRoute();
        expect(rendered.findAllHostsByTestId('session-getting-started-scroll')).toHaveLength(1);
        expect(rendered.findByTestId('new-session-composer-input')).toBeNull();
        await act(async () => {
            routeState.params = { ...routeState.params, machineId: 'machine-123', directory: '/Users/tester/project' };
            for (const listener of routeState.listeners) listener();
        });
        expect(rendered.findAllHostsByTestId('session-getting-started-scroll')).toHaveLength(0);
        expect(rendered.findByTestId('new-session-composer-input')).not.toBeNull();
    });
    it('keeps the live composer owner mounted when the draft becomes materialized', async () => {
        routeState.params = { draftId, draftOrigin: 'ordinary' };
        storage.getState().applyMachines([createMachineFixture({ active: false })], true, { sourceServerId: scope.serverId });
        const rendered = await mountRoute();
        const before = rendered.findByTestId('new-session-composer-input');
        expect(before).not.toBeNull();
        expect(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })?.materialized ?? false).toBe(false);
        await act(async () => {
            rendered.changeTextByTestId('new-session-composer-input', 'Keep this live composer text');
        });
        await vi.waitFor(() => expect(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })?.materialized).toBe(true));
        expect(rendered.findByTestId('new-session-composer-input')).toBe(before);
        expect(rendered.findByTestId('new-session-composer-input')?.props.value).toBe('Keep this live composer text');
        expect(storage.getState().settings.newSessionOrdinaryEntryDraftId).toBe(draftId);
    });
});
