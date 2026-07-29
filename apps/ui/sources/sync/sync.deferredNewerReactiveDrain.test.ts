import { beforeEach, describe, expect, it, vi } from 'vitest';

// C6/D3 (reactive deferred-newer drain): the deferred-forward-loading backlog (mechanism B)
// must drain from a sync-owned reactive trigger — not only from a ChatList.onScroll event.
// Reopening a session (onSessionVisible) at the bottom, or reporting a near-bottom viewport,
// drains the backlog; a scrolled-up session is left deferred so the viewport is never yanked.

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
vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        request: requestMock,
        emitWithAck: vi.fn(),
        send: vi.fn(),
        onMessage: vi.fn(),
        onStatusChange: vi.fn(),
        onReconnected: vi.fn(),
        disconnect: vi.fn(),
        initialize: vi.fn(),
    },
}));

import { storage } from './domains/state/storage';
import {
    markSessionSurfaceHidden,
    markSessionSurfaceVisible,
    resetSessionSurfaceVisibilityForTests,
} from './domains/session/sessionSurfaceVisibility';
import type { Session } from './domains/state/storageTypes';
import type { NormalizedMessage } from './typesRaw';

type SyncDrainTestAccess = {
    encryption: { getSessionEncryption: (sessionId: string) => null };
    activeServerSessionIds: Set<string>;
    hasFetchedSessionsSnapshotForActiveServer: boolean;
    isForeground: boolean;
    sessionMaterializedMaxSeqById: Record<string, number>;
};

const initialStorageState = storage.getState();
const SESSION_ID = 's-deferred-drain';

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
        JSON.stringify({ messages: [], hasMore: false, nextAfterSeq: null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
}

function messagesRequestPaths(): string[] {
    return requestMock.mock.calls
        .map((call) => String(call[0]))
        .filter((path) => path.includes('/messages'));
}

async function seedDeferredNewerSession(): Promise<{ sync: typeof import('./sync').sync }> {
    const { sync } = await import('./sync');
    const syncForTest = sync as unknown as SyncDrainTestAccess;
    sync.disconnectServer();

    storage.getState().applySessions([createSession(SESSION_ID, 600)]);
    storage.getState().applyMessages(SESSION_ID, [buildMessage('m10', 10)]);
    storage.getState().applyMessagesLoaded(SESSION_ID);

    syncForTest.encryption = { getSessionEncryption: () => null };
    syncForTest.activeServerSessionIds = new Set<string>([SESSION_ID]);
    syncForTest.hasFetchedSessionsSnapshotForActiveServer = true;
    syncForTest.isForeground = true;
    syncForTest.sessionMaterializedMaxSeqById = { [SESSION_ID]: 10 };
    markSessionSurfaceVisible(SESSION_ID);

    // Drive the session into defer_forward_loading: an unpinned (scrolled-up) viewport on a
    // large reconnect gap.
    sync.onSessionViewportChange(SESSION_ID, { isPinned: false, offsetY: 420, shouldRestoreViewport: true });
    requestMock.mockImplementation(() => Promise.resolve(emptyMessagesResponse()));
    requestMock.mockClear();
    await sync.refreshSessionMessages(SESSION_ID);

    return { sync };
}

describe('sync reactive deferred-newer drain (C6/D3)', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        kvStore.clear();
        requestMock.mockReset();
        resetSessionSurfaceVisibilityForTests();
    });

    it('drains the deferred-newer backlog reactively when the session becomes visible at bottom', async () => {
        const { sync } = await seedDeferredNewerSession();
        expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(true);
        expect(messagesRequestPaths()).toHaveLength(0);

        // No ChatList / onScroll. Reopening at the bottom (onSessionVisible) drains reactively.
        sync.onSessionVisible(SESSION_ID);
        await vi.waitFor(() => {
            expect(messagesRequestPaths().length).toBeGreaterThanOrEqual(1);
            expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(false);
        });
        markSessionSurfaceHidden(SESSION_ID);
    });

    it('drains when near the bottom within the prefetch threshold', async () => {
        const { sync } = await seedDeferredNewerSession();
        expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(true);

        sync.maybeDrainDeferredNewerMessages(SESSION_ID, { isPinned: false, distanceFromBottomPx: 10 });

        await vi.waitFor(() => {
            expect(messagesRequestPaths().length).toBeGreaterThanOrEqual(1);
            expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(false);
        });
        markSessionSurfaceHidden(SESSION_ID);
    });

    it('does NOT drain (no viewport yank) for a scrolled-up session far from the bottom', async () => {
        const { sync } = await seedDeferredNewerSession();
        expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(true);

        sync.maybeDrainDeferredNewerMessages(SESSION_ID, { isPinned: false, distanceFromBottomPx: 9999 });

        // Geometry gate prevents the drain: no request, still deferred (let microtasks settle).
        await Promise.resolve();
        await Promise.resolve();
        expect(messagesRequestPaths()).toHaveLength(0);
        expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(true);
        markSessionSurfaceHidden(SESSION_ID);
    });
});
