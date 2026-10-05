import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvalidateSync } from '@/utils/sessions/sync';

// Plan B8 (transcript-viewport-single-owner port): returning to the bottom is a
// first-class live-tail transition. A stored UNPINNED viewport must poison the catch-up
// decision into `defer_forward_loading` on a large reconnect gap; a live-tail report
// ({ isPinned: true, shouldRestoreViewport: false }) must flip the same gap to
// `tail_reset_latest_page` (snapshot fetch) and clear any deferred-newer marker.

// Sync imports persistence, which instantiates MMKV. Mock it for deterministic tests.
const kvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getAllKeys() {
            return [...kvStore.keys()];
        }
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

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        AppState: {
            currentState: 'active',
            addEventListener: vi.fn(() => ({ remove: vi.fn() })),
        },
    });
});

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
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

vi.mock('@/track', () => ({
    initializeTracking: vi.fn(),
    tracking: null,
    trackPaywallPresented: vi.fn(),
    trackPaywallPurchased: vi.fn(),
    trackPaywallCancelled: vi.fn(),
    trackPaywallRestored: vi.fn(),
    trackPaywallError: vi.fn(),
}));

const requestMock = vi.hoisted(() => vi.fn());
// Scoped credential persistence and HTTP remain the only request boundaries.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: {
            getCredentialsForServerUrl: async () => ({ token: 'hdr.eyJzdWIiOiJhY2NvdW50LWEifQ.sig' }),
        },
    });
});
vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        request: requestMock,
        emitWithAck: vi.fn(),
        send: vi.fn(),
        onMessage: vi.fn(),
        onStatusChange: vi.fn(),
        onReconnected: vi.fn(),
        disconnect: vi.fn(),
        invalidateRequests: vi.fn(),
        initialize: vi.fn(),
    },
}));

import { storage } from './domains/state/storage';
import {
    markSessionSurfaceVisible,
    resetSessionSurfaceVisibilityForTests,
} from './domains/session/sessionSurfaceVisibility';
import type { Session } from './domains/state/storageTypes';
import type { NormalizedMessage } from "@happier-dev/session-core/raw";

type SyncLiveTailCatchUpTestAccess = {
    getOrCreateMessagesSync(sessionId: string): InvalidateSync;
    encryption: {
        getSessionEncryption: (sessionId: string) => null;
        removeSessionEncryption: (sessionId: string) => void;
    };
    activeServerSessionIds: Set<string>;
    hasFetchedSessionsSnapshotForActiveServer: boolean;
    isForeground: boolean;
    sessionMaterializedMaxSeqById: Record<string, number>;
    lastSocketOfflineDurationMs: number | null;
    lastSocketDisconnectedAtMs: number | null;
    socketOfflineCatchUpConsumedSessionIds: Set<string>;
    retireLocalSession(sessionId: string): void;
};

const initialStorageState = storage.getState();

const SESSION_ID = 's-live-tail';

function createSession(sessionId: string, seq: number): Session {
    const now = Date.now();
    return {
        id: sessionId,
        seq,
        encryptionMode: 'plain',
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: null,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
    };
}

function buildMessage(id: string, seq: number): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt: seq,
        role: 'user',
        content: { type: 'text', text: id },
        seq,
        isSidechain: false,
    };
}

function emptyMessagesResponse(): Response {
    return new Response(
        JSON.stringify({ messages: [], hasMore: false, nextBeforeSeq: null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
}

function messagesRequestPaths(): string[] {
    return requestMock.mock.calls
        .map((call) => String(call[0]))
        .filter((path) => path.includes('/messages'));
}

async function seedLargeGapSession(): Promise<{ sync: typeof import('./sync').sync }> {
    const { sync } = await import('./syncEngine');
    const syncForTest = sync as unknown as SyncLiveTailCatchUpTestAccess;
    sync.disconnectServer();

    // Materialized up to seq 10, session hint far ahead: a large catch-up gap
    // (>= messageLargeGapSeq default 500).
    storage.getState().applySessions([createSession(SESSION_ID, 600)]);
    storage.getState().applyMessages(SESSION_ID, [buildMessage('m10', 10)]);
    storage.getState().applyMessagesLoaded(SESSION_ID);

    syncForTest.encryption = {
        getSessionEncryption: () => null,
        removeSessionEncryption: vi.fn(),
    };
    syncForTest.activeServerSessionIds = new Set<string>([SESSION_ID]);
    syncForTest.hasFetchedSessionsSnapshotForActiveServer = true;
    syncForTest.isForeground = true;
    syncForTest.sessionMaterializedMaxSeqById = { [SESSION_ID]: 10 };
    // C6/D1: catch-up only runs for a live-content consumer. These cases exercise the runtime
    // defer / tail-reset decisions, so the session must be surface-visible for the gate to pass.
    markSessionSurfaceVisible(SESSION_ID);
    requestMock.mockImplementation(() => Promise.resolve(emptyMessagesResponse()));
    requestMock.mockClear();
    return { sync };
}

describe('sync live-tail catch-up decision (plan B8)', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        kvStore.clear();
        requestMock.mockReset();
        vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input instanceof Request ? input.url : input);
            if (url.endsWith('/v1/auth/ping') || url.endsWith('/health')) {
                return Response.json({ ok: true });
            }
            return requestMock(input, init);
        });
        resetSessionSurfaceVisibilityForTests();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('defers forward loading on a large gap while the stored viewport is unpinned', async () => {
        const { sync } = await seedLargeGapSession();

        sync.onSessionViewportChange(SESSION_ID, {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
        });

        await sync.refreshSessionMessages(SESSION_ID);

        expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(true);
        expect(messagesRequestPaths()).toHaveLength(0);
    });

    it('tail-resets the latest page on a large gap after a live-tail bottom arrival', async () => {
        const { sync } = await seedLargeGapSession();

        // Stored unpinned viewport (the user had scrolled away)...
        sync.onSessionViewportChange(SESSION_ID, {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
        });
        await sync.refreshSessionMessages(SESSION_ID);
        expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(true);
        expect(messagesRequestPaths()).toHaveLength(0);

        // ...then a trusted bottom arrival emits live-tail intent.
        sync.onSessionViewportChange(SESSION_ID, {
            isPinned: true,
            offsetY: 0,
            shouldRestoreViewport: false,
        });
        const syncForTest = sync as unknown as SyncLiveTailCatchUpTestAccess;
        expect(await syncForTest.getOrCreateMessagesSync(SESSION_ID).awaitQueue({ timeoutMs: 2_000 }))
            .toEqual({ status: 'completed' });

        expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(false);
        expect(messagesRequestPaths().length).toBeGreaterThanOrEqual(1);
    });

    it('does not recreate transcript state when delete wins a held tail-reset catch-up', async () => {
        const { sync } = await seedLargeGapSession();
        const syncForTest = sync as unknown as SyncLiveTailCatchUpTestAccess;
        syncForTest.lastSocketOfflineDurationMs = 1_000;
        syncForTest.lastSocketDisconnectedAtMs = null;

        let releasePage!: (response: Response) => void;
        const heldPage = new Promise<Response>((resolve) => {
            releasePage = resolve;
        });
        let markRequestStarted!: () => void;
        const requestStarted = new Promise<void>((resolve) => {
            markRequestStarted = resolve;
        });
        requestMock.mockImplementationOnce(async () => {
            markRequestStarted();
            return await heldPage;
        });

        const catchUp = sync.refreshSessionMessages(SESSION_ID);
        await requestStarted;
        syncForTest.retireLocalSession(SESSION_ID);
        releasePage(emptyMessagesResponse());
        await catchUp;

        expect(storage.getState().sessions[SESSION_ID]).toBeUndefined();
        expect(storage.getState().sessionMessages[SESSION_ID]).toBeUndefined();
        expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(false);
        expect(syncForTest.socketOfflineCatchUpConsumedSessionIds.has(SESSION_ID)).toBe(false);
    });
});
