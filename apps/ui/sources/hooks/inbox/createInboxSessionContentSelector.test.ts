import { afterEach, describe, expect, it, vi } from 'vitest';

import { createStorageStoreMock } from '@/dev/testkit/mocks/storage';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } from '@/sync/domains/session/attention/runtimePresentation';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { registerStorageStateReader } from '@/sync/domains/state/storageStateReaderBridge';
import type { SessionListAttentionRow } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { createReducer } from '@/sync/reducer/reducer';
import type { SessionMessages } from '@/sync/store/domains/messages';
import type { StorageState } from '@/sync/store/types';

import { createInboxSessionContentSelector } from './createInboxSessionContentSelector';
import type { InboxSessionState } from './buildInboxSessionState';

function createQuietSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        archivedAt: null,
        pendingVersion: 0,
        pendingCount: 0,
        lastViewedSessionSeq: 1,
        metadataVersion: 0,
        agentStateVersion: 0,
        metadata: null,
        agentState: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    } as Session;
}

function createAttentionRow(
    serverId: string,
    overrides: Partial<SessionListRenderableSession> = {},
): SessionListAttentionRow {
    return {
        serverId,
        serverName: `${serverId} name`,
        session: {
            id: 'session-1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            archivedAt: null,
            pendingVersion: 0,
            pendingCount: 0,
            lastViewedSessionSeq: 1,
            metadataVersion: 0,
            agentStateVersion: 0,
            metadata: null,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            hasUnreadMessages: false,
            ...overrides,
        },
    };
}

function emptyInboxState(): InboxSessionState {
    return {
        unreadSessions: [],
        sessionsNeedingAttention: [],
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

function createQuietMessage(createdAt: number): Message {
    return {
        kind: 'user-text',
        id: 'message-permission',
        localId: null,
        createdAt,
        text: 'done',
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

function createMessagesById(message: Message): Record<string, Message> {
    return {
        [message.id]: message,
    };
}

function createSessionMessages(overrides: Partial<SessionMessages>): SessionMessages {
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

function createStorageState(overrides: Partial<StorageState>): StorageState {
    return createStorageStoreMock({
        sessions: {},
        sessionMessages: {},
        ...overrides,
    }).getState();
}

describe('createInboxSessionContentSelector', () => {
    afterEach(() => {
        registerStorageStateReader(() => createStorageState({ sessionMessages: {} }));
    });

    it('reuses the previous result without rebuilding on unrelated session heartbeat updates', () => {
        const buildInboxState = vi.fn(emptyInboxState);
        const selectInboxSessionContent = createInboxSessionContentSelector(buildInboxState);

        expect(selectInboxSessionContent({
            sessions: [createQuietSession({ updatedAt: 1 })],
            sessionRows: [],
            nowMs: 10_000,
        })).toBe(false);
        expect(selectInboxSessionContent({
            sessions: [createQuietSession({ updatedAt: 2 })],
            sessionRows: [],
            nowMs: 10_000,
        })).toBe(false);

        expect(buildInboxState).toHaveBeenCalledTimes(1);
    });

    it('reuses the previous result without rebuilding on unrelated attention-row projection updates', () => {
        const buildInboxState = vi.fn(emptyInboxState);
        const selectInboxSessionContent = createInboxSessionContentSelector(buildInboxState);

        expect(selectInboxSessionContent({
            sessions: [],
            sessionRows: [createAttentionRow('server-a', { updatedAt: 1 })],
            nowMs: 10_000,
        })).toBe(false);
        expect(selectInboxSessionContent({
            sessions: [],
            sessionRows: [createAttentionRow('server-a', { updatedAt: 2 })],
            nowMs: 10_000,
        })).toBe(false);

        expect(buildInboxState).toHaveBeenCalledTimes(1);
    });

    it('reuses the previous result without reading sessions on an empty session-list delta tick', () => {
        const buildInboxState = vi.fn(emptyInboxState);
        const selectInboxSessionContent = createInboxSessionContentSelector(buildInboxState);
        let statusReads = 0;
        const session = createQuietSession({ id: 'session-1' });
        Object.defineProperty(session, 'latestTurnStatus', {
            configurable: true,
            enumerable: true,
            get: () => {
                statusReads += 1;
                return null;
            },
        });

        registerStorageStateReader(() => createStorageState({
            sessionListRenderableDelta: {
                revision: 1,
                changedSessionIds: ['session-1'],
                removedSessionIds: [],
                rebuiltSessionListIndex: true,
            },
        }));
        expect(selectInboxSessionContent({
            sessions: [session],
            sessionRows: [],
            nowMs: 10_000,
        })).toBe(false);
        const readsAfterFirstSelection = statusReads;

        registerStorageStateReader(() => createStorageState({
            sessionListRenderableDelta: {
                revision: 2,
                changedSessionIds: [],
                removedSessionIds: [],
                rebuiltSessionListIndex: false,
            },
        }));
        expect(selectInboxSessionContent({
            sessions: [session],
            sessionRows: [],
            nowMs: 10_000,
        })).toBe(false);

        expect(buildInboxState).toHaveBeenCalledTimes(1);
        expect(statusReads).toBe(readsAfterFirstSelection);
    });

    it('reuses derived transcript pending state for unrelated session heartbeat updates', () => {
        const buildInboxState = vi.fn((): InboxSessionState => ({
            unreadSessions: [],
            sessionsNeedingAttention: [{
                session: createQuietSession({ id: 'session-1' }),
                pendingPermissions: [],
                pendingUserActions: [],
            }],
        }));
        const selectInboxSessionContent = createInboxSessionContentSelector(buildInboxState);
        let transcriptMessageReads = 0;
        const permissionMessage = createPermissionMessage(1_000);
        const sessionMessages = createSessionMessages({
            messageIdsOldestFirst: [permissionMessage.id],
            messagesById: createTrackedMessagesById(permissionMessage, () => {
                transcriptMessageReads += 1;
            }),
            messagesVersion: 2,
        });
        registerStorageStateReader(() => createStorageState({
            sessionMessages: {
                'session-1': sessionMessages,
            },
        }));

        const first = selectInboxSessionContent({
            sessions: [createQuietSession({
                id: 'session-1',
                updatedAt: 1,
                lastViewedSessionSeq: 1,
            })],
            sessionRows: [],
            nowMs: 1_000,
        });
        const readsAfterFirstSelection = transcriptMessageReads;
        const second = selectInboxSessionContent({
            sessions: [createQuietSession({
                id: 'session-1',
                updatedAt: 2,
                lastViewedSessionSeq: 1,
            })],
            sessionRows: [],
            nowMs: 1_000,
        });

        expect(first).toBe(true);
        expect(second).toBe(true);
        expect(buildInboxState).toHaveBeenCalledTimes(1);
        expect(transcriptMessageReads).toBe(readsAfterFirstSelection);
    });

    it('invalidates transcript pending state when storage scope resets with the same message signature', () => {
        const selectInboxSessionContent = createInboxSessionContentSelector();
        const permissionMessage = createPermissionMessage(1_000);
        const sessionMessagesWithPermission = createSessionMessages({
            messageIdsOldestFirst: [permissionMessage.id],
            messagesById: createMessagesById(permissionMessage),
            messagesVersion: 2,
        });
        const quietMessage = createQuietMessage(1_000);
        const sessionMessagesWithoutPermission = createSessionMessages({
            messageIdsOldestFirst: [quietMessage.id],
            messagesById: createMessagesById(quietMessage),
            messagesVersion: 2,
        });
        const activeSession = createQuietSession({
            id: 'session-1',
            active: true,
            presence: 'online',
        });

        registerStorageStateReader(() => createStorageState({
            profileScope: { serverId: 'server-a', accountId: 'account-a' },
            sessionMessages: {
                'session-1': sessionMessagesWithPermission,
            },
        }));
        expect(selectInboxSessionContent({
            sessions: [activeSession],
            sessionRows: [],
            nowMs: 1_000,
        })).toBe(true);

        registerStorageStateReader(() => createStorageState({
            profileScope: { serverId: 'server-a', accountId: 'account-b' },
            sessionMessages: {
                'session-1': sessionMessagesWithoutPermission,
            },
        }));
        expect(selectInboxSessionContent({
            sessions: [activeSession],
            sessionRows: [],
            nowMs: 1_000,
        })).toBe(false);
    });

    it('detects transcript-only pending permissions from the selector input state', () => {
        const selectInboxSessionContent = createInboxSessionContentSelector();
        const permissionMessage = createPermissionMessage(1_000);
        const activeSession = createQuietSession({
            id: 'session-1',
            active: true,
            presence: 'online',
        });
        registerStorageStateReader(() => createStorageState({ sessionMessages: {} }));

        expect(selectInboxSessionContent({
            sessions: [activeSession],
            sessionRows: [],
            sessionMessagesById: {
                'session-1': createSessionMessages({
                    messageIdsOldestFirst: [permissionMessage.id],
                    messagesById: createMessagesById(permissionMessage),
                    messagesVersion: 2,
                }),
            },
            nowMs: 1_000,
        })).toBe(true);
    });

    it('passes selector-state messages to the inbox state evaluator', () => {
        const buildInboxState = vi.fn(emptyInboxState);
        const selectInboxSessionContent = createInboxSessionContentSelector(buildInboxState);
        const permissionMessage = createPermissionMessage(1_000);
        const sessionMessages = createSessionMessages({
            messageIdsOldestFirst: [permissionMessage.id],
            messagesById: createMessagesById(permissionMessage),
            messagesVersion: 2,
        });
        registerStorageStateReader(() => createStorageState({ sessionMessages: {} }));

        selectInboxSessionContent({
            sessions: [createQuietSession({ id: 'session-1' })],
            sessionRows: [],
            sessionMessagesById: {
                'session-1': sessionMessages,
            },
            nowMs: 1_000,
        });

        expect(buildInboxState).toHaveBeenCalledWith({
            sessions: [createQuietSession({ id: 'session-1' })],
            sessionRows: [],
            sessionMessagesById: {
                'session-1': sessionMessages,
            },
            nowMs: 1_000,
        });
    });

    it('rebuilds when a canonical session gains pending inbox attention', () => {
        const buildInboxState = vi.fn(emptyInboxState);
        const selectInboxSessionContent = createInboxSessionContentSelector(buildInboxState);

        selectInboxSessionContent({
            sessions: [createQuietSession({ agentState: null })],
            sessionRows: [],
            nowMs: 10_000,
        });
        selectInboxSessionContent({
            sessions: [
                createQuietSession({
                    agentState: {
                        controlledByUser: null,
                        requests: {
                            approve: {
                                tool: 'Bash',
                                kind: 'permission',
                                arguments: {},
                                createdAt: 9_000,
                            },
                        },
                    },
                }),
            ],
            sessionRows: [],
            nowMs: 10_000,
        });

        expect(buildInboxState).toHaveBeenCalledTimes(2);
    });

    it('rebuilds when a hidden session becomes Voice custody with the same pending request facts', () => {
        const selectInboxSessionContent = createInboxSessionContentSelector();
        const pendingPermissionSession = createQuietSession({
            id: 'hidden-custody',
            serverId: 'server-a',
            active: true,
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
            },
        });

        expect(selectInboxSessionContent({
            sessions: [{
                ...pendingPermissionSession,
                metadata: {
                    path: '/tmp/hidden-custody',
                    host: 'test-host',
                    systemSessionV1: { v: 1, key: 'diagnostics', hidden: true },
                },
            }],
            sessionRows: [],
            nowMs: 10_000,
        })).toBe(false);
        expect(selectInboxSessionContent({
            sessions: [{
                ...pendingPermissionSession,
                metadata: {
                    path: '/tmp/hidden-custody',
                    host: 'test-host',
                    systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
                },
            }],
            sessionRows: [],
            nowMs: 10_000,
        })).toBe(true);
    });

    it('invalidates pending inbox projection when same-id request coverage changes through arguments only', () => {
        const selectInboxSessionContent = createInboxSessionContentSelector();
        const coveredSession = createQuietSession({
            active: true,
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
        const uncoveredSession = createQuietSession({
            active: true,
            presence: 'online',
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

        expect(selectInboxSessionContent({
            sessions: [coveredSession],
            sessionRows: [],
            nowMs: 10_000,
        })).toBe(false);
        expect(selectInboxSessionContent({
            sessions: [uncoveredSession],
            sessionRows: [],
            nowMs: 10_000,
        })).toBe(true);
    });

    it('keeps unresolved permission inbox content after transient runtime freshness expires', () => {
        const observedAtMs = 1_000;
        const selectInboxSessionContent = createInboxSessionContentSelector();
        const input = {
            sessions: [
                createQuietSession({
                    active: true,
                    presence: 'online',
                    agentState: {
                        controlledByUser: null,
                        requests: {
                            approve: {
                                tool: 'Bash',
                                kind: 'permission',
                                arguments: {},
                                createdAt: observedAtMs,
                            },
                        },
                    },
                }),
            ],
            sessionRows: [],
        };

        expect(selectInboxSessionContent({
            ...input,
            nowMs: observedAtMs + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1,
        })).toBe(true);
        expect(selectInboxSessionContent({
            ...input,
            nowMs: observedAtMs + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS + 1,
        })).toBe(true);
    });

    it('recomputes same-seq renderable request summaries when only agent state advances', () => {
        const selectInboxSessionContent = createInboxSessionContentSelector();
        const sessions = [
            createQuietSession({
                id: 'summary-permission',
                serverId: 'server-a',
                seq: 4,
                lastViewedSessionSeq: 4,
                agentStateVersion: 6,
                agentState: null,
            }),
        ];
        const buildRow = (
            agentStateVersion: number,
            hasPendingPermissionRequests: boolean,
        ): SessionListAttentionRow => createAttentionRow('server-a', {
            id: 'summary-permission',
            seq: 4,
            lastViewedSessionSeq: 4,
            active: true,
            presence: 'online',
            agentStateVersion,
            hasPendingPermissionRequests,
            hasPendingUserActionRequests: false,
            pendingRequestObservedAt: hasPendingPermissionRequests ? 9_000 : null,
        });

        expect(selectInboxSessionContent({
            sessions,
            sessionRows: [buildRow(6, false)],
            nowMs: 10_000,
        })).toBe(false);
        expect(selectInboxSessionContent({
            sessions,
            sessionRows: [buildRow(7, true)],
            nowMs: 10_000,
        })).toBe(true);
        expect(selectInboxSessionContent({
            sessions,
            sessionRows: [buildRow(8, false)],
            nowMs: 10_000,
        })).toBe(false);
    });

    it('keeps duplicate session ids scoped by attention-row server', () => {
        const selectInboxSessionContent = createInboxSessionContentSelector();

        expect(selectInboxSessionContent({
            sessions: [],
            sessionRows: [
                createAttentionRow('server-a', { id: 'shared-session', hasUnreadMessages: false }),
                createAttentionRow('server-b', { id: 'shared-session', hasUnreadMessages: false }),
            ],
            nowMs: 10_000,
        })).toBe(false);
        expect(selectInboxSessionContent({
            sessions: [],
            sessionRows: [
                createAttentionRow('server-a', { id: 'shared-session', hasUnreadMessages: false }),
                createAttentionRow('server-b', { id: 'shared-session', hasUnreadMessages: true }),
            ],
            nowMs: 10_000,
        })).toBe(true);
    });
});
