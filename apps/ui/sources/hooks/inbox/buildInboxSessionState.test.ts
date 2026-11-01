import { describe, expect, it } from 'vitest';

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import type { Session } from '@/sync/domains/state/storageTypes';

import {
    buildInboxSessionSummary,
    buildInboxSessionState,
    hasInboxSessionContent,
    resolveNextInboxSessionStateFreshnessAtMs,
} from './buildInboxSessionState';

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
        latestTurnStatus: 'completed',
        latestTurnStatusObservedAt: 10,
        latestReadyEventSeq: 4,
        latestReadyEventAt: 10,
        lastViewedSessionSeq: 1,
        meaningfulActivityAt: 10,
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

function makeScopedSessionList(
    serverId: string,
    sessions: readonly SessionListRenderableSession[],
): SessionListViewItem[] {
    return [
        { type: 'header', title: serverId, serverId },
        ...sessions.map((session): SessionListViewItem => ({ type: 'session', serverId, session })),
    ];
}

describe('buildInboxSessionState', () => {
    const now = 1_000_000;

    it('does not offer a completed foreground turn for review while background work continues', () => {
        const session = makeUnreadRenderable({
            activeAt: now,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: now,
        });
        const input = {
            sessions: [],
            sessionListViewDataByServerId: { background: makeScopedSessionList('background', [session]) },
            nowMs: now,
        };
        expect(buildInboxSessionState(input).reviewSessions).toEqual([]);
        expect(buildInboxSessionSummary(input).hasContent).toBe(false);
        expect(buildInboxSessionState({
            ...input,
            sessionListViewDataByServerId: {
                background: makeScopedSessionList('background', [{ ...session, runtimeActivityState: 'idle', runtimeActivityActiveCount: 0 }]),
            },
        }).reviewSessions.map(({ reason }) => reason)).toEqual(['ready']);
    });

    it('does not surface or mark a still-working session merely because streaming made it unread', () => {
        const working = makeUnreadRenderable({
            id: 'working-unread',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: now,
            meaningfulActivityAt: now,
        });

        const state = buildInboxSessionState({
            sessions: [],
            sessionListViewDataByServerId: {
                background: makeScopedSessionList('background', [working]),
            },
            nowMs: now,
        });

        expect(state.reviewSessions).toEqual([]);
        expect(state.sessionsNeedingAttention).toEqual([]);
        expect(state.markAllReadTargets).toEqual([]);
        expect(hasInboxSessionContent({
            sessions: [],
            sessionListViewDataByServerId: {
                background: makeScopedSessionList('background', [working]),
            },
            nowMs: now,
        })).toBe(false);
    });

    it('keeps a working session with a permission request actionable without creating a read target', () => {
        const working = makeUnreadRenderable({
            id: 'working-permission',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: now,
            meaningfulActivityAt: now,
            hasPendingPermissionRequests: true,
            pendingRequestObservedAt: now,
        });

        const state = buildInboxSessionState({
            sessions: [],
            sessionListViewDataByServerId: {
                background: makeScopedSessionList('background', [working]),
            },
            nowMs: now,
        });

        expect(state.sessionsNeedingAttention.map(({ key, reason }) => ({ key, reason }))).toEqual([{
            key: 'background:working-permission',
            reason: 'permission_required',
        }]);
        expect(state.reviewSessions).toEqual([]);
        expect(state.markAllReadTargets).toEqual([]);
    });

    it('surfaces an unseen completed turn as the canonical ready-for-review reason', () => {
        const completed = makeUnreadRenderable({
            id: 'completed-ready',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: now,
            latestReadyEventSeq: 4,
            latestReadyEventAt: now,
            lastViewedSessionSeq: 1,
            meaningfulActivityAt: now,
        });

        const state = buildInboxSessionState({
            sessions: [],
            sessionListViewDataByServerId: {
                background: makeScopedSessionList('background', [completed]),
            },
            nowMs: now,
        });

        expect(state.reviewSessions.map(({ key, reason }) => ({ key, reason }))).toEqual([{
            key: 'background:completed-ready',
            reason: 'ready',
        }]);
        expect(state.markAllReadTargets).toEqual([{
            key: 'background:completed-ready',
            sessionId: 'completed-ready',
            serverId: 'background',
            readState: 'unread',
        }]);
    });

    it('does not treat a plain unread placement as Inbox-worthy completion or attention', () => {
        const unread = makeUnreadRenderable({
            id: 'plain-unread',
            active: false,
            presence: 0,
            latestTurnStatus: null,
            latestReadyEventSeq: null,
        });

        const state = buildInboxSessionState({
            sessions: [],
            sessionListViewDataByServerId: {
                background: makeScopedSessionList('background', [unread]),
            },
            nowMs: now,
        });

        expect(state.reviewSessions).toEqual([]);
        expect(state.sessionsNeedingAttention).toEqual([]);
        expect(state.markAllReadTargets).toEqual([]);
    });

    it('keeps a failed session visible without treating its read cursor as a clearing action', () => {
        const failed = makeUnreadRenderable({
            id: 'failed-unread',
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: now,
            latestReadyEventSeq: null,
            lastRuntimeIssue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                source: 'stream_error',
                code: 'provider_error',
                occurredAt: now,
            },
        });

        const state = buildInboxSessionState({
            sessions: [],
            sessionListViewDataByServerId: {
                background: makeScopedSessionList('background', [failed]),
            },
            nowMs: now,
        });

        expect(state.reviewSessions.map(({ key, reason }) => ({ key, reason }))).toEqual([{
            key: 'background:failed-unread',
            reason: 'failed',
        }]);
        expect(state.markAllReadTargets).toEqual([]);
    });

    it('keeps identical raw session ids from separate server caches as distinct unread entries and targets', () => {
        const serverASession = makeUnreadRenderable({ id: 'shared-id', updatedAt: 20 });
        const serverBSession = makeUnreadRenderable({ id: 'shared-id', updatedAt: 10 });

        const state = buildInboxSessionState({
            sessions: [],
            sessionListViewDataByServerId: {
                'server-a': makeScopedSessionList('server-a', [serverASession]),
                'server-b': makeScopedSessionList('server-b', [serverBSession]),
            },
        });

        expect(state.reviewSessions.map(({ key, serverId, sessionId, session }) => ({
            key,
            serverId,
            sessionId,
            session,
        }))).toEqual([
            { key: 'server-a:shared-id', serverId: 'server-a', sessionId: 'shared-id', session: serverASession },
            { key: 'server-b:shared-id', serverId: 'server-b', sessionId: 'shared-id', session: serverBSession },
        ]);
        expect(state.markAllReadTargets).toEqual([
            { key: 'server-a:shared-id', sessionId: 'shared-id', serverId: 'server-a', readState: 'unread' },
            { key: 'server-b:shared-id', sessionId: 'shared-id', serverId: 'server-b', readState: 'unread' },
        ]);
    });

    it('matches duplicate hydrated session ids within their server scope', () => {
        const serverASession = makeSession({
            id: 'shared-id',
            serverId: 'server-a',
            latestReadyEventSeq: 4,
        });
        const serverBSession = makeSession({
            id: 'shared-id',
            serverId: 'server-b',
            latestReadyEventSeq: 4,
        });

        const state = buildInboxSessionState({
            sessions: [serverASession, serverBSession],
            sessionListViewDataByServerId: {
                'server-a': makeScopedSessionList('server-a', [makeUnreadRenderable({ id: 'shared-id' })]),
                'server-b': makeScopedSessionList('server-b', [makeUnreadRenderable({ id: 'shared-id' })]),
            },
        });

        expect(state.reviewSessions.map(({ key, session }) => ({ key, session }))).toEqual([
            { key: 'server-a:shared-id', session: serverASession },
            { key: 'server-b:shared-id', session: serverBSession },
        ]);
    });

    it('retains the exact server target for an unread session that only exists in a background cache', () => {
        const backgroundSession = makeUnreadRenderable({ id: 'background-only' });

        const state = buildInboxSessionState({
            sessions: [],
            sessionListViewDataByServerId: {
                background: makeScopedSessionList('background', [backgroundSession]),
            },
        });

        expect(state.reviewSessions).toEqual([{
            key: 'background:background-only',
            serverId: 'background',
            sessionId: 'background-only',
            session: backgroundSession,
            reason: 'ready',
        }]);
        expect(state.markAllReadTargets).toEqual([{
            key: 'background:background-only',
            sessionId: 'background-only',
            serverId: 'background',
            readState: 'unread',
        }]);
    });

    it('surfaces background pending attention from the scoped renderable without inventing request details', () => {
        const backgroundSession = makeUnreadRenderable({
            id: 'background-pending',
            hasUnreadMessages: false,
            hasPendingPermissionRequests: true,
            pendingRequestObservedAt: now,
            activeAt: now,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: now,
        });

        const state = buildInboxSessionState({
            sessions: [],
            sessionListViewDataByServerId: {
                background: makeScopedSessionList('background', [backgroundSession]),
            },
            nowMs: now,
        });

        expect(state.sessionsNeedingAttention).toEqual([{
            key: 'background:background-pending',
            serverId: 'background',
            sessionId: 'background-pending',
            session: backgroundSession,
            reason: 'permission_required',
            pendingPermissions: [],
            pendingUserActions: [],
        }]);
        expect(state.reviewSessions).toEqual([]);
        expect(state.markAllReadTargets).toEqual([]);
        const summary = buildInboxSessionSummary({
            sessions: [],
            sessionListViewDataByServerId: {
                background: makeScopedSessionList('background', [backgroundSession]),
            },
            nowMs: now,
        });
        expect(summary.hasContent).toBe(true);
        expect(summary.nextFreshnessAtMs).toBeGreaterThan(now);
        expect(resolveNextInboxSessionStateFreshnessAtMs({
            sessions: [],
            sessionListViewDataByServerId: {
                background: makeScopedSessionList('background', [backgroundSession]),
            },
            nowMs: now,
        })).toBe(summary.nextFreshnessAtMs);
    });

    it('surfaces canonically blocked pending delivery as session attention', () => {
        const blocked = makeUnreadRenderable({
            id: 'blocked-delivery',
            hasUnreadMessages: false,
            pendingBlockedCount: 1,
        });

        const state = buildInboxSessionState({
            sessions: [],
            sessionListViewDataByServerId: {
                background: makeScopedSessionList('background', [blocked]),
            },
            nowMs: now,
        });

        expect(state.sessionsNeedingAttention.map((entry) => entry.key)).toEqual([
            'background:blocked-delivery',
        ]);
        expect(state.reviewSessions).toEqual([]);
        expect(state.markAllReadTargets).toEqual([]);
    });

    it('deduplicates actionable and unread presentation only within the same server scope', () => {
        const actionableSession = makeSession({
            id: 'shared-id',
            serverId: 'server-a',
            latestReadyEventSeq: 4,
            active: true,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: now,
            agentState: {
                controlledByUser: null,
                requests: {
                    request_1: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: {},
                        createdAt: now,
                    },
                },
            },
        });
        const serverARow = makeUnreadRenderable({ id: 'shared-id' });
        const serverBRow = makeUnreadRenderable({ id: 'shared-id' });

        const state = buildInboxSessionState({
            sessions: [actionableSession],
            sessionListViewDataByServerId: {
                'server-a': makeScopedSessionList('server-a', [serverARow]),
                'server-b': makeScopedSessionList('server-b', [serverBRow]),
            },
            nowMs: now,
        });

        expect(state.sessionsNeedingAttention.map((entry) => entry.key)).toEqual(['server-a:shared-id']);
        expect(state.reviewSessions.map((entry) => entry.key)).toEqual(['server-b:shared-id']);
        expect(state.markAllReadTargets.map((target) => target.key)).toEqual(['server-b:shared-id']);
    });

    it('deduplicates repeated unread session rows by scoped session key', () => {
        const firstSession = makeUnreadRenderable({ id: 'session-1', updatedAt: 20 });
        const duplicateSession = makeUnreadRenderable({ id: 'session-1', updatedAt: 10 });

        const state = buildInboxSessionState({
            sessions: [],
            sessionListViewDataByServerId: {
                'server-a': makeScopedSessionList('server-a', [firstSession, duplicateSession]),
            },
        });

        expect(state.reviewSessions).toEqual([{
            key: 'server-a:session-1',
            serverId: 'server-a',
            sessionId: 'session-1',
            session: firstSession,
            reason: 'ready',
        }]);
    });

    it('bounds hydrated-session lookup work while resolving scoped cache rows', () => {
        const sessionCount = 64;
        let hydratedSessionIdReads = 0;
        const hydratedSessions = Array.from({ length: sessionCount }, (_, index) => {
            const sessionId = `session-${index}`;
            const session = makeSession({
                id: sessionId,
                serverId: 'server-a',
                latestReadyEventSeq: 4,
            });
            Object.defineProperty(session, 'id', {
                configurable: true,
                enumerable: true,
                get() {
                    hydratedSessionIdReads += 1;
                    return sessionId;
                },
            });
            return session;
        });
        const cachedSessions = Array.from({ length: sessionCount }, (_, index) => (
            makeUnreadRenderable({ id: `session-${index}` })
        ));

        const state = buildInboxSessionState({
            sessions: hydratedSessions,
            sessionListViewDataByServerId: {
                'server-a': makeScopedSessionList('server-a', cachedSessions),
            },
        });

        expect(state.reviewSessions).toHaveLength(sessionCount);
        expect(state.sessionByKey.get('server-a:session-63')?.session).toBe(hydratedSessions[63]);
        expect(hydratedSessionIdReads).toBeLessThanOrEqual(sessionCount * 8);
    });

    it('uses canonical unread state when a stale renderable says the hydrated session is read', () => {
        const canonicalSession = makeSession({
            id: 'session-1',
            serverId: 'server-a',
            seq: 4,
            latestReadyEventSeq: 4,
            lastViewedSessionSeq: 1,
        });
        const staleRenderable = makeUnreadRenderable({
            id: 'session-1',
            seq: 4,
            lastViewedSessionSeq: 4,
            hasUnreadMessages: false,
        });

        const state = buildInboxSessionState({
            sessions: [canonicalSession],
            sessionListViewDataByServerId: {
                'server-a': makeScopedSessionList('server-a', [staleRenderable]),
            },
        });

        expect(state.reviewSessions).toEqual([{
            key: 'server-a:session-1',
            serverId: 'server-a',
            sessionId: 'session-1',
            session: canonicalSession,
            reason: 'ready',
        }]);
    });

    it('uses canonical read state when a stale renderable says the hydrated session is unread', () => {
        const canonicalSession = makeSession({ id: 'session-1', serverId: 'server-a', seq: 4, lastViewedSessionSeq: 4 });
        const staleRenderable = makeUnreadRenderable({
            id: 'session-1',
            seq: 4,
            lastViewedSessionSeq: 1,
            hasUnreadMessages: true,
        });

        const state = buildInboxSessionState({
            sessions: [canonicalSession],
            sessionListViewDataByServerId: {
                'server-a': makeScopedSessionList('server-a', [staleRenderable]),
            },
        });

        expect(state.reviewSessions).toEqual([]);
    });

    it('excludes undecryptable session rows from unread attention', () => {
        const unavailableRenderable = makeUnreadRenderable({
            id: 'session-unknown',
            metadata: null,
            metadataUnavailable: true,
            hasUnreadMessages: true,
        });

        const state = buildInboxSessionState({
            sessions: [],
            sessionListViewDataByServerId: {
                'server-a': makeScopedSessionList('server-a', [unavailableRenderable]),
            },
        });

        expect(state.reviewSessions).toEqual([]);
    });

    it('keeps fresh pending requests in actionable inbox attention', () => {
        const session = makeSession({
            active: true,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: now,
            agentState: {
                controlledByUser: null,
                requests: {
                    request_1: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: {},
                        createdAt: 10,
                    },
                },
            },
        });

        const state = buildInboxSessionState({
            sessions: [session],
            nowMs: now,
        });

        expect(state.sessionsNeedingAttention.map((entry) => entry.session.id)).toEqual(['session-1']);
    });

    it('keeps an actionable working session in one visible section without a premature read target', () => {
        const session = makeSession({
            serverId: 'server-a',
            seq: 4,
            latestReadyEventSeq: 4,
            lastViewedSessionSeq: 1,
            active: true,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: now,
            agentState: {
                controlledByUser: null,
                requests: {
                    request_1: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: {},
                        createdAt: now,
                    },
                },
            },
        });

        const state = buildInboxSessionState({
            sessions: [session],
            nowMs: now,
        });

        expect(state.sessionsNeedingAttention.map((entry) => entry.session.id)).toEqual(['session-1']);
        expect(state.reviewSessions).toEqual([]);
        expect(state.markAllReadTargets).toEqual([]);
    });

    it('keeps a pending request left after a completed turn actionable until its runtime goes offline', () => {
        const pendingAfterCompletedTurn = {
            active: true,
            thinking: true,
            thinkingAt: now - 120_000,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: now - 1_000,
            agentState: {
                controlledByUser: null,
                requests: {
                    request_1: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: {},
                        createdAt: 10,
                    },
                },
            },
        } as const;

        const liveState = buildInboxSessionState({
            sessions: [makeSession({ ...pendingAfterCompletedTurn, presence: 'online' })],
            nowMs: now,
        });
        const offlineState = buildInboxSessionState({
            sessions: [makeSession({ ...pendingAfterCompletedTurn, presence: now - 1_000 })],
            nowMs: now,
        });

        expect(liveState.sessionsNeedingAttention.map((entry) => entry.session.id)).toEqual(['session-1']);
        expect(offlineState.sessionsNeedingAttention).toEqual([]);
    });

    it('excludes hidden system sessions from inbox attention', () => {
        const hiddenSession = makeSession({
            id: 'voice-carrier',
            serverId: 'server-a',
            pendingCount: 1,
            metadata: {
                path: '/tmp/voice-carrier',
                host: 'test-host',
                systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true },
            },
            agentState: {
                controlledByUser: null,
                requests: {
                    request_1: {
                        tool: 'Voice',
                        kind: 'user_action',
                        arguments: {},
                        createdAt: 10,
                    },
                },
            },
        });
        const hiddenRenderable = makeUnreadRenderable({
            id: 'voice-carrier',
            metadata: {
                path: '/tmp/voice-carrier',
                hiddenSystemSession: true,
            },
            hasUnreadMessages: true,
        });

        const state = buildInboxSessionState({
            sessions: [hiddenSession],
            sessionListViewDataByServerId: {
                'server-a': makeScopedSessionList('server-a', [hiddenRenderable]),
            },
        });

        expect(state.sessionsNeedingAttention).toEqual([]);
        expect(state.reviewSessions).toEqual([]);
    });

    it('excludes archived sessions from both actionable and unread inbox attention', () => {
        const archivedSession = makeSession({
            serverId: 'server-a',
            archivedAt: 123,
            agentState: {
                controlledByUser: null,
                requests: {
                    request_1: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: {},
                        createdAt: now,
                    },
                },
            },
        });
        const archivedRenderable = makeUnreadRenderable({
            hasUnreadMessages: true,
        });

        const state = buildInboxSessionState({
            sessions: [archivedSession],
            sessionListViewDataByServerId: {
                'server-a': makeScopedSessionList('server-a', [archivedRenderable]),
            },
            nowMs: now,
        });

        expect(state.sessionsNeedingAttention).toEqual([]);
        expect(state.reviewSessions).toEqual([]);
        expect(hasInboxSessionContent({
            sessions: [archivedSession],
            sessionListViewDataByServerId: {
                'server-a': makeScopedSessionList('server-a', [archivedRenderable]),
            },
            nowMs: now,
        })).toBe(false);
    });
});
