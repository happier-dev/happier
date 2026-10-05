import { beforeEach, describe, expect, it, vi } from 'vitest';

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
                                                addEventListener: appStateAddListener as any,
                                            },
                                        }
    );
});

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/track', () => ({
    initializeTracking: vi.fn(),
    tracking: null,
    trackPaywallPresented: vi.fn(),
    trackPaywallPurchased: vi.fn(),
    trackPaywallCancelled: vi.fn(),
    trackPaywallRestored: vi.fn(),
    trackPaywallError: vi.fn(),
}));

vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: {
        onSessionFocus: vi.fn(),
        onSessionOffline: vi.fn(),
        onSessionOnline: vi.fn(),
        onMessages: vi.fn(),
        onReady: vi.fn(),
        reportContextualUpdate: vi.fn(),
    },
}));

const requestMock = vi.hoisted(() => vi.fn());

const emitWithAckMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<{ result: string; version?: number; metadata?: string; lastViewedSessionSeq?: number; viewer?: unknown }> => ({
    result: 'success',
    version: 2,
    metadata: JSON.stringify({
        path: '',
        host: '',
        readStateV1: { v: 1, sessionSeq: 3, pendingActivityAt: 0, updatedAt: 0 },
    }),
})));
const emitReadCursorWithServerScopeMock = vi.hoisted(() => vi.fn(
    async (): Promise<SessionReadCursorUpdateAck> => ({ result: 'success' }),
));

vi.mock('@/sync/api/session/emitSessionReadCursorUpdateWithServerScope', () => ({
    emitSessionReadCursorUpdateWithServerScope: emitReadCursorWithServerScopeMock,
}));

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        request: requestMock,
        emitWithAck: emitWithAckMock,
        send: vi.fn(),
        onMessage: vi.fn(),
        onStatusChange: vi.fn(),
        onReconnected: vi.fn(),
        disconnect: vi.fn(),
        initialize: vi.fn(),
    },
}));

import { storage } from './domains/state/storage';
import type { Session } from './domains/state/storageTypes';
import type { SessionListRenderableSession } from './domains/session/listing/sessionListRenderable';
import { readSessionOwnerMetadataView } from './domains/session/readSessionOwnerMetadataView';
import { getActiveServerSnapshot } from './domains/server/serverRuntime';

const initialStorageState = storage.getState();

const activeAddress = (sessionId: string) => ({
    serverId: getActiveServerSnapshot().serverId,
    sessionId,
});

function createPlainSession(params: { sessionId: string }): Session {
    const now = Date.now();
    return {
        id: params.sessionId,
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
        } as any,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
    };
}

function createExternalSessionWithObservedAttention(params: { sessionId: string }): Session {
    const now = Date.now();
    return {
        id: params.sessionId,
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
        } as any,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
    };
}

describe('sync.markSessionViewed (authoritative read cursor)', () => {
    beforeEach(async () => {
        storage.setState(initialStorageState, true);
        kvStore.clear();
        appStateAddListener.mockClear();
        emitWithAckMock.mockClear();
        emitReadCursorWithServerScopeMock.mockClear();
        requestMock.mockReset();

        const { sync } = await import('./syncEngine');
        sync.disconnectServer();
        Object.assign(sync, { credentials: undefined });
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
        Object.assign(sync, { credentials: { token: 'token', secret: 'secret' } });
        let resolveSnapshot!: (response: Response) => void;
        const delayedSnapshot = new Promise<Response>((resolve) => { resolveSnapshot = resolve; });
        const fetchBoundary = vi.spyOn(await import('./http/client'), 'serverFetch').mockResolvedValue(new Response('{}', { status: 404 }));
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
            fetchBoundary.mockRestore();
        }
    });

    it('does not apply an old Account acknowledgement to a replacement Account session', async () => {
        const sessionId = 'account-switch';
        storage.getState().applySessions([createPlainSession({ sessionId })]);
        const { sync } = await import('./sync');
        emitReadCursorWithServerScopeMock.mockImplementationOnce(async () => {
            Object.assign(sync, { credentials: { token: 'replacement-account', secret: 'secret' } });
            storage.setState({ sessions: {} });
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
        const activeSession = { ...createPlainSession({ sessionId }), lastViewedSessionSeq: 1 };
        const homeBSession = { ...createPlainSession({ sessionId }), serverId: 'home-b', lastViewedSessionSeq: 0 };
        storage.getState().applySessions([activeSession]);
        // The test needs only the shared read-state row shape; production hydration owns the full renderable projection.
        storage.getState().applyServerScopedSessionListRows('home-b', [homeBSession as unknown as SessionListRenderableSession], {
            source: 'rowOnly',
            mode: 'replace',
        });
        const { sync } = await import('./sync');

        await sync.markSessionViewed({ serverId: 'home-b', sessionId }, { sessionSeq: 2 });

        expect(emitReadCursorWithServerScopeMock).toHaveBeenCalledWith(
            { serverId: 'home-b', sessionId },
            2,
        );
        expect(storage.getState().sessions[sessionId]?.lastViewedSessionSeq).toBe(1);
        expect(storage.getState().sessionListRowsByServerId['home-b']?.[sessionId]?.lastViewedSessionSeq).toBe(2);
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

        Object.assign(sync, { credentials: { token: 'test-token', secret: 'test-secret' } });
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
