import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createStorageStoreMock } from '@/dev/testkit/mocks/storage';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } from '@/sync/domains/session/attention/runtimePresentation';
import type { Session } from '@/sync/domains/state/storageTypes';
import { createReducer } from '@/sync/reducer/reducer';
import type { SessionMessages } from '@/sync/store/domains/messages';
import type { StorageState } from '@/sync/store/types';
import { createFaviconPermissionSnapshotSelector } from './faviconPermissionSnapshot';

function createSession(overrides: Partial<Session> & Pick<Session, 'id'>): Session {
    const { id, ...rest } = overrides;
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        ...rest,
    } as Session;
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

function createTrackedMessagesById(message: Message, onRead: () => void): Record<string, Message> {
    const messagesById: Record<string, Message> = {};
    Object.defineProperty(messagesById, message.id, {
        enumerable: true,
        configurable: true,
        get: () => {
            onRead();
            return message;
        },
    });
    return messagesById;
}

function createState(overrides: Partial<StorageState>): StorageState {
    return createStorageStoreMock({
        sessions: {},
        sessionMessages: {},
        ...overrides,
    }).getState();
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
        expect(action).not.toThrow('selector materialized a guarded store record with Object.keys');
        expect(action).not.toThrow('selector materialized a guarded store record with Object.values');
    } finally {
        keysSpy.mockRestore();
        valuesSpy.mockRestore();
    }
}

describe('createFaviconPermissionSnapshotSelector', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('reuses the previous snapshot for unrelated session updates', () => {
        vi.setSystemTime(new Date(1_000));
        const selector = createFaviconPermissionSnapshotSelector();
        const first = selector(createState({
            sessions: {
                session1: createSession({ id: 'session1', updatedAt: 1 }),
            },
        }));

        const second = selector(createState({
            sessions: {
                session1: createSession({ id: 'session1', updatedAt: 2 }),
            },
        }));

        expect(second).toBe(first);
        expect(second.hasFreshPermission).toBe(false);
    });

    it('does not walk the account again when a store notification moves neither sessions nor messages', () => {
        vi.setSystemTime(new Date(1_000));
        const selector = createFaviconPermissionSnapshotSelector();
        let recordAccesses = 0;
        const countAccess = <T extends object>(record: T): T => new Proxy(record, {
            get(target, property, receiver) {
                recordAccesses += 1;
                return Reflect.get(target, property, receiver);
            },
            ownKeys(target) {
                recordAccesses += 1;
                return Reflect.ownKeys(target);
            },
        });
        // The favicon indicator is mounted at the web app root, so this selector
        // runs on every store notification for the whole account. A notification
        // that moved neither record cannot move the snapshot, so it must not read
        // a single session back.
        const sessions = countAccess({
            session1: createSession({ id: 'session1', updatedAt: 1 }),
            session2: createSession({ id: 'session2', updatedAt: 1 }),
        });
        const sessionMessages = countAccess<StorageState['sessionMessages']>({});

        const first = selector(createState({ sessions, sessionMessages }));
        recordAccesses = 0;

        const second = selector(createState({ sessions, sessionMessages, isDataReady: true }));

        expect(second).toBe(first);
        expect(recordAccesses).toBe(0);
    });

    it('derives permission snapshots without Object.keys or Object.values over store sessions', () => {
        vi.setSystemTime(new Date(1_000));
        const selector = createFaviconPermissionSnapshotSelector();
        const state = createState({
            sessions: {
                session1: createSession({
                    id: 'session1',
                    active: true,
                    activeAt: 1_000,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 1_000,
                    presence: 'online',
                    agentState: {
                        controlledByUser: null,
                        requests: {
                            request1: {
                                tool: 'Bash',
                                kind: 'permission',
                                arguments: {},
                                createdAt: 1_000,
                            },
                        },
                        completedRequests: null,
                    },
                }),
            },
        });
        let snapshot: ReturnType<ReturnType<typeof createFaviconPermissionSnapshotSelector>> | undefined;

        expectNoObjectKeysOrValuesOnRecords(() => {
            snapshot = selector(state);
        }, [state.sessions]);

        expect(snapshot?.hasFreshPermission).toBe(true);
    });

    it('invalidates when stored transcript permissions change', () => {
        vi.setSystemTime(new Date(1_000));
        const selector = createFaviconPermissionSnapshotSelector();
        const session = createSession({
            id: 'session1',
            active: true,
            activeAt: 1_000,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 1_000,
            presence: 'online',
        });
        const first = selector(createState({
            sessions: { session1: session },
        }));

        const second = selector(createState({
            sessions: { session1: session },
            sessionMessages: {
                session1: createSessionMessages({
                    messageIdsOldestFirst: ['message-permission'],
                    messagesById: {
                        'message-permission': createPermissionMessage(1_000),
                    },
                    messagesVersion: 2,
                }),
            },
        }));

        expect(first.hasFreshPermission).toBe(false);
        expect(second).not.toBe(first);
        expect(second.hasFreshPermission).toBe(true);
    });

    it('keeps an unresolved agent-state permission after transient freshness expires', () => {
        vi.setSystemTime(new Date(1_000));
        const selector = createFaviconPermissionSnapshotSelector();
        const state = createState({
            sessions: {
                session1: createSession({
                    id: 'session1',
                    active: true,
                    activeAt: 0,
                    thinking: false,
                    thinkingAt: 0,
                    latestTurnStatusObservedAt: 0,
                    presence: 'online',
                    agentState: {
                        controlledByUser: null,
                        requests: {
                            request1: {
                                tool: 'Bash',
                                kind: 'permission',
                                arguments: {},
                                createdAt: 1_000,
                            },
                        },
                        completedRequests: null,
                    },
                }),
            },
        });

        const freshSnapshot = selector(state);

        vi.setSystemTime(new Date(1_000 + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS + 1));
        const staleSnapshot = selector(state);

        expect(freshSnapshot.hasFreshPermission).toBe(true);
        expect(staleSnapshot).not.toBe(freshSnapshot);
        expect(staleSnapshot.hasFreshPermission).toBe(true);
    });

    it('keeps an unresolved transcript permission after transient freshness expires', () => {
        vi.setSystemTime(new Date(1_000));
        const selector = createFaviconPermissionSnapshotSelector();
        const state = createState({
            sessions: {
                session1: createSession({
                    id: 'session1',
                    active: true,
                    activeAt: 0,
                    thinking: false,
                    thinkingAt: 0,
                    latestTurnStatusObservedAt: 0,
                    presence: 'online',
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

        const freshSnapshot = selector(state);

        vi.setSystemTime(new Date(1_000 + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS + 1));
        const staleSnapshot = selector(state);

        expect(freshSnapshot.hasFreshPermission).toBe(true);
        expect(staleSnapshot).not.toBe(freshSnapshot);
        expect(staleSnapshot.hasFreshPermission).toBe(true);
    });

    it('reuses derived transcript permission freshness for unrelated session updates', () => {
        vi.setSystemTime(new Date(1_000));
        const selector = createFaviconPermissionSnapshotSelector();
        let transcriptMessageReads = 0;
        const permissionMessage = createPermissionMessage(1_000);
        const session1 = createSession({
            id: 'session1',
            active: true,
            activeAt: 0,
            thinking: false,
            thinkingAt: 0,
            latestTurnStatusObservedAt: 0,
            presence: 'online',
            agentState: {
                controlledByUser: null,
                requests: {},
                completedRequests: null,
            },
        });
        const sessionMessages = createSessionMessages({
            messageIdsOldestFirst: [permissionMessage.id],
            messagesById: createTrackedMessagesById(permissionMessage, () => {
                transcriptMessageReads += 1;
            }),
            messagesVersion: 2,
        });
        const firstState = createState({
            sessions: {
                session1,
                unrelated: createSession({ id: 'unrelated', updatedAt: 1 }),
            },
            sessionMessages: {
                session1: sessionMessages,
            },
        });
        const secondState = createState({
            sessions: {
                session1,
                unrelated: createSession({ id: 'unrelated', updatedAt: 2 }),
            },
            sessionMessages: {
                session1: sessionMessages,
            },
        });

        const first = selector(firstState);
        const readsAfterFirstSelection = transcriptMessageReads;
        const second = selector(secondState);

        expect(first.hasFreshPermission).toBe(true);
        expect(second).toBe(first);
        expect(transcriptMessageReads).toBe(readsAfterFirstSelection);
    });

    it('invalidates permission freshness when same-id request coverage changes through arguments only', () => {
        vi.setSystemTime(new Date(10_000));
        const selector = createFaviconPermissionSnapshotSelector();
        const coveredSession = createSession({
            id: 'session1',
            active: true,
            activeAt: 0,
            thinking: false,
            thinkingAt: 0,
            latestTurnStatusObservedAt: 0,
            presence: 'online',
            agentState: {
                controlledByUser: null,
                requests: {
                    approve: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: { command: 'git status' },
                        createdAt: 9_000,
                    },
                },
                completedRequests: {
                    approve: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: { command: 'git status' },
                        completedAt: 9_100,
                        status: 'approved',
                    },
                },
            },
        });
        const uncoveredSession = createSession({
            ...coveredSession,
            agentState: {
                controlledByUser: null,
                requests: {
                    approve: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: { command: 'git diff' },
                        createdAt: 9_000,
                    },
                },
                completedRequests: coveredSession.agentState?.completedRequests,
            },
        });

        const first = selector(createState({
            sessions: { session1: coveredSession },
        }));
        const second = selector(createState({
            sessions: { session1: uncoveredSession },
        }));

        expect(first.hasFreshPermission).toBe(false);
        expect(second).not.toBe(first);
        expect(second.hasFreshPermission).toBe(true);
    });
});
