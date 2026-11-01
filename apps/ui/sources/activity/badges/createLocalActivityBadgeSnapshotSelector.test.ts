import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveActivityAttentionFlags } from '@/activity/attention/activityAttentionSessions';
import { createStorageStoreMock } from '@/dev/testkit/mocks/storage';
import { registerStorageStateReader } from '@/sync/domains/state/storageStateReaderBridge';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import { createReducer } from '@/sync/reducer/reducer';
import type { SessionMessages } from '@/sync/store/domains/messages';
import type { StorageState } from '@/sync/store/types';
import {
    createLocalActivityBadgeSnapshotSelector,
    type LocalActivityBadgeSnapshot,
} from './createLocalActivityBadgeSnapshotSelector';

let currentState: StorageState;

function createStorageState(overrides: Partial<StorageState>): StorageState {
    currentState = createStorageStoreMock({
        sessions: {},
        sessionListRenderables: {},
        sessionMessages: {},
        sessionListRenderableDelta: {
            revision: 0,
            changedSessionIds: [],
            removedSessionIds: [],
            rebuiltSessionListViewData: false,
        },
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

function expectNoObjectValuesOnRecords(action: () => void, guardedRecords: readonly object[]): void {
    const originalObjectValues = Object.values.bind(Object);
    const valuesSpy = vi.spyOn(Object, 'values').mockImplementation(((value: object) => {
        if (guardedRecords.includes(value)) {
            throw new Error('selector materialized a guarded store record with Object.values');
        }
        return originalObjectValues(value);
    }) as typeof Object.values);

    try {
        expect(action).not.toThrow();
    } finally {
        valuesSpy.mockRestore();
    }
}

function expectNoObjectKeysOnRecords(action: () => void, guardedRecords: readonly object[]): void {
    const originalObjectKeys = Object.keys.bind(Object);
    const keysSpy = vi.spyOn(Object, 'keys').mockImplementation(((value: object) => {
        if (guardedRecords.includes(value)) {
            throw new Error('selector materialized guarded store record keys with Object.keys');
        }
        return originalObjectKeys(value);
    }) as typeof Object.keys);

    try {
        expect(action).not.toThrow();
    } finally {
        keysSpy.mockRestore();
    }
}

describe('createLocalActivityBadgeSnapshotSelector', () => {
    beforeEach(() => {
        vi.useRealTimers();
        currentState = createStorageState({});
        registerStorageStateReader(() => currentState);
    });

    it('reuses the previous badge snapshot when only unrelated renderable fields change', () => {
        const selector = createLocalActivityBadgeSnapshotSelector({
            badgesEnabled: true,
            friendRequestCount: 0,
            hasNonNumericInboxAttention: false,
            sessionOptions: {
                showPendingPermissionRequests: true,
                showPendingUserActionRequests: true,
                showQueuedUserInput: true,
                showUnread: true,
            },
        });
        const first = selector(createStorageState({
            sessionListRenderables: {
                session1: createRenderable({
                    id: 'session1',
                    hasUnreadMessages: true,
                    updatedAt: 10,
                }),
            },
        }));

        const second = selector(createStorageState({
            sessionListRenderables: {
                session1: createRenderable({
                    id: 'session1',
                    hasUnreadMessages: true,
                    updatedAt: 11,
                }),
            },
        }));

        expect(second).toBe(first);
        expect(second).toEqual({
            count: 1,
            hasLocalBadgeSource: true,
            isDataReady: true,
            showNonNumericDot: false,
        });
    });

    it('invalidates the badge snapshot when a renderable unread flag changes', () => {
        const selector = createLocalActivityBadgeSnapshotSelector({
            badgesEnabled: true,
            friendRequestCount: 0,
            hasNonNumericInboxAttention: false,
            sessionOptions: {
                showPendingPermissionRequests: true,
                showPendingUserActionRequests: true,
                showQueuedUserInput: true,
                showUnread: true,
            },
        });
        const first = selector(createStorageState({
            sessionListRenderables: {
                session1: createRenderable({
                    id: 'session1',
                    hasUnreadMessages: true,
                }),
            },
        }));

        const second = selector(createStorageState({
            sessionListRenderables: {
                session1: createRenderable({
                    id: 'session1',
                    hasUnreadMessages: false,
                }),
            },
        }));

        expect(second).not.toBe(first);
        expect(second.count).toBe(0);
    });

    it('uses the session-list delta to avoid sorting or re-reading unchanged sessions', () => {
        const selector = createLocalActivityBadgeSnapshotSelector({
            badgesEnabled: true,
            friendRequestCount: 0,
            hasNonNumericInboxAttention: false,
            sessionOptions: {
                showPendingPermissionRequests: true,
                showPendingUserActionRequests: true,
                showQueuedUserInput: true,
                showUnread: true,
            },
        });
        let unchangedSeqReads = 0;
        const unchanged = createRenderable({
            id: 'unchanged',
            hasUnreadMessages: true,
        });
        Object.defineProperty(unchanged, 'seq', {
            configurable: true,
            enumerable: true,
            get: () => {
                unchangedSeqReads += 1;
                return 1;
            },
        });
        const changed = createRenderable({
            id: 'changed',
            hasUnreadMessages: false,
        });
        const first = selector(createStorageState({
            sessionListRenderables: { unchanged, changed },
            sessionListRenderableDelta: {
                revision: 1,
                changedSessionIds: ['unchanged', 'changed'],
                removedSessionIds: [],
                rebuiltSessionListViewData: true,
            },
        }));
        const unchangedSeqReadsAfterFirstSelection = unchangedSeqReads;
        const sortSpy = vi.spyOn(Array.prototype, 'sort');

        const second = selector(createStorageState({
            sessionListRenderables: {
                unchanged,
                changed: createRenderable({
                    id: 'changed',
                    hasUnreadMessages: true,
                }),
            },
            sessionListRenderableDelta: {
                revision: 2,
                changedSessionIds: ['changed'],
                removedSessionIds: [],
                rebuiltSessionListViewData: false,
            },
        }));

        expect(second).not.toBe(first);
        expect(second.count).toBe(2);
        expect(unchangedSeqReads).toBe(unchangedSeqReadsAfterFirstSelection);
        expect(sortSpy).not.toHaveBeenCalled();
    });

    it('does no per-session derivation work on a delta tick that changes no session', () => {
        const selector = createLocalActivityBadgeSnapshotSelector({
            badgesEnabled: true,
            friendRequestCount: 0,
            hasNonNumericInboxAttention: false,
            sessionOptions: {
                showPendingPermissionRequests: true,
                showPendingUserActionRequests: true,
                showQueuedUserInput: true,
                showUnread: true,
            },
        });
        let sessionFieldReads = 0;
        const renderable = createRenderable({
            id: 'session1',
            hasUnreadMessages: true,
        });
        Object.defineProperty(renderable, 'seq', {
            configurable: true,
            enumerable: true,
            get: () => {
                sessionFieldReads += 1;
                return 1;
            },
        });
        const first = selector(createStorageState({
            sessionListRenderables: { session1: renderable },
            sessionListRenderableDelta: {
                revision: 1,
                changedSessionIds: ['session1'],
                removedSessionIds: [],
                rebuiltSessionListViewData: true,
            },
        }));
        const readsAfterFirst = sessionFieldReads;

        // A subsequent wave that touched no session (empty changed/removed) with
        // the same renderable identity must take the delta fast path and perform
        // zero per-session derivation while returning the memoized snapshot.
        const second = selector(createStorageState({
            sessionListRenderables: { session1: renderable },
            sessionListRenderableDelta: {
                revision: 2,
                changedSessionIds: [],
                removedSessionIds: [],
                rebuiltSessionListViewData: false,
            },
        }));

        expect(second).toEqual(first);
        expect(second.count).toBe(1);
        // The observable performance contract: the empty delta re-derived no
        // session, so the guarded per-session field was never read again.
        expect(sessionFieldReads).toBe(readsAfterFirst);
    });

    it('returns the same snapshot instance when a delta tick leaves the badge unchanged', () => {
        const selector = createLocalActivityBadgeSnapshotSelector({
            badgesEnabled: true,
            friendRequestCount: 0,
            hasNonNumericInboxAttention: false,
            sessionOptions: {
                showPendingPermissionRequests: true,
                showPendingUserActionRequests: true,
                showQueuedUserInput: true,
                showUnread: true,
            },
        });
        const renderable = createRenderable({ id: 'session1', hasUnreadMessages: true });
        const first = selector(createStorageState({
            sessionListRenderables: { session1: renderable },
            sessionListRenderableDelta: {
                revision: 1,
                changedSessionIds: ['session1'],
                removedSessionIds: [],
                rebuiltSessionListViewData: true,
            },
        }));

        const second = selector(createStorageState({
            sessionListRenderables: { session1: renderable },
            sessionListRenderableDelta: {
                revision: 2,
                changedSessionIds: ['session1'],
                removedSessionIds: [],
                rebuiltSessionListViewData: false,
            },
        }));

        expect(second.count).toBe(1);
        // Identity, not equality: this selector is the badge's React subscription,
        // so an equal-but-new object is a wasted render for every delta tick.
        expect(second).toBe(first);
    });

    it('costs nothing when a store notification moves none of the badge inputs', () => {
        const selector = createLocalActivityBadgeSnapshotSelector({
            badgesEnabled: true,
            friendRequestCount: 0,
            hasNonNumericInboxAttention: false,
            sessionOptions: {
                showPendingPermissionRequests: true,
                showPendingUserActionRequests: true,
                showQueuedUserInput: true,
                showUnread: true,
            },
        });
        let renderableFieldReads = 0;
        const renderable = createRenderable({ id: 'session1', hasUnreadMessages: true });
        Object.defineProperty(renderable, 'seq', {
            configurable: true,
            enumerable: true,
            get: () => {
                renderableFieldReads += 1;
                return 1;
            },
        });
        const sessions = { session1: createSession({ id: 'session1' }) };
        const sessionMessages = {};
        const sessionListRenderables = { session1: renderable };
        const sessionListRenderableDelta = {
            revision: 1,
            changedSessionIds: ['session1'],
            removedSessionIds: [],
            rebuiltSessionListViewData: true,
        };
        const first = selector(createStorageState({
            sessions,
            sessionMessages,
            sessionListRenderables,
            sessionListRenderableDelta,
        }));
        const readsAfterFirst = renderableFieldReads;

        const second = selector(createStorageState({
            sessions,
            sessionMessages,
            sessionListRenderables,
            sessionListRenderableDelta,
        }));

        expect(second).toBe(first);
        expect(renderableFieldReads).toBe(readsAfterFirst);
    });

    it('computes badge snapshots without Object.values over store session records', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_500);
        const selector = createLocalActivityBadgeSnapshotSelector({
            badgesEnabled: true,
            friendRequestCount: 0,
            hasNonNumericInboxAttention: false,
            sessionOptions: {
                showPendingPermissionRequests: true,
                showPendingUserActionRequests: true,
                showQueuedUserInput: true,
                showUnread: true,
            },
        });
        const state = createStorageState({
            sessions: {
                session1: createSession({
                    id: 'session1',
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 1_000,
                    pendingPermissionRequestCount: 1,
                    pendingRequestObservedAt: 1_000,
                }),
            },
            sessionListRenderables: {
                session2: createRenderable({
                    id: 'session2',
                    hasUnreadMessages: true,
                }),
            },
        });
        let snapshot: LocalActivityBadgeSnapshot | undefined;

        expectNoObjectValuesOnRecords(() => {
            expectNoObjectKeysOnRecords(() => {
                snapshot = selector(state);
            }, [state.sessions, state.sessionListRenderables]);
        }, [state.sessions, state.sessionListRenderables]);

        expect(snapshot).toEqual({
            count: 2,
            hasLocalBadgeSource: true,
            isDataReady: true,
            showNonNumericDot: false,
        });
    });

    it('leaves the badge subscription untouched when only a projected session update time changes', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const selector = createLocalActivityBadgeSnapshotSelector({
            badgesEnabled: true,
            friendRequestCount: 0,
            hasNonNumericInboxAttention: false,
            sessionOptions: {
                showPendingPermissionRequests: true,
                showPendingUserActionRequests: true,
                showQueuedUserInput: true,
                showUnread: true,
            },
        });
        const first = selector(createStorageState({
            sessions: {
                session1: createSession({
                    id: 'session1',
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 999_000,
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: 999_000,
                    updatedAt: 10,
                }),
            },
        }));

        const second = selector(createStorageState({
            sessions: {
                session1: createSession({
                    id: 'session1',
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 999_000,
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: 999_000,
                    updatedAt: 11,
                }),
            },
        }));

        expect(first.count).toBe(1);
        expect(second.count).toBe(1);
        // `updatedAt` is part of the session activity signature, so the snapshot is
        // re-derived — but the derived badge did not move, and this selector is the
        // badge's React subscription, so it must not hand back a new instance.
        expect(second).toBe(first);
    });

    it('invalidates the badge when queued input changes without a renderable delta', () => {
        const params = {
            badgesEnabled: true,
            friendRequestCount: 0,
            hasNonNumericInboxAttention: false,
            sessionOptions: {
                showPendingPermissionRequests: false,
                showPendingUserActionRequests: false,
                showQueuedUserInput: true,
                showUnread: false,
            },
        };
        const selector = createLocalActivityBadgeSnapshotSelector(params);
        const first = selector(createStorageState({
            sessions: {
                session1: createSession({ id: 'session1', pendingCount: 0 }),
            },
        }));
        const second = selector(createStorageState({
            sessions: {
                session1: createSession({ id: 'session1', pendingCount: 1 }),
            },
        }));

        expect(first.count).toBe(0);
        expect(second.count).toBe(1);

        const renderableSelector = createLocalActivityBadgeSnapshotSelector(params);
        const firstRenderable = renderableSelector(createStorageState({
            sessionListRenderables: {
                session1: createRenderable({ id: 'session1', pendingCount: 0 }),
            },
        }));
        const secondRenderable = renderableSelector(createStorageState({
            sessionListRenderables: {
                session1: createRenderable({ id: 'session1', pendingCount: 1 }),
            },
        }));

        expect(firstRenderable.count).toBe(0);
        expect(secondRenderable.count).toBe(1);
    });

    it('counts transcript-only pending permissions from the selector state', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const selector = createLocalActivityBadgeSnapshotSelector({
            badgesEnabled: true,
            friendRequestCount: 0,
            hasNonNumericInboxAttention: false,
            sessionOptions: {
                showPendingPermissionRequests: true,
                showPendingUserActionRequests: true,
                showQueuedUserInput: true,
                showUnread: true,
            },
        });
        const state = createStorageState({
            sessions: {
                session1: createSession({
                    id: 'session1',
                    active: true,
                    activeAt: 1_000,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 1_000,
                    agentState: {
                        controlledByUser: null,
                        requests: {},
                        completedRequests: null,
                    },
                }),
            },
            sessionMessages: {
                session1: createSessionMessages({
                    messageIdsOldestFirst: ['message-permission'],
                    messagesById: {
                        'message-permission': createPermissionMessage(1_000),
                    },
                    messagesVersion: 2,
                }),
            },
        });
        registerStorageStateReader(() => createStorageState({}));

        expect(selector(state).count).toBe(1);
    });

    it('reuses the previous badge snapshot when an active loaded transcript has no pending requests', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const selector = createLocalActivityBadgeSnapshotSelector({
            badgesEnabled: true,
            friendRequestCount: 0,
            hasNonNumericInboxAttention: false,
            sessionOptions: {
                showPendingPermissionRequests: true,
                showPendingUserActionRequests: true,
                showQueuedUserInput: true,
                showUnread: true,
            },
        });
        const state = createStorageState({
            sessions: {
                session1: createSession({
                    id: 'session1',
                    active: true,
                    activeAt: 1_000,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 1_000,
                    agentState: {
                        controlledByUser: null,
                        requests: {},
                        completedRequests: null,
                    },
                }),
            },
            sessionMessages: {
                session1: createSessionMessages({
                    messagesVersion: 2,
                }),
            },
        });

        const first = selector(state);
        vi.setSystemTime(2_000);
        const second = selector(state);

        expect(first.count).toBe(0);
        expect(second).toBe(first);
    });

    it('invalidates the badge snapshot when stored message versions change', () => {
        const selector = createLocalActivityBadgeSnapshotSelector({
            badgesEnabled: true,
            friendRequestCount: 0,
            hasNonNumericInboxAttention: false,
            sessionOptions: {
                showPendingPermissionRequests: true,
                showPendingUserActionRequests: true,
                showQueuedUserInput: true,
                showUnread: true,
            },
        });
        const session = createSession({
            id: 'session1',
            active: true,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 1_000,
            lastViewedSessionSeq: 5,
            seq: 50,
        });
        const first = selector(createStorageState({
            sessions: { session1: session },
            sessionMessages: {
                session1: createSessionMessages({
                    messagesVersion: 1,
                }),
            },
        }));

        const second = selector(createStorageState({
            sessions: { session1: session },
            sessionMessages: {
                session1: createSessionMessages({
                    messageIdsOldestFirst: ['message6'],
                    messagesById: {
                        message6: {
                            id: 'message6',
                            kind: 'agent-text',
                            localId: null,
                            seq: 6,
                            createdAt: 2_000,
                            text: 'ready',
                        },
                    },
                    latestReadyEventSeq: 6,
                    latestReadyEventAt: 2_000,
                    messagesVersion: 2,
                }),
            },
        }));

        expect(first.count).toBe(0);
        expect(second).not.toBe(first);
        expect(second.count).toBe(1);
    });

    it('reuses the previous badge snapshot when unrelated stored messages change', () => {
        const selector = createLocalActivityBadgeSnapshotSelector({
            badgesEnabled: true,
            friendRequestCount: 0,
            hasNonNumericInboxAttention: false,
            sessionOptions: {
                showPendingPermissionRequests: true,
                showPendingUserActionRequests: true,
                showQueuedUserInput: true,
                showUnread: true,
            },
        });
        const first = selector(createStorageState({
            sessionListRenderables: {
                session1: createRenderable({
                    id: 'session1',
                    hasUnreadMessages: true,
                }),
            },
            sessionMessages: {
                unrelated: createSessionMessages({
                    messagesVersion: 1,
                }),
            },
        }));

        const second = selector(createStorageState({
            sessionListRenderables: {
                session1: createRenderable({
                    id: 'session1',
                    hasUnreadMessages: true,
                }),
            },
            sessionMessages: {
                unrelated: createSessionMessages({
                    messagesVersion: 2,
                }),
            },
        }));

        expect(second).toBe(first);
    });

    it('keeps live pending attention in the badge past the runtime staleness window until the runtime goes offline', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const selector = createLocalActivityBadgeSnapshotSelector({
            badgesEnabled: true,
            friendRequestCount: 0,
            hasNonNumericInboxAttention: false,
            sessionOptions: {
                showPendingPermissionRequests: true,
                showPendingUserActionRequests: true,
                showQueuedUserInput: true,
                showUnread: true,
            },
        });
        const renderable = createRenderable({
            id: 'session1',
            active: true,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 881_000,
            hasPendingUserActionRequests: true,
            pendingRequestObservedAt: 881_000,
        });
        const first = selector(createStorageState({
            sessionListRenderables: { session1: renderable },
        }));

        vi.setSystemTime(1_003_000);
        const second = selector(createStorageState({
            sessionListRenderables: { session1: renderable },
        }));
        const offline = selector(createStorageState({
            sessionListRenderables: { session1: { ...renderable, presence: 1_002_000 } },
        }));

        expect(first.count).toBe(1);
        expect(second.count).toBe(1);
        expect(offline.count).toBe(0);
    });

    it('counts a session once even when several attention reasons are active at the same time', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const selector = createLocalActivityBadgeSnapshotSelector({
            badgesEnabled: true,
            friendRequestCount: 2,
            hasNonNumericInboxAttention: false,
            sessionOptions: {
                showPendingPermissionRequests: true,
                showPendingUserActionRequests: true,
                showQueuedUserInput: true,
                showUnread: true,
            },
        });
        const renderable = createRenderable({
            id: 'session1',
            active: true,
            activeAt: 1_000_000,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 1_000_000,
            hasUnreadMessages: true,
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: true,
            pendingRequestObservedAt: 1_000_000,
            pendingBlockedCount: 1,
        });

        // Guard the fixture: "counts once" is vacuous unless several distinct
        // attention reasons really are live on this single session.
        expect(deriveActivityAttentionFlags(renderable, {
            showPendingPermissionRequests: true,
            showPendingUserActionRequests: true,
            showQueuedUserInput: true,
            showUnread: true,
            sessionMessagesById: {},
            nowMs: 1_000_000,
        })).toMatchObject({
            hasUnread: true,
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: true,
            hasBlockedPendingDelivery: true,
        });

        const snapshot = selector(createStorageState({
            sessionListRenderables: { session1: renderable },
        }));

        // One session contributes exactly 1, never one per reason; the other 2
        // are the friend requests.
        expect(snapshot.count).toBe(3);
    });
});
