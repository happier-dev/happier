import { describe, expect, it } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from './sessionListRenderable';
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

        expect(result?.attentionItems.map((item) => (item.type === 'session' ? item.sessionId : item.headerKind))).toEqual([
            'attention',
            'older-blocked',
            'recently-unread',
        ]);
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

        expect(result?.attentionItems.map((item) => (item.type === 'session' ? item.sessionId : item.headerKind))).toEqual([
            'attention',
            'newer-unread',
            'older-unread',
        ]);
    });

    it('holds the read selected row with the neutral reason instead of replaying the one it resolved', () => {
        const source = createSource(['selected-now-read']);

        const result = buildSessionListAttentionPlacement({
            source,
            options: {
                mode: 'global',
                retainSessionKeys: ['server-a:selected-now-read'],
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
});
