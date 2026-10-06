import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

installTokenStorageWebPlatformMocks();
installDisconnectedServerSocketBoundary();
const capture = (await import('@/dev/testkit/mocks/router')).createStackOptionsCapture();
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    params: { selectedId: '' },
    navigation: { getState: () => ({ index: 1, routes: [{ key: 'prev' }, { key: 'current' }] }), dispatch: vi.fn() },
    stackOptionsCapture: capture,
}).module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/sync/domains/state/browserRecordStorage', async () =>
    (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());

// Evaluate each real owner once, after its genuine browser/native boundaries exist.
const importBrowser = installLocalStorageMock();
const importLocks = installWebLockManagerMock();
const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
setRuntimeFetch(async () => { throw new Error('Unexpected picker HTTP request before fixture arrangement'); });
// The real app entry publishes the Sync producer before routes or connection cleanup run.
await loadSyncSingletonForTests();
const [
    { AuthProvider, setCurrentAuth }, { default: Route },
    { upsertServerProfile, setActiveServerId, saveHomeViewState, removeServerProfile },
    { TokenStorage }, { storage }, { createDirectoryHttpFixture },
    { disconnectActiveServerConnection }, { stopAllEndpointSupervisorsForTests },
    { apiSocket }, { clearPersistence }, { resetSessionDraftRepositoryForTests },
    { ItemList, ItemListStatic },
] = [
    await import('@/auth/context/AuthContext'), await import('@/app/(app)/new/pick/server'),
    await import('@/sync/domains/server/serverProfiles'), await import('@/auth/storage/tokenStorage'),
    await import('@/sync/domains/state/storage'), await import('@/sync/ops/accountDirectory/accountDirectoryTestFixtures'),
    await import('@/sync/runtime/orchestration/connectionManager'), await import('@/sync/runtime/connectivity/endpointSupervisorPool'),
    await import('@/sync/api/session/apiSocket'), await import('@/sync/domains/state/persistence'),
    await import('@/sync/ops/sessionDrafts/sessionDraftRepository'), await import('@/components/ui/lists/ItemList'),
];
resetRuntimeFetch();
importLocks.restore();
importBrowser.restore();
const initialStorageState = storage.getState();
const homes: Array<Readonly<{ id: string; serverUrl: string }>> = [];

let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
let restoreBrowser: (() => void) | undefined;
let restoreLocks: (() => void) | undefined;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json' },
});

beforeEach(async () => {
    capture.reset();
    restoreBrowser = installLocalStorageMock().restore;
    restoreLocks = installWebLockManagerMock().restore;
    setRuntimeFetch(async (input) => {
        const url = new URL(String(input));
        const home = homes.find((candidate) => candidate.serverUrl === url.origin);
        if (!home) throw new Error(`Unexpected picker Home request: ${url.origin}`);
        if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return json({});
        if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return json(createRootLayoutFeaturesResponse({
            capabilities: { serverIdentity: { serverIdentityId: home.id },
                server: { canonicalServerUrl: url.origin } },
        }));
        if (url.pathname === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
        if (url.pathname === '/v1/account/encryption/currentness') return json({
            mode: 'plain', version: 1, settingsVersion: 0, updatedAt: 0, signingKeyFingerprint: null, contentKeyFingerprint: null,
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
        });
        return json({ error: 'not-found' }, 404);
    });
    const homeA = await upsertServerProfile({ serverUrl: 'https://a.example.test', name: 'A' });
    homes.push(homeA);
    const homeB = await upsertServerProfile({ serverUrl: 'https://b.example.test', name: 'B' });
    homes.push(homeB);
    await setActiveServerId(homeA.id);
    await saveHomeViewState({ version: 1, groups: [], activeTargetKind: 'server', activeTargetId: homeA.id });
    const credentials = { token: createDirectoryHttpFixture().token };
    for (const home of homes) expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials)).toBe(true);
    storage.getState().applySettingsLocal({ newSessionPresentationModeV1: 'auto' });
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
    screen = await renderScreen(<AuthProvider initialCredentials={null}><Route /></AuthProvider>);
    return screen;
}

describe('ServerPickerScreen header options', () => {
    it('does not provide a headerTitle function that returns a raw string (RN Web text node error)', async () => {
        await mountRoute();
        expect(capture.getResolved()).toBeTruthy();
        expect(typeof capture.getResolved()?.headerTitle).toBe('string');
    });
    it('presents as a modal on web by default and as a regular screen when requested', async () => {
        await mountRoute();
        expect(capture.getResolved()?.presentation).toBe('modal');
        await act(async () => {
            storage.getState().applySettingsLocal({ newSessionPresentationModeV1: 'screen' });
        });
        expect(capture.getResolved()?.presentation).toBeUndefined();
    });
    it('gives the standalone picker the only scroll viewport', async () => {
        const rendered = await mountRoute();
        expect(rendered.findAllByType(ItemList)).toHaveLength(1);
        expect(rendered.findAllByType(ItemListStatic)).toHaveLength(0);
        expect(rendered.findAllByType('ScrollView')).toHaveLength(1);
    });
});
