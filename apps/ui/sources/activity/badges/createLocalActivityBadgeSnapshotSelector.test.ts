import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';

import { createStorageStoreMock } from '@/dev/testkit/mocks/storage';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { registerStorageStateReader } from '@/sync/domains/state/storageStateReaderBridge';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import { createReducer } from '@/sync/reducer/reducer';
import type { SessionMessages } from '@/sync/store/domains/messages';
import type { StorageState } from '@/sync/store/types';
import { createLocalActivityBadgeSnapshotSelector } from './createLocalActivityBadgeSnapshotSelector';

let currentState: StorageState;

function createStorageState(overrides: Partial<StorageState>): StorageState {
    currentState = createStorageStoreMock({
        sessions: {},
        sessionListRenderables: {},
        sessionListIndexByServerId: {},
        concurrentSessionListCacheByServerId: {},
        sessionMessages: {},
        isDataReady: true,
        ...overrides,
    }).getState();
    return currentState;
}

function createSession(overrides: Partial<Session> & Pick<Session, 'id'>): Session {
    const { id, ...rest } = overrides;
    return {
        seq: 0,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
        pendingCount: 0,
        ...rest,
        id,
    } as Session;
}

function createRenderable(
    overrides: Partial<SessionListRenderableSession> & Pick<SessionListRenderableSession, 'id'>,
): SessionListRenderableSession {
    const { id, ...rest } = overrides;
    return {
        seq: 0,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        metadataVersion: 0,
        agentStateVersion: 0,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
        ...rest,
        id,
    };
}

function createSessionMessages(overrides: Partial<SessionMessages> = {}): SessionMessages {
    return {
        messageIdsOldestFirst: [],
        messagesById: {},
        messagesMap: {},
        reducerState: createReducer(),
        latestThinkingMessageId: null,
        latestThinkingMessageActivityAtMs: null,
        latestReadyEventSeq: null,
        latestReadyEventAt: null,
        messagesVersion: 1,
        isLoaded: true,
        ...overrides,
    };
}

function createPermissionMessage(createdAt: number): Message {
    return {
        kind: 'tool-call',
        id: 'message-permission',
        localId: null,
        createdAt,
        children: [],
        tool: {
            id: 'request-permission',
            name: 'Bash',
            state: 'running',
            input: { command: 'ls' },
            createdAt,
            startedAt: createdAt,
            completedAt: null,
            description: null,
            permission: {
                id: 'request-permission',
                status: 'pending',
                kind: 'permission',
            },
        },
    };
}

function expectNoObjectKeysOrValuesOnRecords(action: () => void, guardedRecords: readonly object[]): void {
    const originalObjectKeys = Object.keys.bind(Object);
    const originalObjectValues = Object.values.bind(Object);
    const keysSpy = vi.spyOn(Object, 'keys').mockImplementation(((value: object) => {
        if (guardedRecords.includes(value)) {
            throw new Error('selector materialized a guarded store record with Object.keys');
        }
        return originalObjectKeys(value);
    }) as typeof Object.keys);
    const valuesSpy = vi.spyOn(Object, 'values').mockImplementation(((value: object) => {
        if (guardedRecords.includes(value)) {
            throw new Error('selector materialized a guarded store record with Object.values');
        }
        return originalObjectValues(value);
    }) as typeof Object.values);

    try {
        expect(action).not.toThrow();
    } finally {
        keysSpy.mockRestore();
        valuesSpy.mockRestore();
    }
}

function createSelector() {
    return createLocalActivityBadgeSnapshotSelector({
        accountSettings: accountSettingsParse({}),
        friendRequestCount: 0,
        hasNonNumericInboxAttention: false,
        localSettings: localSettingsDefaults,
    });
}

describe('createLocalActivityBadgeSnapshotSelector', () => {
    beforeEach(() => {
        vi.useRealTimers();
        currentState = createStorageState({});
        registerStorageStateReader(() => currentState);
    });

    it('reuses the previous badge snapshot when only unrelated renderable fields change', () => {
        const selector = createSelector();
        const first = selector(createStorageState({
            sessionListRenderables: {
                session1: createRenderable({
                    id: 'session1',
                    hasUnreadMessages: true,
                    metadata: { path: '/repo', host: 'local' },
                    updatedAt: 10,
                }),
            },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
        }));

        const second = selector(createStorageState({
            sessionListRenderables: {
                session1: createRenderable({
                    id: 'session1',
                    hasUnreadMessages: true,
                    metadata: { path: '/repo', host: 'local' },
                    updatedAt: 11,
                }),
            },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
        }));

        expect(second).toBe(first);
        expect(second).toMatchObject({
            channelDisabled: false,
            sessionOptions: {
                showUnread: true,
                showPendingPermissionRequests: true,
                showPendingUserActionRequests: true,
            },
        });
        expect(second.localBadgeState).toEqual({ count: 1, showNonNumericDot: false });
    });

    it('invalidates the badge snapshot when stored message versions change for a candidate session', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2_100));
        const selector = createSelector();
        const session = createSession({
            id: 'session1',
            active: true,
            presence: 'online',
            lastViewedSessionSeq: 5,
            seq: 50,
            updatedAt: 2_000,
            pendingUserActionRequestCount: 1,
            pendingRequestObservedAt: 2_000,
            metadata: { path: '/repo', host: 'local' },
        });
        const first = selector(createStorageState({
            sessions: { session1: session },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
            sessionMessages: {
                session1: createSessionMessages({ messagesVersion: 1 }),
            },
        }));

        const second = selector(createStorageState({
            sessions: { session1: session },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
            sessionMessages: {
                session1: createSessionMessages({
                    messageIdsOldestFirst: ['message6'],
                    messagesById: {
                        message6: {
                            kind: 'tool-call',
                            id: 'message6',
                            localId: null,
                            createdAt: 2_001,
                            children: [],
                            tool: {
                                id: 'request1',
                                name: 'AskUserQuestion',
                                state: 'error',
                                input: { q: 'continue?' },
                                createdAt: 2_001,
                                startedAt: 2_001,
                                completedAt: 2_002,
                                description: null,
                                permission: {
                                    id: 'request1',
                                    status: 'canceled',
                                    kind: 'user_action',
                                },
                            },
                        },
                    },
                    messagesVersion: 2,
                }),
            },
        }));

        expect(first.localBadgeState.count).toBe(1);
        expect(second).not.toBe(first);
        expect(second.localBadgeState.count).toBe(0);
    });

    it('reuses the previous badge snapshot when unrelated stored messages change', () => {
        const selector = createSelector();
        const first = selector(createStorageState({
            sessionListRenderables: {
                session1: createRenderable({
                    id: 'session1',
                    hasUnreadMessages: true,
                    metadata: { path: '/repo', host: 'local' },
                }),
            },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
            sessionMessages: {
                unrelated: createSessionMessages({ messagesVersion: 1 }),
            },
        }));

        const second = selector(createStorageState({
            sessionListRenderables: {
                session1: createRenderable({
                    id: 'session1',
                    hasUnreadMessages: true,
                    metadata: { path: '/repo', host: 'local' },
                }),
            },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
            sessionMessages: {
                unrelated: createSessionMessages({ messagesVersion: 2 }),
            },
        }));

        expect(second).toBe(first);
    });

    it('reports local activity sources from index and concurrent cache while bootstrapping', () => {
        const selector = createSelector();

        expect(selector(createStorageState({
            isDataReady: false,
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'missing-session', serverId: 'server1', serverName: undefined }],
            },
        })).hasLocalActivitySource).toBe(true);

        expect(selector(createStorageState({
            isDataReady: false,
            concurrentSessionListCacheByServerId: {
                server2: {
                    serverName: null,
                    sessions: {
                        session2: createRenderable({ id: 'session2', hasUnreadMessages: true }),
                    },
                },
            },
        })).hasLocalActivitySource).toBe(true);
    });

    it('computes badge snapshots without Object.keys or Object.values over hot state records', () => {
        const selector = createSelector();
        const state = createStorageState({
            sessions: {
                session1: createSession({
                    id: 'session1',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    pendingRequestObservedAt: 1_000,
                    metadata: { path: '/repo', host: 'local' },
                }),
            },
            sessionListRenderables: {
                session2: createRenderable({
                    id: 'session2',
                    hasUnreadMessages: true,
                    metadata: { path: '/repo/other', host: 'local' },
                }),
            },
        });
        let snapshot: ReturnType<ReturnType<typeof createLocalActivityBadgeSnapshotSelector>> | undefined;

        expectNoObjectKeysOrValuesOnRecords(() => {
            snapshot = selector(state);
        }, [state.sessions, state.sessionListRenderables]);

        expect(snapshot?.hasLocalActivitySource).toBe(true);
    });

    it('counts transcript-only pending permissions from the selector state', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(1_000));
        const selector = createSelector();
        const permissionMessage = createPermissionMessage(1_000);
        const state = createStorageState({
            sessions: {
                session1: createSession({
                    id: 'session1',
                    active: true,
                    presence: 'online',
                    metadata: { path: '/repo', host: 'local' },
                }),
            },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
            sessionMessages: {
                session1: createSessionMessages({
                    messageIdsOldestFirst: [permissionMessage.id],
                    messagesById: {
                        [permissionMessage.id]: permissionMessage,
                    },
                    messagesVersion: 2,
                }),
            },
        });
        registerStorageStateReader(() => createStorageState({}));

        const snapshot = selector(state);

        expect(snapshot.localBadgeState.count).toBe(1);
    });

    it('reuses the previous badge snapshot when an active loaded transcript has no pending requests', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(1_000));
        const selector = createSelector();
        const state = createStorageState({
            sessions: {
                session1: createSession({
                    id: 'session1',
                    active: true,
                    activeAt: 1_000,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 1_000,
                    metadata: { path: '/repo', host: 'local' },
                    agentState: {
                        controlledByUser: null,
                        requests: {},
                        completedRequests: null,
                    },
                }),
            },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
            sessionMessages: {
                session1: createSessionMessages({ messagesVersion: 2 }),
            },
        });

        const first = selector(state);
        vi.setSystemTime(new Date(2_000));
        const second = selector(state);

        expect(first.localBadgeState.count).toBe(0);
        expect(second).toBe(first);
    });
});
