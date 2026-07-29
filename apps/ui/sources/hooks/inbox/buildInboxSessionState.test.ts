import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListAttentionRow } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';

import { buildInboxSessionState } from './buildInboxSessionState';

function makeUnreadRenderable(overrides: Partial<SessionListRenderableSession> = {}): SessionListRenderableSession {
    return {
        id: 'session-1',
        seq: 4,
        createdAt: 1,
        updatedAt: 10,
        active: true,
        activeAt: 1,
        metadataVersion: 0,
        agentStateVersion: 0,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        hasUnreadMessages: true,
        ...overrides,
    };
}

function makeSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        seq: 4,
        createdAt: 1,
        updatedAt: 10,
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

describe('buildInboxSessionState', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('deduplicates unread session rows by scoped server and session id', () => {
        const firstRow: SessionListAttentionRow = {
            serverId: 'server-a',
            serverName: 'Server A',
            session: makeUnreadRenderable({ id: 'session-1', updatedAt: 20 }),
        };
        const duplicateRow: SessionListAttentionRow = {
            serverId: 'server-a',
            serverName: 'Server A',
            session: makeUnreadRenderable({ id: 'session-1', updatedAt: 10 }),
        };

        const state = buildInboxSessionState({
            sessions: [],
            sessionRows: [firstRow, duplicateRow],
        });

        expect(state.unreadSessions).toHaveLength(1);
        expect(state.unreadSessions[0]).toEqual(firstRow);
    });

    it('keeps unread session rows from different servers distinct when ids overlap', () => {
        const serverARow: SessionListAttentionRow = {
            serverId: 'server-a',
            serverName: 'Server A',
            session: makeUnreadRenderable({ id: 'session-1', updatedAt: 20 }),
        };
        const serverBRow: SessionListAttentionRow = {
            serverId: 'server-b',
            serverName: 'Server B',
            session: makeUnreadRenderable({ id: 'session-1', updatedAt: 10 }),
        };

        const state = buildInboxSessionState({
            sessions: [],
            sessionRows: [serverARow, serverBRow],
        });

        expect(state.unreadSessions).toEqual([serverARow, serverBRow]);
    });

    it('does not admit layout-v1 private-looking shared custody metadata without an owner view', () => {
        const session = makeSession({
            id: 'layout-v1-missing-owner',
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                systemSessionV1: {
                    v: 1,
                    key: 'voice_conversation',
                    hidden: true,
                },
            } as any,
            ownerMetadataView: null,
            seq: 2,
            lastViewedSessionSeq: 1,
            latestTurnStatus: 'completed',
        });

        expect(buildInboxSessionState({ sessions: [session] })).toEqual({
            unreadSessions: [],
            sessionsNeedingAttention: [],
        });
    });

    it('uses canonical unread state when a same-server stale attention row says the hydrated session is read', () => {
        const canonicalSession = makeSession({
            id: 'session-1',
            serverId: 'server-a',
            seq: 4,
            lastViewedSessionSeq: 1,
            latestTurnStatus: 'completed',
        });
        const staleRow: SessionListAttentionRow = {
            serverId: 'server-a',
            serverName: 'Server A',
            session: makeUnreadRenderable({
                id: 'session-1',
                seq: 4,
                lastViewedSessionSeq: 4,
                hasUnreadMessages: false,
            }),
        };

        const state = buildInboxSessionState({
            sessions: [canonicalSession],
            sessionRows: [staleRow],
        });

        expect(state.unreadSessions).toEqual([{
            ...staleRow,
            session: canonicalSession,
        }]);
    });

    it('does not use active-server canonical read state for a different server row', () => {
        const canonicalSession = makeSession({
            id: 'session-1',
            serverId: 'server-a',
            seq: 4,
            lastViewedSessionSeq: 4,
            latestTurnStatus: 'completed',
        });
        const otherServerRow: SessionListAttentionRow = {
            serverId: 'server-b',
            serverName: 'Server B',
            session: makeUnreadRenderable({
                id: 'session-1',
                seq: 4,
                lastViewedSessionSeq: 1,
                hasUnreadMessages: true,
            }),
        };

        const state = buildInboxSessionState({
            sessions: [canonicalSession],
            sessionRows: [otherServerRow],
        });

        expect(state.unreadSessions).toContainEqual(otherServerRow);
    });

    it('uses canonical read state when a same-server stale attention row says the hydrated session is unread', () => {
        const canonicalSession = makeSession({ id: 'session-1', serverId: 'server-a', seq: 4, lastViewedSessionSeq: 4 });
        const staleRow: SessionListAttentionRow = {
            serverId: 'server-a',
            serverName: 'Server A',
            session: makeUnreadRenderable({
                id: 'session-1',
                seq: 4,
                lastViewedSessionSeq: 1,
                hasUnreadMessages: true,
            }),
        };

        const state = buildInboxSessionState({
            sessions: [canonicalSession],
            sessionRows: [staleRow],
        });

        expect(state.unreadSessions).toEqual([]);
    });

    it('surfaces and clears same-seq newer request summaries as open-only inbox attention', () => {
        const canonicalSession = makeSession({
            id: 'summary-permission',
            serverId: 'server-a',
            seq: 4,
            lastViewedSessionSeq: 4,
            agentStateVersion: 6,
            agentState: null,
        });
        const pendingRow: SessionListAttentionRow = {
            serverId: 'server-a',
            serverName: 'Server A',
            session: makeUnreadRenderable({
                id: canonicalSession.id,
                seq: 4,
                lastViewedSessionSeq: 4,
                hasUnreadMessages: false,
                agentStateVersion: 7,
                hasPendingPermissionRequests: true,
                hasPendingUserActionRequests: false,
                pendingRequestObservedAt: 950,
            }),
        };

        const pendingState = buildInboxSessionState({
            sessions: [canonicalSession],
            sessionRows: [pendingRow],
            nowMs: 1_000,
        });

        expect(pendingState.sessionsNeedingAttention).toEqual([
            expect.objectContaining({
                session: expect.objectContaining({
                    id: canonicalSession.id,
                    agentStateVersion: 7,
                    agentState: null,
                }),
                pendingPermissions: [],
                pendingUserActions: [],
            }),
        ]);
        expect(pendingState.unreadSessions).toEqual([]);

        const clearedState = buildInboxSessionState({
            sessions: [canonicalSession],
            sessionRows: [{
                ...pendingRow,
                session: {
                    ...pendingRow.session,
                    agentStateVersion: 8,
                    hasPendingPermissionRequests: false,
                    pendingRequestObservedAt: null,
                },
            }],
            nowMs: 1_000,
        });

        expect(clearedState.sessionsNeedingAttention).toEqual([]);
        expect(clearedState.unreadSessions).toEqual([]);
    });

    it('promotes a pending-summary renderable without an unread projection into a full attention session', () => {
        const canonicalSession = makeSession({
            id: 'summary-without-unread-projection',
            serverId: 'server-a',
            agentStateVersion: 6,
            agentState: null,
            lastViewedSessionSeq: 4,
        });
        const summaryOnlySession = makeUnreadRenderable({
            id: canonicalSession.id,
            agentStateVersion: 7,
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
            pendingRequestObservedAt: 950,
        });
        delete summaryOnlySession.hasUnreadMessages;
        const summaryOnlyRow: SessionListAttentionRow = {
            serverId: 'server-a',
            serverName: 'Server A',
            session: summaryOnlySession,
        };

        const state = buildInboxSessionState({
            sessions: [canonicalSession],
            sessionRows: [summaryOnlyRow],
            nowMs: 1_000,
        });

        expect(state.sessionsNeedingAttention).toEqual([
            expect.objectContaining({
                session: expect.objectContaining({
                    id: 'summary-without-unread-projection',
                    agentState: null,
                    agentStateVersion: 7,
                }),
                pendingPermissions: [],
                pendingUserActions: [],
            }),
        ]);
    });

    it('excludes metadata-unavailable session rows from unread attention', () => {
        const state = buildInboxSessionState({
            sessions: [],
            sessionRows: [{
                serverId: 'server-a',
                serverName: 'Server A',
                session: makeUnreadRenderable({
                    id: 'session-unavailable',
                    metadata: null,
                    metadataUnavailable: true,
                    hasUnreadMessages: true,
                }),
            }],
        });

        expect(state.unreadSessions).toEqual([]);
    });

    it('keeps post-End Voice permission and late-result custody in Inbox after attention freshness expires', () => {
        const hiddenPermission = makeSession({
            id: 'voice-permission',
            serverId: 'server-a',
            pendingPermissionRequestCount: 1,
            metadata: {
                path: '/tmp/voice-permission',
                host: 'test-host',
                systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
            },
            agentState: {
                controlledByUser: null,
                requests: {
                    request_1: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: { command: 'git status' },
                        createdAt: 10,
                    },
                },
            },
        });
        const hiddenLateResult = makeSession({
            id: 'voice-late-result',
            serverId: 'server-a',
            seq: 5,
            latestReadyEventSeq: 5,
            lastViewedSessionSeq: 1,
            metadata: {
                path: '/tmp/voice-late-result',
                host: 'test-host',
                systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
            },
        });
        const unrelatedHidden = makeSession({
            id: 'voice-transcript-history',
            serverId: 'server-a',
            seq: 5,
            latestReadyEventSeq: 5,
            lastViewedSessionSeq: 1,
            pendingPermissionRequestCount: 1,
            metadata: {
                path: '/tmp/voice-transcript-history',
                host: 'test-host',
                systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
            },
            agentState: hiddenPermission.agentState,
        });

        const state = buildInboxSessionState({
            sessions: [hiddenPermission, hiddenLateResult, unrelatedHidden],
            sessionRows: [],
            nowMs: 200_000,
        });

        expect(state.sessionsNeedingAttention).toEqual([
            expect.objectContaining({
                session: expect.objectContaining({ id: 'voice-permission' }),
                pendingPermissions: [
                    expect.objectContaining({
                        id: 'request_1',
                        tool: 'Bash',
                        kind: 'permission',
                    }),
                ],
            }),
        ]);
        expect(state.unreadSessions.map((row) => row.session.id)).toEqual([
            'voice-late-result',
        ]);
    });

    it('includes failed primary-session runtime attention even when the transcript is read', () => {
        const failedSession = makeSession({
            id: 'session-failed',
            seq: 4,
            lastViewedSessionSeq: 4,
            latestTurnStatus: 'failed',
            lastRuntimeIssue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'agent_status_error',
                source: 'agent_status_error',
                occurredAt: 100,
                sanitizedPreview: 'Provider reported an error',
            },
        } as Partial<Session>);

        const state = buildInboxSessionState({
            sessions: [failedSession],
            sessionRows: [],
        });

        expect(state.unreadSessions).toEqual([{
            session: failedSession,
            serverId: null,
            serverName: null,
        }]);
    });

    it('keeps fresh pending requests in actionable inbox attention', () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
        const session = makeSession({
            active: true,
            presence: 'online',
            agentState: {
                controlledByUser: null,
                requests: {
                    request_1: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: {},
                        createdAt: 999_000,
                    },
                },
            },
        });

        const state = buildInboxSessionState({
            sessions: [session],
            sessionRows: [],
        });

        expect(state.sessionsNeedingAttention.map((entry) => entry.session.id)).toEqual(['session-1']);
    });

    it('excludes stale terminal non-permission actions from actionable inbox attention', () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
        const session = makeSession({
            active: true,
            presence: 'online',
            thinking: true,
            thinkingAt: 880_000,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 999_000,
            agentState: {
                controlledByUser: null,
                requests: {
                    request_1: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: {},
                        createdAt: 10,
                    },
                },
            },
        });

        const state = buildInboxSessionState({
            sessions: [session],
            sessionRows: [],
        });

        expect(state.sessionsNeedingAttention).toEqual([]);
    });
});
