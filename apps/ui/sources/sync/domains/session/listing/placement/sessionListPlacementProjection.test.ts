import { describe, expect, it } from 'vitest';

import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol';

import type { SessionAttentionStandingPolicy } from '../../organization/attentionStanding';
import type { SessionListRenderableSession } from '../sessionListRenderable';
import { projectSessionListPlacement } from './sessionListPlacementProjection';

const usageLimitIssue: SessionRuntimeIssueV1 = {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: 'usage_limit',
    source: 'usage_limit',
    occurredAt: 100,
    provider: 'claude',
    usageLimit: {
        v: 1,
        resetAtMs: null,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'wait',
    },
};

function makeSession(overrides: Partial<SessionListRenderableSession>): SessionListRenderableSession {
    return {
        id: 's1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 0,
        ...overrides,
    };
}

describe('projectSessionListPlacement', () => {
    it('uses fresh canonical in-progress turn status for working placement without legacy presence evidence', () => {
        const nowMs = 10_000;

        expect(projectSessionListPlacement({
            nowMs,
            session: makeSession({
                active: false,
                activeAt: 0,
                presence: 0,
                thinking: false,
                thinkingAt: 0,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: nowMs - 1_000,
                lastRuntimeIssue: null,
            }),
        })).toEqual({
            kind: 'working',
            timestamp: null,
            retainedWorking: false,
            explicitStanding: false,
        });
    });

    it('uses fresh legacy thinking evidence for working placement without detached runtime activity', () => {
        const nowMs = 10_000;

        expect(projectSessionListPlacement({
            nowMs,
            session: makeSession({
                active: true,
                activeAt: nowMs - 1_000,
                presence: 'online',
                thinking: true,
                thinkingAt: nowMs - 1_000,
                latestTurnStatus: undefined,
                latestTurnStatusObservedAt: undefined,
                lastRuntimeIssue: null,
                runtimeActivityActiveCount: 0,
                runtimeActivityState: 'idle',
                runtimeActivityObservedAt: null,
                runtimeActivityRevision: 1,
            }),
        })).toEqual({
            kind: 'working',
            timestamp: null,
            retainedWorking: false,
            explicitStanding: false,
        });
    });

    it('places background activity in Working ahead of Ready after the foreground turn completed', () => {
        const nowMs = 10_000;

        expect(projectSessionListPlacement({
            nowMs,
            session: makeSession({
                active: true,
                activeAt: nowMs - 180_000,
                presence: 'online',
                thinking: false,
                thinkingAt: 0,
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: nowMs - 2_000,
                lastRuntimeIssue: null,
                runtimeActivityState: 'active',
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: nowMs - 1_000,
                runtimeActivityRevision: 1,
            }),
        })).toEqual({
            kind: 'working',
            timestamp: null,
            retainedWorking: false,
            explicitStanding: false,
        });
    });

    it('keeps canonical background activity in Working on an aged projection the runtime still witnesses', () => {
        // The projection instant is stamped only when the projected pair CHANGES, so an hour-old
        // `observedAt` is the normal shape of work that has been running for an hour. Placement must
        // not require a fresh stamp — that would drop live background work out of Working.
        const nowMs = 10_000_000;

        const placement = projectSessionListPlacement({
            nowMs,
            session: makeSession({
                active: true,
                activeAt: nowMs - 15_000,
                presence: 'online',
                thinking: false,
                thinkingAt: 0,
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: nowMs - 2_000,
                lastRuntimeIssue: null,
                runtimeActivityState: 'active',
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: nowMs - 3_600_000,
                runtimeActivityRevision: 1,
            }),
        });

        expect(placement.kind).toBe('working');
        expect(placement.retainedWorking).toBe(false);
    });

    it('drops background activity out of Working once nothing witnesses the runtime any more', () => {
        // Was: "keeps canonical background activity in Working without an observedAt freshness
        // lease" — the contract that kept a session published `active` moments before an
        // unwitnessed death pinned to Working forever. With the session keep-alive at 15 s, a
        // three-minute silence is twelve missed pings, not a slow session.
        const nowMs = 10_000_000;

        const placement = projectSessionListPlacement({
            nowMs,
            session: makeSession({
                active: true,
                activeAt: nowMs - 180_000,
                presence: 'online',
                thinking: false,
                thinkingAt: 0,
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: nowMs - 180_000,
                lastRuntimeIssue: null,
                runtimeActivityState: 'active',
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: nowMs - 180_000,
                runtimeActivityRevision: 1,
            }),
        });

        expect(placement.kind).not.toBe('working');
    });

    it.each([
        ['offline', { active: false, presence: 0, archivedAt: null }],
        ['archived', { active: true, presence: 'online' as const, archivedAt: 9_000 }],
    ])('does not place %s retained background activity in Working', (_label, lifecycle) => {
        const nowMs = 10_000;
        const placement = projectSessionListPlacement({
            nowMs,
            session: makeSession({
                ...lifecycle,
                latestTurnStatus: null,
                latestTurnStatusObservedAt: null,
                runtimeActivityState: 'active',
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: nowMs - 1_000,
                runtimeActivityRevision: 1,
            }),
        });

        expect(placement.kind).toBe('none');
    });

    it('projects retained working placement for stale retained candidates', () => {
        const now = 1_000_000;
        const placement = projectSessionListPlacement({
            session: makeSession({
                active: true,
                presence: 'online',
                activeAt: now - 600_000,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: now - 600_000,
            }),
            sessionKey: 'server-a:s1',
            retainedWorkingSessionKeys: ['server-a:s1'],
            nowMs: now,
        });

        expect(placement).toEqual({
            kind: 'working',
            timestamp: null,
            retainedWorking: true,
            explicitStanding: false,
        });
    });

    it('keeps terminal turn projection authoritative over fresh legacy thinking evidence', () => {
        const nowMs = 10_000;

        expect(projectSessionListPlacement({
            nowMs,
            session: makeSession({
                active: true,
                activeAt: nowMs - 1_000,
                presence: 'online',
                thinking: true,
                thinkingAt: nowMs - 1_000,
                latestTurnStatus: 'failed',
                latestTurnStatusObservedAt: nowMs - 5_000,
                lastRuntimeIssue: usageLimitIssue,
                runtimeActivityState: 'active',
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: nowMs - 1_000,
                runtimeActivityRevision: 1,
            }),
        })).toEqual({
            kind: 'failed',
            timestamp: 100,
            retainedWorking: false,
            explicitStanding: false,
        });
    });

    it('promotes an active failed session even when it has already been read', () => {
        expect(projectSessionListPlacement({
            nowMs: 10_000,
            session: makeSession({
                active: true,
                seq: 10,
                lastViewedSessionSeq: 10,
                hasUnreadMessages: false,
                latestTurnStatus: 'failed',
                latestTurnStatusObservedAt: 1_000,
                lastRuntimeIssue: {
                    ...usageLimitIssue,
                    occurredAt: 1_000,
                },
            }),
        })).toEqual({
            kind: 'failed',
            timestamp: 1_000,
            retainedWorking: false,
            explicitStanding: false,
        });
    });

    it('promotes blocked pending delivery as action-required attention', () => {
        expect(projectSessionListPlacement({
            nowMs: 10_000,
            session: makeSession({
                pendingBlockedCount: 1,
                createdAt: 100,
                updatedAt: 2_000,
                hasPendingUserActionRequests: false,
                hasPendingPermissionRequests: false,
                pendingRequestObservedAt: undefined,
            }),
        })).toEqual({
            kind: 'action_required',
            timestamp: 2_000,
            retainedWorking: false,
            explicitStanding: false,
        });
    });

    it('promotes generic unread activity when an older ready event is already behind the read cursor', () => {
        expect(projectSessionListPlacement({
            nowMs: 10_000,
            session: makeSession({
                seq: 742,
                lastViewedSessionSeq: 738,
                hasUnreadMessages: true,
                meaningfulActivityAt: 7_390,
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: 7_000,
                latestReadyEventSeq: 110,
                latestReadyEventAt: 1_100,
            }),
        })).toEqual({
            kind: 'unread',
            timestamp: 7_390,
            retainedWorking: false,
            explicitStanding: false,
        });
    });

    it('keeps a newer ready event authoritative over generic unread placement', () => {
        expect(projectSessionListPlacement({
            nowMs: 10_000,
            session: makeSession({
                seq: 742,
                lastViewedSessionSeq: 738,
                hasUnreadMessages: true,
                meaningfulActivityAt: 7_390,
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: 7_000,
                latestReadyEventSeq: 742,
                latestReadyEventAt: 7_400,
            }),
        })).toEqual({
            kind: 'ready',
            timestamp: 7_400,
            retainedWorking: false,
            explicitStanding: false,
        });
    });

    it('promotes an inactive failed session only while it has unread activity', () => {
        expect(projectSessionListPlacement({
            nowMs: 10_000,
            session: makeSession({
                active: false,
                seq: 11,
                lastViewedSessionSeq: 10,
                hasUnreadMessages: true,
                latestTurnStatus: 'failed',
                latestTurnStatusObservedAt: 1_000,
                lastRuntimeIssue: {
                    ...usageLimitIssue,
                    occurredAt: 1_000,
                },
            }),
        })).toEqual({
            kind: 'failed',
            timestamp: 1_000,
            retainedWorking: false,
            explicitStanding: false,
        });

        expect(projectSessionListPlacement({
            nowMs: 10_000,
            session: makeSession({
                active: false,
                seq: 10,
                lastViewedSessionSeq: 10,
                hasUnreadMessages: false,
                latestTurnStatus: 'failed',
                latestTurnStatusObservedAt: 1_000,
                lastRuntimeIssue: {
                    ...usageLimitIssue,
                    occurredAt: 1_000,
                },
            }),
        })).toEqual({
            kind: 'none',
            timestamp: null,
            retainedWorking: false,
            explicitStanding: false,
        });
    });

    it('keeps active failed sessions promoted after later diagnostic/control activity', () => {
        expect(projectSessionListPlacement({
            nowMs: 10_000,
            session: makeSession({
                active: true,
                seq: 11,
                lastViewedSessionSeq: 10,
                hasUnreadMessages: true,
                latestTurnStatus: 'failed',
                latestTurnStatusObservedAt: 1_000,
                meaningfulActivityAt: 2_500,
                lastRuntimeIssue: {
                    ...usageLimitIssue,
                    occurredAt: 1_000,
                },
            }),
        })).toEqual({
            kind: 'failed',
            timestamp: 1_000,
            retainedWorking: false,
            explicitStanding: false,
        });
    });
});

describe('unread placement ordering key', () => {
    it('orders unread placement by the unread entry time rather than the moving activity time', () => {
        const session = makeSession({
            seq: 742,
            lastViewedSessionSeq: 738,
            hasUnreadMessages: true,
            unreadSince: 4_000,
            meaningfulActivityAt: 9_500,
            updatedAt: 9_500,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 7_000,
        });

        expect(projectSessionListPlacement({ nowMs: 10_000, session })).toEqual({
            kind: 'unread',
            timestamp: 4_000,
            retainedWorking: false,
            explicitStanding: false,
        });

        // The same row after another message lands: the key must not move.
        expect(projectSessionListPlacement({
            nowMs: 10_000,
            session: { ...session, seq: 743, meaningfulActivityAt: 9_900, updatedAt: 9_900 },
        })).toEqual({
            kind: 'unread',
            timestamp: 4_000,
            retainedWorking: false,
            explicitStanding: false,
        });
    });

    it('falls back to meaningful activity time when no unread entry time is available', () => {
        expect(projectSessionListPlacement({
            nowMs: 10_000,
            session: makeSession({
                seq: 742,
                lastViewedSessionSeq: 738,
                hasUnreadMessages: true,
                meaningfulActivityAt: 7_390,
            }),
        })).toEqual({
            kind: 'unread',
            timestamp: 7_390,
            retainedWorking: false,
            explicitStanding: false,
        });
    });
});

describe('attention standing placement floor', () => {
    const standingPolicy: SessionAttentionStandingPolicy = {
        defaultStanding: false,
        overridesBySessionKey: { 'server-a:s1': true },
    };
    const readIdleSession = makeSession({
        seq: 10,
        lastViewedSessionSeq: 10,
        hasUnreadMessages: false,
        updatedAt: 5_000,
        meaningfulActivityAt: 5_000,
    });

    it('places a read idle standing session on the attention floor', () => {
        expect(projectSessionListPlacement({
            nowMs: 10_000,
            session: readIdleSession,
            sessionKey: 'server-a:s1',
            standingPolicy,
        })).toEqual({
            kind: 'standing',
            timestamp: null,
            retainedWorking: false,
            explicitStanding: true,
        });
    });

    it('marks standing that comes only from the account default as not explicit', () => {
        expect(projectSessionListPlacement({
            nowMs: 10_000,
            session: readIdleSession,
            sessionKey: 'server-a:s1',
            standingPolicy: { defaultStanding: true, overridesBySessionKey: {} },
        })).toEqual({
            kind: 'standing',
            timestamp: null,
            retainedWorking: false,
            explicitStanding: false,
        });
    });

    it('keeps unread placement authoritative over the standing floor', () => {
        expect(projectSessionListPlacement({
            nowMs: 10_000,
            session: {
                ...readIdleSession,
                seq: 11,
                hasUnreadMessages: true,
                unreadSince: 4_000,
            },
            sessionKey: 'server-a:s1',
            standingPolicy,
        })).toEqual({
            kind: 'unread',
            timestamp: 4_000,
            retainedWorking: false,
            explicitStanding: false,
        });
    });

    it('keeps working placement authoritative over the standing floor', () => {
        expect(projectSessionListPlacement({
            nowMs: 10_000,
            session: {
                ...readIdleSession,
                active: true,
                presence: 'online',
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: 9_000,
            },
            sessionKey: 'server-a:s1',
            standingPolicy,
        })).toEqual({
            kind: 'working',
            timestamp: null,
            retainedWorking: false,
            explicitStanding: false,
        });
    });

    it('keeps an explicitly removed session off the floor while the account default stands', () => {
        expect(projectSessionListPlacement({
            nowMs: 10_000,
            session: readIdleSession,
            sessionKey: 'server-a:s1',
            standingPolicy: {
                defaultStanding: true,
                overridesBySessionKey: { 'server-a:s1': false },
            },
        })).toEqual({
            kind: 'none',
            timestamp: null,
            retainedWorking: false,
            explicitStanding: false,
        });
    });
});
