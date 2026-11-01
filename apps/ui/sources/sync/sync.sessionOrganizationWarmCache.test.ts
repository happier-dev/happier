import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetReactNativeMmkvStub } from '@/dev/testkit/mocks/mmkv';
import { prepareWarmCacheEncryptionKey } from '@/sync/domains/state/warmCacheEncryptionKey';
import { WARM_CACHE_STORAGE_ID } from '@/sync/domains/state/warmCachePersistence';

type FetchChanges = typeof import('./api/session/apiChanges').fetchChanges;
type FetchCurrentChangesCursor = typeof import('./api/session/apiChanges').fetchCurrentChangesCursor;

const fetchChangesMock = vi.hoisted(() =>
    vi.fn<FetchChanges>(async () => ({ status: 'ok' as const, changes: [], nextCursor: '0' })),
);
const fetchCurrentChangesCursorMock = vi.hoisted(() =>
    vi.fn<FetchCurrentChangesCursor>(async () => ({ status: 'ok' as const, cursor: '0' })),
);

vi.mock('./api/session/apiChanges', () => ({
    fetchChanges: fetchChangesMock,
    fetchCurrentChangesCursor: fetchCurrentChangesCursorMock,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) as any },
    });
});

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        onMessage: vi.fn(),
        onError: vi.fn(),
        onReconnected: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        initialize: vi.fn(),
        request: vi.fn(async (path: string) => sessionReadResponse(path)),
        onStatusChange: vi.fn(() => () => undefined),
    },
}));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: {
        onSessionFocus: vi.fn(),
        onSessionOffline: vi.fn(),
        onSessionOnline: vi.fn(),
        onMessages: vi.fn(),
        reportContextualUpdate: vi.fn(),
    },
}));

import { MMKV } from 'react-native-mmkv';

import { sync } from './sync';
import { storage } from './domains/state/storage';
import { saveProfile } from './domains/state/persistence';
import { profileDefaults } from './domains/profiles/profile';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { clearActiveViewingSessionsForServerScopeReset } from './domains/session/activeViewingSession';
import { clearWarmCacheAccountScope } from './domains/state/warmCachePersistence';

const ACCOUNT_ID = 'test-account';

function sessionReadResponse(path: string): Response {
    const exactSession = /^\/v2\/sessions\/([^/?]+)$/.exec(new URL(path, 'http://localhost:53288').pathname);
    if (exactSession && exactSession[1] !== 'active') {
        return Response.json({ session: {
            id: decodeURIComponent(exactSession[1]), seq: 0, createdAt: 1, updatedAt: 1,
            active: false, activeAt: 1, archivedAt: null, encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/workspace', host: 'test' }), metadataVersion: 1,
            agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
        } });
    }
    return Response.json({ sessions: [], nextCursor: null, hasNext: false });
}

function organizationSnapshot(overrides?: { version?: number; pinnedSessionIds?: readonly string[] }) {
    return {
        schemaVersion: 1,
        version: overrides?.version ?? 7,
        pins: (overrides?.pinnedSessionIds ?? ['s_pinned'])
            .map((sessionId) => ({ sessionId, sortKey: '00000001', pinnedAt: 10 })),
        folders: [{
            folderId: 'f1',
            folderKey: 'folder-key-1',
            parentFolderId: null,
            parentFolderKey: null,
            sortKey: '00000001',
            display: { t: 'plain', v: { name: 'Work' } },
            archivedAt: null,
            createdAt: 1,
            updatedAt: 2,
        }],
        folderAssignments: [{ sessionId: 's_assigned', folderId: 'f1' }],
        tags: [],
        tagAssignments: [],
        orderEntries: [
            { scopeKind: 'group', scopeKey: 'pinned', itemKind: 'session', itemKey: 's_pinned', sortKey: '00000001' },
        ],
        labels: [],
        sessionAppearances: [{ sessionId: 's_pinned', display: { t: 'plain', v: { color: { kind: 'custom', hex: '#123456' } } }, updatedAt: 5 }],
    };
}

function warmCacheStorage(): MMKV {
    return new MMKV({ id: WARM_CACHE_STORAGE_ID });
}

function seedOrganizationWarmCache(serverId: string, pinnedSessionIds?: readonly string[]): void {
    warmCacheStorage().set(
        `session-organization-warm-cache-v1:${serverId}:${ACCOUNT_ID}`,
        JSON.stringify(organizationSnapshot({ pinnedSessionIds })),
    );
}

function activeServerId(): string {
    return String(getActiveServerSnapshot().serverId ?? '').trim();
}

function installCredentials(): void {
    (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJ0ZXN0In0.sig', secret: 'secret' };
    (sync as any).serverID = ACCOUNT_ID;
    (sync as any).encryption = {
        decryptEncryptionKey: async () => null,
        initializeSessions: async () => {},
        initializeMachines: async () => {},
        getSessionEncryption: () => null,
    };
}

describe('session organization warm cache', () => {
    const initialStorageState = storage.getState();

    beforeEach(async () => {
        await prepareWarmCacheEncryptionKey();
        storage.setState(initialStorageState, true);
        clearActiveViewingSessionsForServerScopeReset();
        clearWarmCacheAccountScope();
        resetReactNativeMmkvStub();
        vi.unstubAllGlobals();
        fetchChangesMock.mockClear();
        fetchCurrentChangesCursorMock.mockClear();
    });

    it('repaints the last-known organization before the first session list fetch', () => {
        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
        saveProfile({ ...profileDefaults, id: ACCOUNT_ID });
        const serverId = activeServerId();
        seedOrganizationWarmCache(serverId);

        (sync as any).hydrateWarmCachesForActiveServer();

        const state = storage.getState();
        expect(state.sessionOrganizationSnapshotVersionByServerId[serverId]).toBe(7);
        expect(Object.keys(state.sessionOrganizationPinsBySessionKey)).toEqual([`${serverId}:s_pinned`]);
        expect(state.sessionFolderAssignmentsBySessionKey[`${serverId}:s_assigned`]).toBe('f1');
        expect(state.sessionOrganizationAppearancesBySessionKey[`${serverId}:s_pinned`]?.display).toEqual({ t: 'plain', v: { color: { kind: 'custom', hex: '#123456' } } });
        expect(state.sessionOrganizationSessionAppearancesSupportedByServerId[serverId]).toBe(true);
    });

    it('issues the session list page without waiting for the organization refresh once a warm organization exists', async () => {
        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
        saveProfile({ ...profileDefaults, id: ACCOUNT_ID });
        storage.setState((state) => ({ ...state, profile: { ...(state.profile ?? {}), id: ACCOUNT_ID } as any }), true);
        const serverId = activeServerId();
        seedOrganizationWarmCache(serverId, []);
        installCredentials();

        (sync as any).hydrateWarmCachesForActiveServer();

        const requestedUrls: string[] = [];
        let releaseOrganization: () => void = () => undefined;
        const organizationHeld = new Promise<void>((resolve) => {
            releaseOrganization = () => resolve();
        });
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
            requestedUrls.push(url);
            if (url.includes('/v2/session-organization')) {
                await organizationHeld;
                return new Response(JSON.stringify({ snapshot: organizationSnapshot({ version: 9 }) }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (url.includes('/sessions')) {
                return sessionReadResponse(url);
            }
            return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }));

        const fetchSessions = (sync as any).fetchSessions();
        await vi.waitFor(() => {
            expect(requestedUrls.some((url) => url.includes('/v2/sessions'))).toBe(true);
        });

        releaseOrganization();
        await fetchSessions;
        expect(storage.getState().sessions.s_pinned?.metadata).toMatchObject({ path: '/workspace', host: 'test' });

        // The refreshed organization has to survive this process, or the next boot is back on
        // the blocking path.
        await vi.waitFor(() => {
            const pending = warmCacheStorage().getString(`session-organization-warm-cache-v1:${serverId}:${ACCOUNT_ID}`);
            expect(JSON.parse(String(pending)).version).toBe(9);
        });
        const persisted = warmCacheStorage().getString(`session-organization-warm-cache-v1:${serverId}:${ACCOUNT_ID}`);
        expect(JSON.parse(String(persisted))).toMatchObject({
            version: 9,
            pins: [expect.objectContaining({ sessionId: 's_pinned' })],
            folderAssignments: [{ sessionId: 's_assigned', folderId: 'f1' }],
            sessionAppearances: [expect.objectContaining({ sessionId: 's_pinned', display: { t: 'plain', v: { color: { kind: 'custom', hex: '#123456' } } } })],
        });
    }, 30_000);
});
