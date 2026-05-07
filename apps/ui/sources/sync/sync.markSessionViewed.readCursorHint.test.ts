import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const emitWithAckMock = vi.hoisted(() => vi.fn(async () => ({
    result: 'success',
    version: 2,
    metadata: JSON.stringify({
        path: '',
        host: '',
        readStateV1: { v: 1, sessionSeq: 3, pendingActivityAt: 0, updatedAt: 0 },
    }),
})));

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        request: vi.fn(),
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

const initialStorageState = storage.getState();

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

describe('sync.markSessionViewed (authoritative read cursor)', () => {
    beforeEach(async () => {
        storage.setState(initialStorageState, true);
        kvStore.clear();
        appStateAddListener.mockClear();
        emitWithAckMock.mockClear();

        const { sync } = await import('./sync');
        sync.disconnectServer();
    });

    it('publishes the authoritative read cursor over the dedicated socket event', async () => {
        const sessionId = 's_read_hint_1';
        storage.getState().applySessions([createPlainSession({ sessionId })]);

        const { sync } = await import('./sync');

        await sync.markSessionViewed(sessionId);

        const updateReadCursorCall = (emitWithAckMock.mock.calls as unknown[][])
            .map((call) => {
                const [event, payload] = call;
                if (
                    event === 'update-read-cursor'
                    && typeof payload === 'object'
                    && payload !== null
                    && typeof (payload as { sid?: unknown }).sid === 'string'
                    && typeof (payload as { lastViewedSessionSeq?: unknown }).lastViewedSessionSeq === 'number'
                ) {
                    return [event, payload] as const;
                }
                return null;
            })
            .find(
                (
                    call,
                ): call is readonly [
                    event: 'update-read-cursor',
                    payload: { sid: string; lastViewedSessionSeq: number },
                ] => call !== null,
            );
        expect(updateReadCursorCall).toBeDefined();
        expect(updateReadCursorCall?.[1]).toEqual({
            sid: sessionId,
            lastViewedSessionSeq: 3,
        });
    });

    it('marks the session locally viewed even when the cursor publish fails', async () => {
        const sessionId = 's_read_hint_local_failure';
        storage.getState().applySessions([createPlainSession({ sessionId })]);
        emitWithAckMock.mockRejectedValueOnce(new Error('socket offline'));

        const { sync } = await import('./sync');

        await expect(sync.markSessionViewed(sessionId)).resolves.toBeUndefined();

        expect(storage.getState().sessions[sessionId]?.lastViewedSessionSeq).toBe(3);
    });
});
