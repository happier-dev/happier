import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import type { Session } from './domains/state/storageTypes';

const initialStorageState = storage.getState();

function createSession(params: { sessionId: string }): Session {
    const now = Date.now();
    return {
        id: params.sessionId,
        seq: 0,
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
    };
}

describe('sync sidechain paging', () => {
    beforeEach(async () => {
        storage.setState(initialStorageState, true);
        kvStore.clear();
        appStateAddListener.mockClear();
        requestMock.mockReset();

        const { sync } = await import('./sync');
        sync.disconnectServer();

        storage.getState().applySessions([createSession({ sessionId: 's1' })]);
        storage.getState().resetSessionMessages('s1');

        // Provide a minimal decrypt shim; the test only asserts request behavior.
        (sync as any).encryption = {
            getSessionEncryption: () => ({
                decryptMessages: async (messages: any[]) =>
                    messages.map((m) => ({
                        id: m.id,
                        localId: m.localId ?? null,
                        createdAt: m.createdAt,
                        seq: m.seq,
                        content: {
                            role: 'agent',
                            content: {
                                type: 'acp',
                                provider: 'claude',
                                data: { type: 'message', message: 'child', sidechainId: 'tool_task_1' },
                            },
                        },
                    })),
            }),
        };
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('fetches sidechain latest page without marking the main transcript as loaded', async () => {
        requestMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    messages: [
                        {
                            id: 'm1',
                            seq: 123,
                            localId: null,
                            sidechainId: 'tool_task_1',
                            content: { t: 'encrypted', c: 'cipher' },
                            createdAt: 1,
                            updatedAt: 1,
                        },
                    ],
                    hasMore: false,
                    nextBeforeSeq: null,
                    nextAfterSeq: null,
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        const { sync } = await import('./sync');
        expect(storage.getState().sessionMessages['s1']?.isLoaded ?? false).toBe(false);

        await sync.ensureSidechainMessagesLoaded('s1', 'tool_task_1');

        expect(requestMock).toHaveBeenCalledTimes(1);
        const requestedPath = requestMock.mock.calls[0]?.[0];
        expect(String(requestedPath)).toContain('/v1/sessions/s1/messages?');
        expect(String(requestedPath)).toContain('scope=sidechain');
        expect(String(requestedPath)).toContain('sidechainId=tool_task_1');

        expect(storage.getState().sessionMessages['s1']?.isLoaded ?? false).toBe(false);
    });

    it('does not refetch sidechain latest page when pagination state is already initialized', async () => {
        requestMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    messages: [
                        {
                            id: 'm1',
                            seq: 123,
                            localId: null,
                            sidechainId: 'tool_task_1',
                            content: { t: 'encrypted', c: 'cipher' },
                            createdAt: 1,
                            updatedAt: 1,
                        },
                    ],
                    hasMore: false,
                    nextBeforeSeq: null,
                    nextAfterSeq: null,
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        const { sync } = await import('./sync');

        await sync.ensureSidechainMessagesLoaded('s1', 'tool_task_1');
        await sync.ensureSidechainMessagesLoaded('s1', 'tool_task_1');

        expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it('does not refetch sidechain latest page when the sidechain is currently empty', async () => {
        requestMock.mockImplementation(async () => {
            return new Response(
                JSON.stringify({
                    messages: [],
                    hasMore: false,
                    nextBeforeSeq: null,
                    nextAfterSeq: null,
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
        });

        const { sync } = await import('./sync');

        await sync.ensureSidechainMessagesLoaded('s1', 'tool_task_empty');
        await sync.ensureSidechainMessagesLoaded('s1', 'tool_task_empty');

        expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it('uses nextBeforeSeq from the latest sidechain page as the cursor for older paging', async () => {
        requestMock
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        messages: [
                            {
                                id: 'm_new',
                                seq: 200,
                                localId: null,
                                sidechainId: 'tool_task_1',
                                content: { t: 'encrypted', c: 'cipher' },
                                createdAt: 1,
                                updatedAt: 1,
                            },
                            {
                                id: 'm_oldest_in_page',
                                seq: 51,
                                localId: null,
                                sidechainId: 'tool_task_1',
                                content: { t: 'encrypted', c: 'cipher' },
                                createdAt: 1,
                                updatedAt: 1,
                            },
                        ],
                        hasMore: true,
                        nextBeforeSeq: 51,
                        nextAfterSeq: null,
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                ),
            )
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        messages: [],
                        hasMore: false,
                        nextBeforeSeq: null,
                        nextAfterSeq: null,
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                ),
            );

        const { sync } = await import('./sync');

        await sync.ensureSidechainMessagesLoaded('s1', 'tool_task_1');
        await sync.loadOlderSidechainMessages('s1', 'tool_task_1');

        expect(requestMock).toHaveBeenCalledTimes(2);
        const olderPath = String(requestMock.mock.calls[1]?.[0] ?? '');
        expect(olderPath).toContain('scope=sidechain');
        expect(olderPath).toContain('sidechainId=tool_task_1');
        expect(olderPath).toContain('beforeSeq=51');
    });
});
