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

    it('invalidates the badge snapshot when renderable blocked pending delivery changes', () => {
        const selector = createSelector();
        const first = selector(createStorageState({
            sessionListRenderables: {
                session1: createRenderable({
                    id: 'session1',
                    pendingCount: 4,
                    pendingBlockedCount: 0,
                    metadata: { path: '/repo', host: 'local' },
                    updatedAt: 10,
                } as Partial<SessionListRenderableSession> & Pick<SessionListRenderableSession, 'id'>),
            },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
        }));

        const second = selector(createStorageState({
            sessionListRenderables: {
                session1: createRenderable({
                    id: 'session1',
                    pendingCount: 4,
                    pendingBlockedCount: 1,
                    metadata: { path: '/repo', host: 'local' },
                    updatedAt: 10,
                } as Partial<SessionListRenderableSession> & Pick<SessionListRenderableSession, 'id'>),
            },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
        }));

        expect(first.localBadgeState).toEqual({ count: 0, showNonNumericDot: false });
        expect(second).not.toBe(first);
        expect(second.localBadgeState).toEqual({ count: 1, showNonNumericDot: false });
    });

    it('invalidates the badge snapshot when optimistic thinking starts without another session field changing', () => {
        const selector = createSelector();
        const firstSession = createSession({
            id: 'optimistic-thinking',
            optimisticThinkingAt: null,
        });
        const secondSession = {
            ...firstSession,
            optimisticThinkingAt: Date.now(),
        };
        const first = selector(createStorageState({
            sessions: {
                [firstSession.id]: firstSession,
            },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: firstSession.id, serverId: 'server1', serverName: undefined }],
            },
        }));

        const second = selector(createStorageState({
            sessions: {
                [secondSession.id]: secondSession,
            },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: secondSession.id, serverId: 'server1', serverName: undefined }],
            },
        }));

        expect(second).not.toBe(first);
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

    it('does no per-session renderable derivation on an empty session-list delta tick', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(10_000));
        const selector = createSelector();
        let thinkingAtReads = 0;
        const renderable = createRenderable({
            id: 'session1',
            hasUnreadMessages: true,
            metadata: { path: '/repo', host: 'local' },
        });
        Object.defineProperty(renderable, 'thinkingAt', {
            configurable: true,
            enumerable: true,
            get: () => {
                thinkingAtReads += 1;
                return 0;
            },
        });
        const sessionListRenderables = { session1: renderable };
        const first = selector(createStorageState({
            sessionListRenderableDelta: {
                revision: 1,
                changedSessionIds: ['session1'],
                removedSessionIds: [],
                rebuiltSessionListIndex: true,
            },
            sessionListRenderables,
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
        }));
        const readsAfterFirstSelection = thinkingAtReads;

        const second = selector(createStorageState({
            sessionListRenderableDelta: {
                revision: 2,
                changedSessionIds: [],
                removedSessionIds: [],
                rebuiltSessionListIndex: false,
            },
            sessionListRenderables,
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
        }));

        expect(second).toBe(first);
        expect(thinkingAtReads).toBe(readsAfterFirstSelection);
    });

    it('does no derivation at all on a store commit that moved none of its sources', () => {
        // The commit storm: many store notifications carrying no badge-relevant movement (the
        // delta revision does not even advance). The previous shape rebuilt the whole signature -
        // an O(sessions) pass over every hot record - on each one, only to conclude nothing changed.
        vi.useFakeTimers();
        vi.setSystemTime(new Date(10_000));
        const selector = createSelector();
        let thinkingAtReads = 0;
        const renderable = createRenderable({
            id: 'session1',
            hasUnreadMessages: true,
            metadata: { path: '/repo', host: 'local' },
        });
        Object.defineProperty(renderable, 'thinkingAt', {
            configurable: true,
            enumerable: true,
            get: () => {
                thinkingAtReads += 1;
                return 0;
            },
        });
        const sessions = {};
        const sessionMessages = {};
        const sessionListRenderables = { session1: renderable };
        const sessionListIndexByServerId = {
            server1: [{ type: 'session' as const, sessionId: 'session1', serverId: 'server1', serverName: undefined }],
        };
        const concurrentSessionListCacheByServerId = {};
        const sessionListRenderableDelta = {
            revision: 7,
            changedSessionIds: ['session1'],
            removedSessionIds: [],
            rebuiltSessionListIndex: true,
        };
        const sourceSlices = {
            concurrentSessionListCacheByServerId,
            sessionListIndexByServerId,
            sessionListRenderableDelta,
            sessionListRenderables,
            sessionMessages,
            sessions,
        };

        const first = selector(createStorageState(sourceSlices));
        const readsAfterFirstSelection = thinkingAtReads;

        // A later commit: same slice identities, same delta revision, later wall clock.
        vi.setSystemTime(new Date(10_050));
        const second = selector(createStorageState(sourceSlices));

        expect(second).toBe(first);
        expect(thinkingAtReads).toBe(readsAfterFirstSelection);
    });

    it('still re-derives when a source this selector reads moves, including the list index', () => {
        // The guard against porting a narrower source set than this repository's derivation reads:
        // the badge here also consumes `sessionListIndexByServerId` and
        // `concurrentSessionListCacheByServerId`, so movement in either must invalidate.
        vi.useFakeTimers();
        vi.setSystemTime(new Date(10_000));
        const selector = createSelector();
        const sessions = {};
        const sessionMessages = {};
        const sessionListRenderables = {
            session1: createRenderable({
                id: 'session1',
                hasUnreadMessages: true,
                metadata: { path: '/repo', host: 'local' },
            }),
        };
        const sessionListRenderableDelta = {
            revision: 7,
            changedSessionIds: ['session1'],
            removedSessionIds: [],
            rebuiltSessionListIndex: true,
        };

        const first = selector(createStorageState({
            concurrentSessionListCacheByServerId: {},
            sessionListIndexByServerId: {},
            sessionListRenderableDelta,
            sessionListRenderables,
            sessionMessages,
            sessions,
        }));
        expect(first.localBadgeState).toEqual({ count: 0, showNonNumericDot: false });

        const second = selector(createStorageState({
            concurrentSessionListCacheByServerId: {},
            // Only this slice moved: the session becomes reachable through the list index.
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
            sessionListRenderableDelta,
            sessionListRenderables,
            sessionMessages,
            sessions,
        }));

        expect(second).not.toBe(first);
        expect(second.localBadgeState).toEqual({ count: 1, showNonNumericDot: false });
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

    it('counts same-id pending agent requests when the completed request arguments differ', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(12_600));
        const selector = createSelector();
        const snapshot = selector(createStorageState({
            sessions: {
                session1: createSession({
                    id: 'session1',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    pendingRequestObservedAt: null,
                    metadata: { path: '/repo', host: 'local' },
                    agentState: {
                        controlledByUser: null,
                        requests: {
                            permission_retry: {
                                tool: 'Bash',
                                kind: 'permission',
                                arguments: { command: 'git status' },
                                createdAt: 12_345,
                            },
                        },
                        completedRequests: {
                            permission_retry: {
                                tool: 'Bash',
                                kind: 'permission',
                                arguments: { command: 'git diff' },
                                completedAt: 12_500,
                                status: 'approved',
                            },
                        },
                    },
                }),
            },
            sessionListIndexByServerId: {
                server1: [{ type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined }],
            },
        }));

        expect(snapshot.localBadgeState.count).toBe(1);
    });

    it('still probes transcript freshness when raw agent requests are terminal-covered', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(1_000));
        const selector = createSelector();
        const permissionMessage = createPermissionMessage(1_000);
        const snapshot = selector(createStorageState({
            sessions: {
                session1: createSession({
                    id: 'session1',
                    active: true,
                    activeAt: 0,
                    presence: 'online',
                    latestTurnStatusObservedAt: 0,
                    metadata: { path: '/repo', host: 'local' },
                    agentState: {
                        controlledByUser: null,
                        requests: {
                            covered_request: {
                                tool: 'Bash',
                                kind: 'permission',
                                arguments: { command: 'git status' },
                                createdAt: 900,
                            },
                        },
                        completedRequests: {
                            covered_request: {
                                tool: 'Bash',
                                kind: 'permission',
                                arguments: { command: 'git status' },
                                completedAt: 950,
                                status: 'approved',
                            },
                        },
                    },
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
        }));

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
