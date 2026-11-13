import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { MACHINE_PLAIN_DATA_KEY_MARKER, type SessionOrganizationSnapshot } from '@happier-dev/protocol';

import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { createServerFetchWithReachabilityProbe, getServerFetchUrl } from '@/dev/testkit/mocks/serverFetch';
import { readReactNativeMmkvStubEntries, resetReactNativeMmkvStub } from '@/dev/reactNativeMmkvStub';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const secureStore = vi.hoisted(() => new Map<string, string>());
const asyncStorage = vi.hoisted(() => new Map<string, string>());

vi.mock('expo-secure-store', () => ({
    getItemAsync: async (key: string) => secureStore.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { secureStore.set(key, value); },
    deleteItemAsync: async (key: string) => { secureStore.delete(key); },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (key: string) => asyncStorage.get(key) ?? null,
        setItem: async (key: string, value: string) => { asyncStorage.set(key, value); },
        removeItem: async (key: string) => { asyncStorage.delete(key); },
    },
}));
vi.mock('@/log', () => ({ log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: {
        onSessionFocus: vi.fn(), onSessionOffline: vi.fn(), onSessionOnline: vi.fn(),
        onMessages: vi.fn(), reportContextualUpdate: vi.fn(),
    },
}));
vi.mock('@/track', () => ({ trackLogout: vi.fn(), initializeTracking: vi.fn(), tracking: null }));
vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        onMessage: vi.fn(), onError: vi.fn(), onReconnected: vi.fn(),
        onStatusChange: vi.fn(() => () => {}), onConnectionStateChange: vi.fn(() => () => {}),
        connect: vi.fn(), disconnect: vi.fn(), initialize: vi.fn(),
        request: vi.fn(async () => new Response('ok', { status: 200 })),
    },
}));

const SETTLED = { timeout: 10_000 };
const HOME_ONE_URL = 'http://home-one.test:53288';
const HOME_TWO_URL = 'http://home-two.test:53288';
const ENCRYPTION_MODE_PATH = '/v1/account/encryption';

const tokenFor = (account: string, revision = 0) =>
    `hdr.${Buffer.from(JSON.stringify({ sub: account, revision })).toString('base64')}.sig`;

function organization(version: number, name: string): SessionOrganizationSnapshot {
    return {
        schemaVersion: 1, version,
        pins: [{ sessionId: `${name}-pinned-session`, sortKey: null, pinnedAt: 1 }],
        folders: [{
            folderId: name, folderKey: `${name}-key`, parentFolderId: null, parentFolderKey: null, sortKey: null,
            archivedAt: null, createdAt: 1, updatedAt: 1, display: { t: 'plain', v: { name } },
        }],
        folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [],
    } as unknown as SessionOrganizationSnapshot;
}

type ServerRequest = Readonly<{ pathname: string; method: string; sub: string }>;

function createHeldReply() {
    let release = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    return { released, release };
}

/**
 * The server: each Account owns its own organization, and the version counter is per Account.
 * `hold` keeps one request's reply back until the test releases it, as a slow network would.
 */
function installServer(
    organizationBySub: Record<string, SessionOrganizationSnapshot>,
    hold?: (request: ServerRequest) => Promise<void> | null | undefined,
) {
    const requests: ServerRequest[] = [];
    vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async (input, init) => {
        const { pathname } = getServerFetchUrl(input);
        const payload = (new Headers(init?.headers).get('Authorization') ?? '').split('.')[1] ?? '';
        const sub = payload ? (JSON.parse(Buffer.from(payload, 'base64').toString()) as { sub: string }).sub : '';
        const request = { pathname, method: init?.method ?? 'GET', sub };
        requests.push(request);
        await hold?.(request);
        if (pathname === '/v2/sessions') return Response.json({ sessions: [], nextCursor: null, hasNext: false, includedActive: true });
        if (pathname === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        if (pathname === '/v1/machines') return Response.json([]);
        if (pathname === ENCRYPTION_MODE_PATH) return Response.json({ mode: 'plain', updatedAt: 0 });
        if (pathname === '/v2/account/settings') {
            return Response.json({
                content: {
                    t: 'plain',
                    v: { sessionRoleProfilesV1: { v: 1, instructionsByRole: {}, customRoles: [] } },
                },
                version: 1,
            });
        }
        if (pathname === '/v2/session-organization') return Response.json({ snapshot: organizationBySub[sub] });
        if (pathname === '/v2/session-organization/appearance-presentations') {
            return Response.json({ error: 'Not found' }, { status: 404 });
        }
        if (pathname === '/v2/session-organization/import') {
            return Response.json({ imported: { pins: 0, folders: 0, tags: 0, orderEntries: 0, labels: 0 } });
        }
        if (pathname.startsWith('/v2/session-organization/pins/')) {
            return Response.json({ pin: { sessionId: 'a-late-session', sortKey: null, pinnedAt: 2 } });
        }
        if (pathname.startsWith('/v2/session-organization/folders')) {
            return Response.json({ folder: organization(0, 'a-late-folder').folders[0] });
        }
        return Response.json({ error: 'not served' }, { status: 404 });
    })));
    return requests;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

async function bootApp() {
    const { prepareWarmCacheStorage } = await import('@/sync/domains/state/warmCachePersistence');
    await prepareWarmCacheStorage();
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { AuthProvider, getCurrentAuth } = await import('./AuthContext');
    const { storage } = await import('@/sync/domains/state/storage');
    const { setServerSessionListCache } = await import('@/sync/store/sessionListCache');
    const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
    const { buildInboxSessionState } = await import('@/hooks/inbox/buildInboxSessionState');

    upsertAndActivateServer({ serverUrl: HOME_ONE_URL, scope: 'device' });
    const homeId = String(getActiveServerSnapshot().serverId);

    const screen = await renderScreen(React.createElement(AuthProvider, {
        initialCredentials: null,
        children: React.createElement(React.Fragment, null),
    }));
    const auth = () => {
        const current = getCurrentAuth();
        if (!current) throw new Error('Expected current auth to be set');
        return current;
    };
    const signIn = async (account: string, revision = 0) => {
        await act(async () => { await auth().loginWithCredentials({ token: tokenFor(account, revision) }); });
        // The socket stays disconnected here, so the list refresh a connect would start is started directly.
        const { sync } = await import('@/sync/sync');
        void sync.refreshSessions().catch(() => undefined);
    };
    const signOut = async () => {
        await act(async () => { await auth().logout(); });
    };
    const followActiveHome = async () => {
        await act(async () => { await auth().refreshFromActiveServer(); });
    };
    const folderNames = (serverId: string) => Object.entries(storage.getState().sessionOrganizationFoldersByFolderKey)
        .filter(([key]) => key.startsWith(`${serverId}:`))
        .map(([, folder]) => folder?.folderId);
    const pinnedKeys = () => Object.keys(storage.getState().sessionOrganizationPinsBySessionKey);
    const seedOtherHomeRows = (serverId: string) => {
        const session = createSessionFixture({ id: 'a-session-on-other-home' });
        storage.setState((state) => ({
            ...state,
            sessionListViewDataByServerId: setServerSessionListCache(state.sessionListViewDataByServerId, serverId, [
                { type: 'session', session: buildSessionListRenderableFromSession(session) },
            ]),
            machineListByServerId: { ...state.machineListByServerId, [serverId]: [{ id: 'a-machine' } as never] },
            machineListStatusByServerId: { ...state.machineListStatusByServerId, [serverId]: 'idle' },
        }));
    };
    return {
        homeId, signIn, signOut, followActiveHome, folderNames, pinnedKeys, seedOtherHomeRows, storage, buildInboxSessionState,
        unmount: () => screen.unmount(),
    };
}

const persistedOrganizationEntries = () => readReactNativeMmkvStubEntries()
    .filter(([key]) => key.startsWith('session-organization-warm-cache'))
    .map(([key, value]) => [key, String(value)] as const);

describe('AuthContext Account change on one Home', () => {
    beforeEach(() => {
        secureStore.clear();
        asyncStorage.clear();
        resetReactNativeMmkvStub();
        vi.resetModules();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it.each(['after signing out', 'without signing out'] as const)('shows Account B only its own organization when B signs in %s', async (route) => {
        installServer({ 'account-a': organization(50, 'a-private-folder'), 'account-b': organization(3, 'b-own-folder') });
        const app = await bootApp();
        try {
            await app.signIn('account-a');
            await vi.waitFor(() => expect(app.folderNames(app.homeId)).toEqual(['a-private-folder']), SETTLED);

            if (route === 'after signing out') await app.signOut();
            await app.signIn('account-b');

            // A's folder and pin are gone the moment B is admitted, not once B's fetch lands.
            expect(app.folderNames(app.homeId)).not.toContain('a-private-folder');
            await vi.waitFor(() => expect(app.folderNames(app.homeId)).toEqual(['b-own-folder']), SETTLED);
            expect(app.pinnedKeys().join()).not.toContain('a-private-folder');
            await vi.waitFor(() => {
                const entries = persistedOrganizationEntries();
                const accountB = entries.filter(([key]) => key.endsWith(':account-b'));
                expect(accountB).toHaveLength(1);
                expect(accountB[0]?.[1]).toContain('b-own-folder');
            }, SETTLED);
            expect(persistedOrganizationEntries().filter(([key]) => key.endsWith(':account-b')).map(([, value]) => value).join())
                .not.toContain('a-private-folder');
        } finally {
            await app.signOut();
            await app.unmount();
        }
    });

    it('withdraws A from the store on sign out, before anyone else signs in', async () => {
        installServer({ 'account-a': organization(50, 'a-private-folder') });
        const app = await bootApp();
        try {
            await app.signIn('account-a');
            await vi.waitFor(() => expect(app.folderNames(app.homeId)).toEqual(['a-private-folder']), SETTLED);

            await app.signOut();

            expect(app.folderNames(app.homeId)).toEqual([]);
            expect(app.storage.getState().sessionOrganizationSnapshotVersionByServerId).toEqual({});
        } finally {
            await app.unmount();
        }
    });

    it('self-heals a warm entry persisted by a build that could write A under B', async () => {
        installServer({ 'account-b': organization(3, 'b-own-folder') });
        const { MMKV } = await import('react-native-mmkv');
        const { prepareWarmCacheStorage } = await import('@/sync/domains/state/warmCachePersistence');
        await prepareWarmCacheStorage();
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        upsertAndActivateServer({ serverUrl: HOME_ONE_URL, scope: 'device' });
        const homeId = String(getActiveServerSnapshot().serverId);
        const { WARM_CACHE_STORAGE_ID } = await import('@/sync/domains/state/warmCachePersistence');
        new MMKV({ id: WARM_CACHE_STORAGE_ID }).set(
            `session-organization-warm-cache-v1:${homeId}:account-b`,
            JSON.stringify(organization(50, 'a-private-folder')),
        );

        const app = await bootApp();
        try {
            await app.signIn('account-b');

            expect(app.folderNames(app.homeId)).not.toContain('a-private-folder');
            await vi.waitFor(() => expect(app.folderNames(app.homeId)).toEqual(['b-own-folder']), SETTLED);
            expect(persistedOrganizationEntries().map(([, value]) => value).join()).not.toContain('a-private-folder');
        } finally {
            await app.signOut();
            await app.unmount();
        }
    });

    it('keeps the organization when the same Account only refreshes its token', async () => {
        installServer({ 'account-a': organization(50, 'a-private-folder') });
        const app = await bootApp();
        try {
            await app.signIn('account-a');
            await vi.waitFor(() => expect(app.folderNames(app.homeId)).toEqual(['a-private-folder']), SETTLED);
            const heldFolders = app.storage.getState().sessionOrganizationFoldersByFolderKey;

            // The refreshed token's fetch never lands, so only the retained data can answer.
            vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
            await app.signIn('account-a', 1);

            expect(app.storage.getState().sessionOrganizationFoldersByFolderKey).toBe(heldFolders);
        } finally {
            await app.signOut();
            await app.unmount();
        }
    });

    it('keeps what another Home holds across a Home switch by the same Account, and on returning to it', async () => {
        installServer({ 'account-a': organization(50, 'a-private-folder') });
        const app = await bootApp();
        const { getActiveServerSnapshot, setActiveServer, upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        try {
            await app.signIn('account-a');
            await vi.waitFor(() => expect(app.folderNames(app.homeId)).toEqual(['a-private-folder']), SETTLED);

            const homeTwo = upsertAndActivateServer({ serverUrl: HOME_TWO_URL, scope: 'device' });
            expect(String(getActiveServerSnapshot().serverId)).not.toBe(app.homeId);
            await app.signIn('account-a');
            expect(app.folderNames(app.homeId)).toEqual(['a-private-folder']);
            expect(homeTwo.id).not.toBe(app.homeId);

            // Nothing can repaint Home 1 on the way back: its reads hang and the warm entry is gone.
            vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
            const { MMKV } = await import('react-native-mmkv');
            const { WARM_CACHE_STORAGE_ID } = await import('@/sync/domains/state/warmCachePersistence');
            const warmCache = new MMKV({ id: WARM_CACHE_STORAGE_ID });
            for (const key of warmCache.getAllKeys()) {
                if (key.startsWith('session-organization-warm-cache')) warmCache.delete(key);
            }
            setActiveServer({ serverId: app.homeId, scope: 'device' });
            expect(String(getActiveServerSnapshot().serverId)).toBe(app.homeId);
            await app.followActiveHome();

            expect(app.folderNames(app.homeId)).toEqual(['a-private-folder']);
            expect(app.storage.getState().sessionOrganizationSnapshotVersionByServerId[app.homeId]).toBe(50);
        } finally {
            await app.signOut();
            await app.unmount();
        }
    });

    it('clears retained rows when another Account signs in without a reset running first', async () => {
        // B's list read hangs, so only the admission can withdraw what A left behind.
        installServer(
            { 'account-a': organization(50, 'a-private-folder'), 'account-b': organization(3, 'b-own-folder') },
            ({ pathname, sub }) => (sub === 'account-b' && pathname.startsWith('/v2/sessions') ? new Promise<void>(() => {}) : null),
        );
        const app = await bootApp();
        const { setActiveServer, upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        try {
            await app.signIn('account-a');
            await vi.waitFor(() => expect(app.folderNames(app.homeId)).toEqual(['a-private-folder']), SETTLED);
            await settle();
            app.seedOtherHomeRows(app.homeId);

            // A signed-out Home ends the Sync, then Home 1 loses its credential and comes back active,
            // so B arrives through `create`, which runs no reset.
            upsertAndActivateServer({ serverUrl: HOME_TWO_URL, scope: 'device' });
            await app.followActiveHome();
            await TokenStorage.removeCredentialsForServerUrl(HOME_ONE_URL, { serverId: app.homeId });
            setActiveServer({ serverId: app.homeId, scope: 'device' });
            await app.followActiveHome();
            await app.signIn('account-b');

            const state = app.storage.getState();
            expect(JSON.stringify(state.sessionListViewDataByServerId)).not.toContain('a-session-on-other-home');
            expect(state.machineListByServerId[app.homeId]).toBeUndefined();
        } finally {
            await app.signOut();
            await app.unmount();
        }
    });

    it('persists nothing of B under A when A\'s first organization read finishes after B signed in', async () => {
        const held = createHeldReply();
        let holding = false;
        installServer(
            { 'account-a': organization(50, 'a-private-folder'), 'account-b': organization(3, 'b-own-folder') },
            ({ pathname, sub }) => (holding && sub === 'account-a' && pathname === '/v2/session-organization' ? held.released : null),
        );
        const app = await bootApp();
        try {
            // B's warm entry is what repaints B while A's read is still outstanding.
            await app.signIn('account-b');
            await vi.waitFor(() => expect(persistedOrganizationEntries().map(([key]) => key).join()).toContain(':account-b'), SETTLED);
            await app.signOut();
            holding = true;
            await app.signIn('account-a');
            await app.signOut();
            await app.signIn('account-b');
            expect(app.folderNames(app.homeId)).toEqual(['b-own-folder']);

            held.release();
            await settle();

            const underA = persistedOrganizationEntries().filter(([key]) => key.endsWith(':account-a'));
            expect(underA.map(([, value]) => value).join()).not.toContain('b-own-folder');
        } finally {
            await app.signOut();
            await app.unmount();
        }
    });

    it.each(['importLegacySessionOrganization', 'setSessionTagLabels'] as const)('does not let %s apply A\'s snapshot after B signed in', async (operation) => {
        const held = createHeldReply();
        let holding = false;
        const requests = installServer(
            { 'account-a': organization(50, 'a-private-folder'), 'account-b': organization(3, 'b-own-folder') },
            ({ pathname, sub }) => (holding && sub === 'account-a' && pathname === '/v2/session-organization' ? held.released : null),
        );
        const app = await bootApp();
        const ops = await import('@/sync/ops/sessionOrganization');
        try {
            await app.signIn('account-a');
            await vi.waitFor(() => expect(app.folderNames(app.homeId)).toEqual(['a-private-folder']), SETTLED);
            await settle();
            holding = true;
            const asA = { credentials: { token: tokenFor('account-a') }, serverId: app.homeId, serverUrl: HOME_ONE_URL };
            const requestsBefore = requests.length;
            const running = (operation === 'importLegacySessionOrganization'
                ? ops.importLegacySessionOrganization({
                    ...asA,
                    request: { pins: [], folders: [], tags: [], tagAssignments: [], orderEntries: [], labels: [] },
                })
                : ops.setSessionTagLabels({ ...asA, sessionId: 'a-session', tags: ['a-new-tag'] })
            ).catch(() => undefined);
            await vi.waitFor(() => expect(requests.slice(requestsBefore).some((request) => (
                request.pathname === '/v2/session-organization' && request.sub === 'account-a'
            ))).toBe(true), SETTLED);

            await app.signOut();
            await app.signIn('account-b');
            await vi.waitFor(() => expect(app.folderNames(app.homeId)).toEqual(['b-own-folder']), SETTLED);
            const requestsAtRelease = requests.length;

            held.release();
            await running;

            expect(app.storage.getState().sessionOrganizationSnapshotVersionByServerId[app.homeId]).toBe(3);
            expect(app.folderNames(app.homeId)).toEqual(['b-own-folder']);
            // The operation stops with its Account rather than writing on from what B's store holds.
            expect(requests.slice(requestsAtRelease).filter((request) => request.method !== 'GET' && request.sub === 'account-a')).toEqual([]);
        } finally {
            await app.signOut();
            await app.unmount();
        }
    });

    it.each(['setSessionPin', 'upsertSessionFolder'] as const)('does not let a %s reply from A land after B signed in', async (operation) => {
        const held = createHeldReply();
        const requests = installServer(
            { 'account-a': organization(50, 'a-private-folder'), 'account-b': organization(3, 'b-own-folder') },
            ({ method, pathname }) => (method !== 'GET' && pathname.startsWith('/v2/session-organization/') ? held.released : null),
        );
        const app = await bootApp();
        const ops = await import('@/sync/ops/sessionOrganization');
        try {
            await app.signIn('account-a');
            await vi.waitFor(() => expect(app.folderNames(app.homeId)).toEqual(['a-private-folder']), SETTLED);
            const asA = { credentials: { token: tokenFor('account-a') }, serverId: app.homeId, serverUrl: HOME_ONE_URL };
            const running = (operation === 'setSessionPin'
                ? ops.setSessionPin({ ...asA, sessionId: 'a-late-session', pinned: true })
                : ops.upsertSessionFolder({
                    ...asA,
                    request: {
                        folderId: 'a-late-folder', folderKey: 'a-late-folder-key', parentFolderId: null, parentFolderKey: null,
                        sortKey: null, display: { t: 'plain', v: { name: 'a-late-folder' } },
                    } as never,
                })
            ).catch(() => undefined);
            await vi.waitFor(() => expect(requests.some((request) => request.method !== 'GET')).toBe(true), SETTLED);

            await app.signOut();
            await app.signIn('account-b');
            await vi.waitFor(() => expect(app.folderNames(app.homeId)).toEqual(['b-own-folder']), SETTLED);

            held.release();
            await running;

            expect(app.folderNames(app.homeId)).toEqual(['b-own-folder']);
            expect(app.pinnedKeys().join()).not.toContain('a-late-session');
        } finally {
            await app.signOut();
            await app.unmount();
        }
    });

    it('stops quietly when a socket update or a resume reaches the Sync after sign out', async () => {
        installServer({ 'account-a': organization(50, 'a-private-folder') });
        const app = await bootApp();
        const { sync } = await import('@/sync/sync');
        const signedOutSync = sync as unknown as Readonly<{
            encryption: { getMachineEncryption: (machineId: string) => unknown };
            handleUpdate: (update: unknown) => Promise<void>;
            resumeViaChanges: (options: Readonly<{ accountId: string }>) => Promise<Readonly<{ status: string }>>;
        }>;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await app.signIn('account-a');
            await vi.waitFor(() => expect(app.folderNames(app.homeId)).toEqual(['a-private-folder']), SETTLED);
            await app.signOut();
            warn.mockClear();

            // The plain marker is what makes this update ask for the Account's encryption mode.
            await signedOutSync.handleUpdate({
                id: 'late-update', seq: 43, createdAt: 124,
                body: {
                    t: 'new-machine', machineId: 'a-late-machine', seq: 8, metadata: 'bWV0YWRhdGE=', metadataVersion: 1,
                    daemonState: null, daemonStateVersion: 0, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                    active: true, activeAt: 121, createdAt: 101, updatedAt: 122,
                },
            });

            expect(warn.mock.calls.flat().join(' ')).not.toContain('machine');
            expect(signedOutSync.encryption.getMachineEncryption('a-late-machine')).toBeNull();
            await expect(signedOutSync.resumeViaChanges({ accountId: 'account-a' })).resolves.toMatchObject({ status: 'aborted' });
        } finally {
            warn.mockRestore();
            await app.unmount();
        }
    });

    it('leaves no other-Home rows of the signed-out Account for the inbox and machine readers', async () => {
        installServer({ 'account-a': organization(50, 'a-private-folder'), 'account-b': organization(3, 'b-own-folder') });
        const app = await bootApp();
        try {
            await app.signIn('account-a');
            app.seedOtherHomeRows('other-home');

            await app.signOut();
            await app.signIn('account-b');

            const state = app.storage.getState();
            expect(state.sessionListViewDataByServerId['other-home']).toBeUndefined();
            expect(state.machineListByServerId['other-home']).toBeUndefined();
            const inbox = app.buildInboxSessionState({
                sessions: [], sessionListViewDataByServerId: state.sessionListViewDataByServerId, nowMs: 1,
            });
            expect(JSON.stringify(inbox)).not.toContain('a-session-on-other-home');
        } finally {
            await app.signOut();
            await app.unmount();
        }
    });
});
