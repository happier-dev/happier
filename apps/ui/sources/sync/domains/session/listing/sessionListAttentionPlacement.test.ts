import { describe, expect, it } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from './sessionListRenderable';
import { sessionAddressKey } from '../sessionAddress';
import {
    applySessionListAttentionPlacementWithinGroups,
    applySessionListWorkingPlacementWithinGroups,
    buildSessionListAttentionPlacement,
    buildSessionListWorkingPlacement,
} from './sessionListAttentionPlacement';

function createRow(overrides: Partial<SessionListRenderableSession> = {}): SessionListRenderableSession {
    return {
        id: 'runtime-activity',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        latestTurnStatus: 'completed',
        latestTurnStatusObservedAt: 1,
        ...overrides,
    };
}

describe('applySessionListWorkingPlacementWithinGroups', () => {
    it('places completed background activity at the front of its group', () => {
        const nowMs = 1_000_000;
        const source = [
            { type: 'session', serverId: 'server-a', sessionId: 'fresh-runtime', groupKey: 'project-a', groupKind: 'project' },
        ] satisfies ReadonlyArray<SessionListIndexItem>;

        const result = applySessionListWorkingPlacementWithinGroups({
            source,
            options: { mode: 'withinGroups' },
            nowMs,
            resolveSessionRow: () => createRow({
                id: 'fresh-runtime',
                latestTurnStatusObservedAt: nowMs - 10_000,
                runtimeActivityState: 'active',
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: nowMs - 1_000,
                runtimeActivityRevision: nowMs + 60_000,
            }),
        });

        expect(result).toEqual([
            expect.objectContaining({
                type: 'session',
                sessionId: 'fresh-runtime',
                workingPlacementReason: 'working',
                keepVisibleWhenInactive: true,
            }),
        ]);
    });

    it('keeps canonical background activity in working placement without timestamp freshness inference', () => {
        const nowMs = 1_000_000;
        const source = [
            { type: 'session', serverId: 'server-a', sessionId: 'stale-runtime', groupKey: 'project-a', groupKind: 'project' },
        ] satisfies ReadonlyArray<SessionListIndexItem>;

        const result = applySessionListWorkingPlacementWithinGroups({
            source,
            options: { mode: 'withinGroups' },
            nowMs,
            resolveSessionRow: () => createRow({
                id: 'stale-runtime',
                active: true,
                presence: 'online',
                latestTurnStatusObservedAt: nowMs - 10_000,
                runtimeActivityState: 'active',
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: nowMs - 300_000,
                runtimeActivityRevision: nowMs - 1,
            }),
        });

        expect(result).toEqual([
            expect.objectContaining({
                type: 'session',
                sessionId: 'stale-runtime',
                workingPlacementReason: 'working',
                keepVisibleWhenInactive: true,
            }),
        ]);
    });

    it.each([
        ['offline', { presence: 123_456 }],
        ['archived', { archivedAt: 123_456 }],
    ])('does not place %s background activity in working rows', (_label, overrides) => {
        const nowMs = 1_000_000;
        const source = [
            { type: 'session', serverId: 'server-a', sessionId: 'inactive-runtime', groupKey: 'project-a', groupKind: 'project' },
        ] satisfies ReadonlyArray<SessionListIndexItem>;

        const result = applySessionListWorkingPlacementWithinGroups({
            source,
            options: { mode: 'withinGroups' },
            nowMs,
            resolveSessionRow: () => createRow({
                id: 'inactive-runtime',
                runtimeActivityState: 'active',
                runtimeActivityActiveCount: 1,
                runtimeActivityRevision: 1,
                ...overrides,
            }),
        });

        expect(result).toBe(source);
    });
});

describe('buildSessionListWorkingPlacement', () => {
    it('promotes background activity ahead of completed-turn ready placement', () => {
        const nowMs = 1_000_000;
        const source = [
            { type: 'session', serverId: 'server-a', sessionId: 'fresh-runtime', groupKey: 'project-a', groupKind: 'project' },
        ] satisfies ReadonlyArray<SessionListIndexItem>;

        const result = buildSessionListWorkingPlacement({
            source,
            options: { mode: 'global' },
            nowMs,
            resolveSessionRow: () => createRow({
                id: 'fresh-runtime',
                latestTurnStatusObservedAt: nowMs - 10_000,
                runtimeActivityState: 'active',
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: nowMs - 1_000,
                runtimeActivityRevision: nowMs + 60_000,
            }),
        });

        expect(result).toMatchObject({
            promotedCount: 1,
            workingItems: [
                expect.objectContaining({ type: 'header', headerKind: 'working' }),
                expect.objectContaining({
                    type: 'session',
                    sessionId: 'fresh-runtime',
                    groupKind: 'working',
                    workingPlacementReason: 'working',
                }),
            ],
            remainder: [],
        });
    });

});

describe('unread attention placement', () => {
    const nowMs = 1_000_000;

    function createSource(sessionIds: ReadonlyArray<string>): ReadonlyArray<SessionListIndexItem> {
        return sessionIds.map((sessionId) => ({
            type: 'session',
            serverId: 'server-a',
            sessionId,
            groupKey: 'project-a',
            groupKind: 'project',
        })) satisfies ReadonlyArray<SessionListIndexItem>;
    }

    it('promotes unread activity that never produced a terminal turn', () => {
        const source = createSource(['unread-provider-activity']);

        const result = buildSessionListAttentionPlacement({
            source,
            options: { mode: 'global' },
            nowMs,
            resolveSessionRow: () => createRow({
                id: 'unread-provider-activity',
                latestTurnStatus: undefined,
                latestTurnStatusObservedAt: undefined,
                seq: 12,
                lastViewedSessionSeq: 12,
                hasUnreadMessages: true,
                meaningfulActivityAt: nowMs - 5_000,
            }),
        });

        expect(result).toMatchObject({
            promotedCount: 1,
            attentionItems: [
                expect.objectContaining({ type: 'header', headerKind: 'attention' }),
                expect.objectContaining({
                    type: 'session',
                    sessionId: 'unread-provider-activity',
                    groupKind: 'attention',
                    attentionPlacementReason: 'unread',
                }),
            ],
            remainder: [],
        });
    });

    it('does not promote a released shared-recipient row from the owner legacy cursor', () => {
        const source = createSource(['legacy-shared-recipient']);
        const result = buildSessionListAttentionPlacement({
            source,
            options: { mode: 'global' },
            nowMs,
            resolveSessionRow: () => createRow({
                id: 'legacy-shared-recipient',
                seq: 8,
                lastViewedSessionSeq: 2,
                hasUnreadMessages: true,
                unreadSince: nowMs - 2_000,
                accessLevel: 'view',
                metadata: {
                    path: '/repo',
                    host: 'host',
                    readStateV1: { v: 1, sessionSeq: 2, pendingActivityAt: 0, updatedAt: 1 },
                },
                latestTurnStatus: undefined,
                latestTurnStatusObservedAt: undefined,
            }),
        });

        expect(result).toBeNull();
    });

    it('marks unread activity within its own group without moving it out', () => {
        const source = createSource(['read-neighbour', 'unread-provider-activity']);

        const result = applySessionListAttentionPlacementWithinGroups({
            source,
            options: { mode: 'withinGroups' },
            nowMs,
            resolveSessionRow: (_serverId, sessionId) => createRow({
                id: sessionId,
                latestTurnStatus: undefined,
                latestTurnStatusObservedAt: undefined,
                seq: 12,
                lastViewedSessionSeq: 12,
                hasUnreadMessages: sessionId === 'unread-provider-activity',
                meaningfulActivityAt: nowMs - 5_000,
            }),
        });

        expect(result.map((item) => (item.type === 'session'
            ? {
                sessionId: item.sessionId,
                groupKey: item.groupKey,
                attentionPlacementReason: item.attentionPlacementReason ?? null,
                keepVisibleWhenInactive: item.keepVisibleWhenInactive ?? false,
            }
            : item))).toEqual([
            {
                sessionId: 'unread-provider-activity',
                groupKey: 'project-a',
                attentionPlacementReason: 'unread',
                keepVisibleWhenInactive: true,
            },
            {
                sessionId: 'read-neighbour',
                groupKey: 'project-a',
                attentionPlacementReason: null,
                keepVisibleWhenInactive: false,
            },
        ]);
    });

    it('keeps a working session with unread activity in the working lane', () => {
        const source = createSource(['working-and-unread']);
        const resolveSessionRow = () => createRow({
            id: 'working-and-unread',
            latestTurnStatus: undefined,
            latestTurnStatusObservedAt: undefined,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 1_000,
            runtimeActivityRevision: nowMs + 60_000,
            seq: 12,
            lastViewedSessionSeq: 4,
            hasUnreadMessages: true,
            meaningfulActivityAt: nowMs - 1_000,
        });

        expect(buildSessionListAttentionPlacement({
            source,
            options: { mode: 'global' },
            nowMs,
            resolveSessionRow,
        })).toBeNull();
        expect(buildSessionListWorkingPlacement({
            source,
            options: { mode: 'global' },
            nowMs,
            resolveSessionRow,
        })).toMatchObject({
            promotedCount: 1,
            workingItems: [
                expect.objectContaining({ type: 'header', headerKind: 'working' }),
                expect.objectContaining({
                    type: 'session',
                    sessionId: 'working-and-unread',
                    groupKind: 'working',
                    workingPlacementReason: 'working',
                }),
            ],
        });
    });

    it('keeps ready precedence for a row that is both ready and unread', () => {
        const source = createSource(['ready-and-unread']);

        const result = buildSessionListAttentionPlacement({
            source,
            options: { mode: 'global' },
            nowMs,
            resolveSessionRow: () => createRow({
                id: 'ready-and-unread',
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: nowMs - 10_000,
                latestReadyEventAt: nowMs - 10_000,
                seq: 9,
                lastViewedSessionSeq: 4,
                hasUnreadMessages: true,
                meaningfulActivityAt: nowMs - 10_500,
            }),
        });

        expect(result?.attentionItems[1]).toEqual(expect.objectContaining({
            sessionId: 'ready-and-unread',
            attentionPlacementReason: 'ready',
        }));
    });

    it('orders unread below every explicit attention signal', () => {
        const source = createSource(['recently-unread', 'older-blocked']);

        const result = buildSessionListAttentionPlacement({
            source,
            options: { mode: 'global' },
            nowMs,
            resolveSessionRow: (_serverId, sessionId) => (sessionId === 'older-blocked'
                ? createRow({
                    id: 'older-blocked',
                    latestTurnStatus: undefined,
                    latestTurnStatusObservedAt: undefined,
                    pendingBlockedCount: 1,
                    pendingRequestObservedAt: nowMs - 600_000,
                    meaningfulActivityAt: nowMs - 600_000,
                })
                : createRow({
                    id: 'recently-unread',
                    latestTurnStatus: undefined,
                    latestTurnStatusObservedAt: undefined,
                    seq: 12,
                    lastViewedSessionSeq: 12,
                    hasUnreadMessages: true,
                    meaningfulActivityAt: nowMs - 1_000,
                })),
        });

        expect(result?.attentionItems.map((item) => (item.type === 'session' ? item.sessionId : item.type === 'header' ? item.headerKind : `run:${item.runId}`))).toEqual([
            'attention',
            'older-blocked',
            'recently-unread',
        ]);
    });

    it('orders operational attention with the canonical failed then permission then action precedence', () => {
        const source = createSource(['action', 'permission', 'failed']);
        const result = buildSessionListAttentionPlacement({
            source,
            options: { mode: 'global' },
            nowMs,
            resolveSessionRow: (_serverId, sessionId) => createRow({
                id: sessionId,
                ...(sessionId === 'failed' ? {
                    latestTurnStatus: 'failed' as const,
                    latestTurnStatusObservedAt: nowMs - 3_000,
                } : {
                    latestTurnStatus: undefined,
                    latestTurnStatusObservedAt: undefined,
                    pendingRequestObservedAt: nowMs - 1_000,
                    hasPendingPermissionRequests: sessionId === 'permission',
                    hasPendingUserActionRequests: sessionId === 'action',
                }),
            }),
        });

        expect(result?.attentionItems.map((item) => (
            item.type === 'session' ? item.sessionId : item.type === 'header' ? item.headerKind : `run:${item.runId}`
        ))).toEqual(['attention', 'failed', 'permission', 'action']);
    });

    it('orders two unread rows by their activity time, not their source order', () => {
        const source = createSource(['older-unread', 'newer-unread']);

        const result = buildSessionListAttentionPlacement({
            source,
            options: { mode: 'global' },
            nowMs,
            resolveSessionRow: (_serverId, sessionId) => createRow({
                id: sessionId,
                latestTurnStatus: undefined,
                latestTurnStatusObservedAt: undefined,
                seq: 12,
                lastViewedSessionSeq: 12,
                hasUnreadMessages: true,
                meaningfulActivityAt: sessionId === 'newer-unread' ? nowMs - 1_000 : nowMs - 500_000,
            }),
        });

        expect(result?.attentionItems.map((item) => (item.type === 'session' ? item.sessionId : item.type === 'header' ? item.headerKind : `run:${item.runId}`))).toEqual([
            'attention',
            'newer-unread',
            'older-unread',
        ]);
    });

    it('uses the canonical viewer decision instead of promoting a modern quiet row from raw facts', () => {
        const source = createSource(['quiet-modern']);
        const result = buildSessionListAttentionPlacement({
            source,
            options: { mode: 'global' },
            nowMs,
            resolveSessionRow: () => createRow({
                id: 'quiet-modern',
                seq: 20,
                lastViewedSessionSeq: 0,
                hasUnreadMessages: true,
                pendingBlockedCount: 1,
                viewer: {
                    readState: { state: 'not_started' },
                    relevance: { relevant: false, reasons: [] },
                    follow: { follows: false, notificationLevel: null },
                    notification: { level: 'none', source: 'none' },
                    attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
                },
            }),
        });

        expect(result).toBeNull();
    });

    it('does not treat an absent pre-viewer cursor as zero for completed-turn placement', () => {
        const source = createSource(['legacy-without-cursor']);
        const result = buildSessionListAttentionPlacement({
            source,
            options: { mode: 'global' },
            nowMs,
            resolveSessionRow: () => createRow({
                id: 'legacy-without-cursor',
                seq: 20,
                lastViewedSessionSeq: undefined,
                hasUnreadMessages: false,
                latestTurnStatus: 'completed',
                lastTurnCompletedAt: nowMs - 1_000,
                meaningfulActivityAt: nowMs - 1_000,
            }),
        });

        expect(result).toBeNull();
    });

    it('orders modern unread rows by stable viewer unreadSince instead of changing activity time', () => {
        const source = createSource(['older-entry-new-activity', 'newer-entry-old-activity']);
        const result = buildSessionListAttentionPlacement({
            source,
            options: { mode: 'global' },
            nowMs,
            resolveSessionRow: (_serverId, sessionId) => createRow({
                id: sessionId,
                meaningfulActivityAt: sessionId === 'older-entry-new-activity' ? nowMs - 100 : nowMs - 500_000,
                viewer: {
                    readState: {
                        state: 'tracking',
                        lastViewedSessionSeq: 0,
                        unreadSince: sessionId === 'older-entry-new-activity' ? 100 : 200,
                    },
                    relevance: { relevant: true, reasons: ['followed_by_me'] },
                    follow: { follows: true, notificationLevel: 'none' },
                    notification: { level: 'none', source: 'preference' },
                    attention: { needsAttention: true, reasons: ['unread'], primary: 'unread', presentation: 'full' },
                },
            }),
        });

        expect(result?.attentionItems.map((item) => (item.type === 'session' ? item.sessionId : item.type === 'header' ? item.headerKind : `run:${item.runId}`))).toEqual([
            'attention',
            'newer-entry-old-activity',
            'older-entry-new-activity',
        ]);
    });

    it('places a mention above plain unread in the attention lane instead of flattening it', () => {
        const source = createSource(['mentions-me', 'merely-unread']);
        const result = buildSessionListAttentionPlacement({
            source,
            options: { mode: 'global' },
            nowMs,
            resolveSessionRow: (_serverId, sessionId) => createRow({
                id: sessionId,
                viewer: {
                    readState: { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: 100 },
                    relevance: { relevant: true, reasons: ['followed_by_me'] },
                    follow: { follows: true, notificationLevel: 'none' },
                    notification: { level: 'none', source: 'preference' },
                    attention: sessionId === 'mentions-me'
                        ? { needsAttention: true, reasons: ['mentioned'], primary: 'mentioned', presentation: 'full' }
                        : { needsAttention: true, reasons: ['unread'], primary: 'unread', presentation: 'full' },
                },
            }),
        });

        expect(result?.attentionItems.map((item) => (
            item.type === 'session' ? item.attentionPlacementReason : item.type === 'header' ? item.headerKind : `run:${item.runId}`
        ))).toEqual(['attention', 'mentioned', 'unread']);
    });

    it('holds the read selected row with the neutral reason instead of replaying the one it resolved', () => {
        const source = createSource(['selected-now-read']);

        const result = buildSessionListAttentionPlacement({
            source,
            options: {
                mode: 'global',
                retainPlacements: [{ key: sessionAddressKey({ serverId: 'server-a', sessionId: 'selected-now-read' }), reason: 'unread', timestamp: 0 }],
            },
            nowMs,
            resolveSessionRow: () => createRow({
                id: 'selected-now-read',
                latestTurnStatus: undefined,
                latestTurnStatusObservedAt: undefined,
                seq: 12,
                lastViewedSessionSeq: 12,
                hasUnreadMessages: false,
                meaningfulActivityAt: nowMs - 5_000,
            }),
        });

        // The row keeps its place in the band, but a reason it no longer earns
        // must not come back with it: `attentionPlacementReason` is what the row
        // renders its permission and action affordances from.
        expect(result?.attentionItems[1]).toEqual(expect.objectContaining({
            sessionId: 'selected-now-read',
            attentionPlacementReason: 'ready',
        }));
    });

    // Standing is the band's FLOOR and must not pre-empt retention. Retention
    // relied on an opened row having no live reason left; the floor supplies
    // one, so without this the kept row drops to the bottom of the band under
    // the reader instead of holding its place until they navigate away.
    it('holds a kept read row with the neutral reason instead of dropping it to the standing floor', () => {
        const source = createSource(['selected-now-read']);
        const standingPolicy = {
            defaultStanding: false,
            overridesBySessionKey: {
                [sessionAddressKey({ serverId: 'server-a', sessionId: 'selected-now-read' })]: true,
            },
        };
        const resolveRow = () => createRow({
            id: 'selected-now-read',
            latestTurnStatus: undefined,
            latestTurnStatusObservedAt: undefined,
            seq: 12,
            lastViewedSessionSeq: 12,
            hasUnreadMessages: false,
            meaningfulActivityAt: nowMs - 5_000,
        });

        const retained = buildSessionListAttentionPlacement({
            source,
            options: {
                mode: 'global',
                standingPolicy,
                retainPlacements: [{ key: sessionAddressKey({ serverId: 'server-a', sessionId: 'selected-now-read' }), reason: 'unread', timestamp: 0 }],
            },
            nowMs,
            resolveSessionRow: resolveRow,
        });
        expect(retained?.attentionItems[1]).toEqual(expect.objectContaining({
            sessionId: 'selected-now-read',
            attentionPlacementReason: 'ready',
        }));

        // Navigating away releases retention, and only then does the floor take
        // over and sort the row behind every earned reason.
        const released = buildSessionListAttentionPlacement({
            source,
            options: { mode: 'global', standingPolicy },
            nowMs,
            resolveSessionRow: resolveRow,
        });
        expect(released?.attentionItems[1]).toEqual(expect.objectContaining({
            sessionId: 'selected-now-read',
            attentionPlacementReason: 'standing',
        }));
    });
});
