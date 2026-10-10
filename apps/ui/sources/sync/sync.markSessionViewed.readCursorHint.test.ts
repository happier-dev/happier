import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

import type { SessionReadCursorUpdateAck } from '@/sync/api/session/emitSessionReadCursorUpdateWithServerScope';

// Sync imports persistence, which instantiates MMKV. Mock it for deterministic tests.
const kvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return kvStore.get(key);
        }
        set(key: string, value: string) {
            kvStore.set(key, value);
        }
        delete(key: string) {
            kvStore.delete(key);
        }
        getAllKeys() {
            return [...kvStore.keys()];
        }
        clearAll() {
            kvStore.clear();
        }
    }

    return { MMKV };
});

const appStateAddListener = vi.hoisted(() => vi.fn(() => ({ remove: vi.fn() })));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                            Platform: {
                                                OS: 'web',
                                            },
                                            AppState: {
                                                addEventListener: appStateAddListener,
                                            },
                                        }
    );
});

const requestMock = vi.hoisted(() => vi.fn());

const emitWithAckMock = vi.hoisted(() => vi.fn<(event: string, payload: unknown) => void>());
// ACK fixture at Socket.IO only; the scoped read-cursor emitter remains real.
const emitReadCursorWithServerScopeMock = vi.hoisted(() => vi.fn(
    async (..._args: Parameters<typeof import('@/sync/api/session/emitSessionReadCursorUpdateWithServerScope').emitSessionReadCursorUpdateWithServerScope>): Promise<SessionReadCursorUpdateAck> => ({ result: 'success' }),
));

import { storage } from './domains/state/storage';
import type { Session } from './domains/state/storageTypes';
import { readSessionOwnerMetadataView } from './domains/session/readSessionOwnerMetadataView';
import { getActiveServerSnapshot } from './domains/server/serverRuntime';

const initialStorageState = storage.getState();

const activeAddress = (sessionId: string) => ({
    serverId: getActiveServerSnapshot().serverId,
    sessionId,
});

function createPlainSession(params: { sessionId: string }): Session {
    const now = Date.now();
    return createSessionFixture({
        id: params.sessionId,
        serverId: getActiveServerSnapshot().serverId,
        seq: 3,
        encryptionMode: 'plain',
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: {
            path: '',
            host: '',
            readStateV1: { v: 1, sessionSeq: 0, pendingActivityAt: 0, updatedAt: 0 },
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
    });
}

function createExternalSessionWithObservedAttention(params: { sessionId: string }): Session {
    const now = Date.now();
    return createSessionFixture({
        id: params.sessionId,
        serverId: getActiveServerSnapshot().serverId,
        seq: 0,
        encryptionMode: 'plain',
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: {
            path: '',
            host: '',
            externalSessionV1: {
                v: 1,
                agentId: 'codex',
                machineId: 'machine-1',
                remoteSessionId: 'vendor-session-1',
                source: { kind: 'codexHome', home: 'user' },
                followPolicyV1: { v: 1, policy: 'background_follow' },
            },
            externalSessionAttentionV1: {
                v: 1,
                observedProgressToken: '2:direct-msg-2',
                observedAtMs: 2,
            },
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
    });
}

describe('sync.markSessionViewed (authoritative read cursor)', () => {
    let boundary: Awaited<ReturnType<typeof installSessionOpsNetworkBoundary>>;
    let localStorage: ReturnType<typeof installLocalStorageMock>;
    let webLocks: ReturnType<typeof installWebLockManagerMock>;
    let home: Awaited<ReturnType<Awaited<ReturnType<typeof installSessionOpsNetworkBoundary>>['addHome']>>;
    beforeEach(async () => {
        storage.setState(initialStorageState, true);
        kvStore.clear();
        appStateAddListener.mockClear();
        emitWithAckMock.mockClear();
        emitReadCursorWithServerScopeMock.mockClear();
        requestMock.mockReset();
        emitReadCursorWithServerScopeMock.mockReset().mockResolvedValue({ result: 'success' });
        localStorage = installLocalStorageMock();
        webLocks = installWebLockManagerMock();
        boundary = await installSessionOpsNetworkBoundary();
        home = await boundary.addHome('https://read-cursor.example.test', 'account-a');
        boundary.setSocketAckResponder(async ({ serverUrl, event, payload }) => {
            emitWithAckMock(event, payload);
            if (event !== 'update-read-cursor') return null;
            const parsed = payload as { sid: string; lastViewedSessionSeq: number };
            const { resolveUniqueServerProfileByUrl } = await import('./domains/server/serverProfiles');
            const profile = resolveUniqueServerProfileByUrl(serverUrl);
            if (!profile) throw new Error(`Unregistered read cursor Home: ${serverUrl}`);
            return emitReadCursorWithServerScopeMock({ serverId: profile.id, sessionId: parsed.sid }, parsed.lastViewedSessionSeq);
        });
        boundary.setHttpResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/auth/ping') return Response.json({});
            if (path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 0,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 });
            return await requestMock(path, init) ?? Response.json({}, { status: 404 });
        });
        await loadSyncSingletonForTests();
        const { setActiveServerId } = await import('./domains/server/serverProfiles');
        await setActiveServerId(home.id, { scope: 'device' });
        const { restoreConnectionToActiveServer } = await import('./runtime/orchestration/connectionManager');
        await restoreConnectionToActiveServer({ token: home.token });

        emitWithAckMock.mockClear();
        emitReadCursorWithServerScopeMock.mockClear();
        requestMock.mockClear();
    });

    afterEach(async () => {
        const { disconnectActiveServerConnection } = await import('./runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        await boundary.dispose();
        webLocks.restore();
        localStorage.restore();
        vi.restoreAllMocks();
    });

    it('does not write a read cursor or metadata when browsing an untracked viewer', async () => {
        const sessionId = 'untracked';
        const session = { ...createPlainSession({ sessionId }), viewer: {
            readState: { state: 'not_started' as const },
            relevance: { relevant: false, reasons: [] },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' as const },
            follow: { follows: false, notificationLevel: null },
                notification: { level: 'none' as const, source: 'none' as const },
        } };
        storage.getState().applySessions([session]);
        const { sync } = await import('./sync');
        await sync.markSessionViewed(activeAddress(sessionId));
        expect(emitReadCursorWithServerScopeMock).not.toHaveBeenCalled();
        expect(emitWithAckMock).not.toHaveBeenCalled();
        expect(storage.getState().sessions[sessionId]?.lastViewedSessionSeq).toBeUndefined();
    });

    it('does not maintain a second read frontier in owner metadata', async () => {
        const sessionId = 'metadata-contraction';
        storage.getState().applySessions([createPlainSession({ sessionId })]);
        const { sync } = await import('./sync');
        await expect(sync.markSessionViewed(activeAddress(sessionId))).resolves.toBeUndefined();
        expect(emitWithAckMock.mock.calls.filter(([event]) => event === 'update-metadata')).toEqual([]);
    });

    it('uses the acknowledged viewer projection to clear personal attention', async () => {
        const sessionId = 'viewer-ack';
        const viewer = {
            readState: { state: 'tracking' as const, lastViewedSessionSeq: 0, unreadSince: 1 },
            relevance: { relevant: true, reasons: ['owned_by_me' as const] },
            attention: { needsAttention: true, reasons: ['unread' as const], primary: 'unread' as const, presentation: 'full' as const },
            follow: { follows: false as const, notificationLevel: null },
            notification: { level: 'important' as const, source: 'owner' as const },
        };
        const acknowledgedViewer = {
            ...viewer,
            readState: { state: 'tracking' as const, lastViewedSessionSeq: 3, unreadSince: null },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' as const },
        };
        storage.getState().applySessions([{ ...createPlainSession({ sessionId }), viewer }]);
        emitReadCursorWithServerScopeMock.mockResolvedValueOnce({ result: 'success', lastViewedSessionSeq: 3, viewer: acknowledgedViewer });
        const { sync } = await import('./sync');
        await sync.markSessionViewed(activeAddress(sessionId));
        expect(storage.getState().sessions[sessionId]?.viewer).toEqual(acknowledgedViewer);
    });

    it.each(['automatic', 'manual'] as const)('keeps a %s read acknowledgement when an older in-flight list snapshot completes', async (readKind) => {
        const { sync } = await import('./sync');
        const sessionId = 'viewer-snapshot-race';
        const viewer = {
            readState: { state: 'tracking' as const, lastViewedSessionSeq: 0, unreadSince: 1 },
            relevance: { relevant: true, reasons: ['owned_by_me' as const] },
            attention: { needsAttention: true, reasons: ['unread' as const], primary: 'unread' as const, presentation: 'full' as const },
            follow: { follows: false as const, notificationLevel: null },
            notification: { level: 'important' as const, source: 'owner' as const },
        };
        const acknowledgedViewer = {
            ...viewer,
            readState: { state: 'tracking' as const, lastViewedSessionSeq: 3, unreadSince: null },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' as const },
        };
        const session = { ...createPlainSession({ sessionId }), viewer, lastViewedSessionSeq: 0 };
        storage.getState().applySessions([session]);
        let resolveSnapshot!: (response: Response) => void;
        const delayedSnapshot = new Promise<Response>((resolve) => { resolveSnapshot = resolve; });
        requestMock.mockImplementation(async (path: string) => {
            if (path.endsWith('/read-state')) return new Response(JSON.stringify({ success: true, state: 'read', lastViewedSessionSeq: 3, viewer: acknowledgedViewer }), { status: 200 });
            if (path.startsWith('/v2/sessions')) return delayedSnapshot.then((response) => response.clone());
            return new Response('{}', { status: 404 });
        });
        const refresh = sync.refreshSessions({ awaitSessionListHydration: true });
        try {
            await vi.waitFor(() => expect(requestMock.mock.calls.some(([path]) => String(path).startsWith('/v2/sessions'))).toBe(true));
            if (readKind === 'automatic') {
                emitReadCursorWithServerScopeMock.mockResolvedValueOnce({ result: 'success', lastViewedSessionSeq: 3, viewer: acknowledgedViewer });
                await sync.markSessionViewed(activeAddress(sessionId));
            } else {
                const { sessionSetManualReadStateWithServerScope } = await import('./ops/sessionReadState');
                await expect(sessionSetManualReadStateWithServerScope(sessionId, 'read')).resolves.toMatchObject({ success: true });
            }
            expect(storage.getState().sessions[sessionId]?.viewer).toEqual(acknowledgedViewer);
            resolveSnapshot(new Response(JSON.stringify({
                sessions: [{
                    id: session.id, seq: session.seq, createdAt: session.createdAt,
                    updatedAt: session.updatedAt, active: true, activeAt: session.activeAt,
                    archivedAt: null, metadata: JSON.stringify(session.metadata), metadataVersion: session.metadataVersion,
                    agentState: null, agentStateVersion: session.agentStateVersion,
                    dataEncryptionKey: null, encryptionMode: 'plain', share: null,
                    viewer, lastViewedSessionSeq: 0,
                }], nextCursor: null, hasNext: false,
            }), { status: 200 }));
            await refresh;
            expect(Object.values(storage.getState().sessionListRowsByServerId).map((rows) => rows[sessionId]).find(Boolean)?.viewer).toEqual(acknowledgedViewer);
            expect(storage.getState().sessions[sessionId]?.viewer).toEqual(acknowledgedViewer);
        } finally {
            resolveSnapshot(new Response('{}', { status: 404 }));
            await refresh.catch(() => undefined);
        }
    });

    it('does not apply an old Account acknowledgement to a replacement Account session', async () => {
        const sessionId = 'account-switch';
        storage.getState().applySessions([createPlainSession({ sessionId })]);
        const { sync } = await import('./sync');
        emitReadCursorWithServerScopeMock.mockImplementationOnce(async () => {
            await boundary.setAccount(home.serverUrl, 'account-b');
            const { restoreConnectionToActiveServer } = await import('./runtime/orchestration/connectionManager');
            const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
            await restoreConnectionToActiveServer({ token: createAccountTokenForTests('account-b') });
            storage.getState().applySessions([{ ...createPlainSession({ sessionId }), lastViewedSessionSeq: 1 }]);
            return { result: 'success', lastViewedSessionSeq: 3 };
        });
        await sync.markSessionViewed(activeAddress(sessionId));
        expect(storage.getState().sessions[sessionId]?.lastViewedSessionSeq).toBe(1);
    });

    it('publishes the authoritative read cursor over the dedicated socket event', async () => {
        const sessionId = 's_read_hint_1';
        storage.getState().applySessions([createPlainSession({ sessionId })]);

        const { sync } = await import('./sync');

        await sync.markSessionViewed(activeAddress(sessionId));

        expect(emitReadCursorWithServerScopeMock).toHaveBeenCalledWith(
            activeAddress(sessionId),
            3,
        );
    });

    it('updates only the captured Home row when two Homes cache the same Session ID', async () => {
        const sessionId = 'same-session';
        const homeB = await boundary.addHome('https://read-cursor-b.example.test', 'account-a');
        const activeSession = { ...createPlainSession({ sessionId }), lastViewedSessionSeq: 1 };
        const homeBSession = createSessionListRenderableSessionFixture({
            ...createPlainSession({ sessionId }), lastViewedSessionSeq: 0,
        });
        storage.getState().applySessions([activeSession]);
        storage.getState().applyServerScopedSessionListRows(homeB.id, [homeBSession], {
            source: 'rowOnly',
            mode: 'replace',
        });
        const { sync } = await import('./sync');

        await sync.markSessionViewed({ serverId: homeB.id, sessionId }, { sessionSeq: 2 });

        expect(emitReadCursorWithServerScopeMock).toHaveBeenCalledWith(
            { serverId: homeB.id, sessionId },
            2,
        );
        expect(storage.getState().sessions[sessionId]?.lastViewedSessionSeq).toBe(1);
        expect(storage.getState().sessionListRowsByServerId[homeB.id]?.[sessionId]?.lastViewedSessionSeq).toBe(2);
    });

    it('marks the session locally viewed even when the cursor publish fails', async () => {
        const sessionId = 's_read_hint_local_failure';
        storage.getState().applySessions([createPlainSession({ sessionId })]);
        emitReadCursorWithServerScopeMock.mockRejectedValueOnce(new Error('socket offline'));

        const { sync } = await import('./sync');

        await expect(sync.markSessionViewed(activeAddress(sessionId))).resolves.toBeUndefined();

        expect(storage.getState().sessions[sessionId]?.lastViewedSessionSeq).toBe(3);
    });

    it('marks the latest observed direct-session progress as viewed without persisting transcript bodies', async () => {
        const sessionId = 's_direct_attention_1';
        storage.getState().applySessions([createExternalSessionWithObservedAttention({ sessionId })]);
        const { sync } = await import('./sync');

        requestMock.mockImplementation(async (path: string, init?: RequestInit) => {
            if (init?.method === 'PATCH') return new Response(JSON.stringify({ success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 2 }, agentState: { version: 2 } }));
            if (path === '/v1/account/encryption/currentness') {
                return new Response(JSON.stringify({ mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 }));
            }
            const session = createExternalSessionWithObservedAttention({ sessionId });
            return new Response(JSON.stringify({ session: {
                ...session,
                metadata: JSON.stringify(session.metadata),
                dataEncryptionKey: null,
                metadataLayoutVersion: 0,
            } }));
        });
        await sync.markSessionViewed(activeAddress(sessionId));

        const updateMetadataCall = requestMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
        expect(updateMetadataCall).toBeDefined();
        const encodedMetadata = String(updateMetadataCall?.[1]?.body ?? '');
        expect(encodedMetadata).toContain('externalSessionAttentionV1');
        expect(encodedMetadata).toContain('observedProgressToken');
        expect(encodedMetadata).toContain('viewedProgressToken');
        const ownerMetadata = readSessionOwnerMetadataView(storage.getState().sessions[sessionId]);

        expect(ownerMetadata?.externalSessionV1).toEqual(expect.objectContaining({
            followPolicyV1: { v: 1, policy: 'background_follow' },
        }));
        expect(ownerMetadata?.externalSessionAttentionV1).toEqual({
            v: 1,
            observedProgressToken: '2:direct-msg-2',
            viewedProgressToken: '2:direct-msg-2',
            observedAtMs: 2,
            viewedAtMs: 2,
        });
    });
});
