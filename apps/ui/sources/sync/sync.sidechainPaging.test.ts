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

const machineExternalSessionTranscriptPageMock = vi.hoisted(() => vi.fn());
const machineExternalSessionTranscriptReadAfterMock = vi.hoisted(() => vi.fn());
const machineExternalSessionTranscriptRefreshReadAfterMock = vi.hoisted(() => vi.fn());
vi.mock('@/sync/ops/machineExternalSessions', () => ({
    machineExternalSessionTranscriptPage: machineExternalSessionTranscriptPageMock,
    machineExternalSessionTranscriptReadAfter: machineExternalSessionTranscriptReadAfterMock,
    machineExternalSessionTranscriptRefreshReadAfter: machineExternalSessionTranscriptRefreshReadAfterMock,
}));

import { storage } from './domains/state/storage';
import type { Machine, Session } from './domains/state/storageTypes';

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

function createOnlineMachine(machineId: string): Machine {
    const now = Date.now();
    return {
        id: machineId,
        seq: 0,
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        revokedAt: null,
        metadata: null,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
    };
}

function createLiveAgentSession(sessionId: string): Session {
    return {
        ...createSession({ sessionId }),
        currentStorageState: 'machine_only',
        metadata: {
            path: '',
            host: '',
            machineId: 'machine-1',
            externalSessionV1: {
                v: 1,
                agentId: 'codex',
                machineId: 'machine-1',
                remoteSessionId: 'vendor-session-1',
                source: { kind: 'codexHome', home: 'user' },
                linkedAtMs: 1,
                qualifiedIdentity: {
                    v: 1,
                    agent: { pluginId: 'happier.codex', localId: 'codex' },
                    source: { kind: 'codexHome', contractVersion: 1 },
                },
            },
        },
    };
}

function agentToolCallItem(id: string, callId: string) {
    return {
        id,
        createdAtMs: 10,
        raw: {
            role: 'agent',
            content: {
                type: 'acp',
                agentId: 'codex',
                data: { type: 'tool-call', callId, name: 'SubAgent', id },
            },
        },
    };
}

function agentChildMessageItem(id: string, sidechainId: string, message: string) {
    return {
        id,
        createdAtMs: 5,
        sidechainId,
        raw: {
            role: 'agent',
            content: {
                type: 'acp',
                agentId: 'codex',
                data: { type: 'message', message },
            },
        },
    };
}

/** `fetchMessages` is Sync-private; this narrow alias reaches it without a broad `any`. */
type SyncTranscriptFetchTestAccess = Readonly<{
    fetchMessages: (sessionId: string) => Promise<void>;
}>;

function readSidechainRowCount(sessionId: string, sidechainId: string): number {
    const sidechains = storage.getState().sessionMessages[sessionId]?.reducerState?.sidechains;
    return sidechains?.get(sidechainId)?.length ?? 0;
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
                                agentId: 'claude',
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

describe('sync live-Agent sidechain demand', () => {
    beforeEach(async () => {
        storage.setState(initialStorageState, true);
        kvStore.clear();
        appStateAddListener.mockClear();
        requestMock.mockReset();
        machineExternalSessionTranscriptPageMock.mockReset();
        machineExternalSessionTranscriptReadAfterMock.mockReset();
        machineExternalSessionTranscriptRefreshReadAfterMock.mockReset();

        const { sync } = await import('./sync');
        sync.disconnectServer();

        storage.getState().applyMachines([createOnlineMachine('machine-1')], false);
        storage.getState().applySessions([createLiveAgentSession('s-live')]);
        storage.getState().resetSessionMessages('s-live');
        (sync as any).encryption = { getSessionEncryption: () => null };
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('hydrates a sidechain from the Agent global cursor instead of the server sidechain scope', async () => {
        // The parent SubAgent tool call is in the bounded latest Agent page; its child rows
        // are one older Agent page back. This is the ordinary Codex root-family layout.
        machineExternalSessionTranscriptPageMock
            .mockResolvedValueOnce({
                ok: true,
                items: [agentToolCallItem('parent-1', 'tool_task_1')],
                nextCursor: 'older-1',
                tailCursor: 'tail-1',
                hasMore: true,
            })
            .mockResolvedValueOnce({
                ok: true,
                items: [agentChildMessageItem('child-1', 'tool_task_1', 'child output')],
                nextCursor: null,
                hasMore: false,
            });
        machineExternalSessionTranscriptReadAfterMock.mockResolvedValue({
            ok: true,
            items: [],
            nextCursor: 'tail-1',
        });

        const { sync } = await import('./sync');
        await (sync as unknown as SyncTranscriptFetchTestAccess).fetchMessages('s-live');
        expect(readSidechainRowCount('s-live', 'tool_task_1')).toBe(0);

        let status = await sync.ensureSidechainMessagesLoaded('s-live', 'tool_task_1');
        for (let attempt = 0; attempt < 5 && status !== 'loaded'; attempt += 1) {
            status = await sync.ensureSidechainMessagesLoaded('s-live', 'tool_task_1');
        }

        expect(status).toBe('loaded');
        // The server `/messages` sidechain scope is not peer authority for a live Agent:
        // its persisted rows are filtered out, so calling it can only report a false empty.
        expect(requestMock.mock.calls.map((call) => String(call[0]))
            .filter((path) => path.includes('scope=sidechain'))).toEqual([]);
        expect(readSidechainRowCount('s-live', 'tool_task_1')).toBeGreaterThan(0);
    });

    it('routes older sidechain paging through the one Agent global cursor', async () => {
        machineExternalSessionTranscriptPageMock
            .mockResolvedValueOnce({
                ok: true,
                items: [agentToolCallItem('parent-1', 'tool_task_1')],
                nextCursor: 'older-1',
                tailCursor: 'tail-1',
                hasMore: true,
            })
            .mockResolvedValueOnce({
                ok: true,
                items: [agentChildMessageItem('child-1', 'tool_task_1', 'older child output')],
                nextCursor: 'older-2',
                hasMore: true,
            });
        machineExternalSessionTranscriptReadAfterMock.mockResolvedValue({
            ok: true,
            items: [],
            nextCursor: 'tail-1',
        });

        const { sync } = await import('./sync');
        await (sync as unknown as SyncTranscriptFetchTestAccess).fetchMessages('s-live');

        const result = await sync.loadOlderSidechainMessages('s-live', 'tool_task_1');

        expect(result).toMatchObject({ loaded: 1, hasMore: true, status: 'loaded' });
        expect(machineExternalSessionTranscriptPageMock.mock.calls[1]?.[0])
            .toMatchObject({ direction: 'older', cursor: 'older-1' });
        expect(requestMock.mock.calls.map((call) => String(call[0]))
            .filter((path) => path.includes('scope=sidechain'))).toEqual([]);
        expect(readSidechainRowCount('s-live', 'tool_task_1')).toBeGreaterThan(0);
    });
});
