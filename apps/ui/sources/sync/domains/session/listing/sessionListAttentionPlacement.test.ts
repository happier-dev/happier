import { describe, expect, it } from 'vitest';
import { createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from './sessionListRenderable';
import { sessionAddressKey } from '../sessionAddress';
import {
    buildSessionListAttentionPlacement,
    buildSessionListGlobalPlacements,
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
        encryptionMode: 'plain',
        metadata: { path: '/repo' },
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        latestTurnStatus: 'completed',
        latestTurnStatusObservedAt: 1,
        ...overrides,
    };
}

describe('canonical attention occurrences', () => {
    const nowMs = 1_000_000;
    const sourceFor = (...ids: string[]): SessionListIndexItem[] => ids.map(sessionId => ({
        type: 'session', serverId: 'server-a', sessionId, groupKey: 'project-a', groupKind: 'project',
    }));
    const ids = (items: readonly SessionListIndexItem[] | undefined) => items?.flatMap(item => item.type === 'session' ? [item.sessionId] : []);
    const key = (sessionId: string) => sessionAddressKey({ serverId: 'server-a', sessionId });
    const rows = new Map<string, SessionListRenderableSession>();

    it('keeps failed updates outside Needs you and retains a simultaneous admitted approval', () => {
        rows.clear();
        const source = sourceFor('failure');
        const failed = createRow({ id: 'failure', latestTurnStatus: 'failed', active: true, hasUnreadMessages: true });
        rows.set('failure', failed);
        expect(build(source, 'both')?.attentionItems ?? []).toEqual([]);

        rows.set('failure', { ...failed, viewer: createSessionViewerFixture({ attention: {
            needsAttention: true, reasons: ['failed'], primary: 'failed', presentation: 'full',
        } }) });
        expect(build(source, 'both')?.attentionItems ?? []).toEqual([]);

        rows.set('failure', { ...failed, viewer: createSessionViewerFixture({ attention: {
            needsAttention: true, reasons: ['failed', 'permission_required'], primary: 'failed', presentation: 'full',
        } }) });
        const admitted = build(source, 'both')?.attentionItems.filter(item => item.type === 'session');
        expect(admitted).toEqual([expect.objectContaining({ sessionId: 'failure', attentionPlacementReason: 'permission_required' })]);
    });
    function attention(id: string, pending = false) {
        rows.set(id, createRow({ id, latestTurnStatus: undefined, hasUnreadMessages: !pending,
            hasPendingPermissionRequests: pending, pendingRequestObservedAt: pending ? nowMs : null,
            viewer: createSessionViewerFixture({ attention: {
                needsAttention: true,
                reasons: [pending ? 'permission_required' : 'user_action_required'],
                primary: pending ? 'permission_required' : 'user_action_required', presentation: 'full',
            } }),
        }));
    }
    function build(source: readonly SessionListIndexItem[], placement: 'both' | 'top' | 'inPlace', previousPresentedIndex?: readonly SessionListIndexItem[], holdMembership = false) {
        return buildSessionListGlobalPlacements({ source, placement, previousPresentedIndex, holdMembership,
            attentionOptions: { mode: 'global' }, workingOptions: { mode: 'global' }, nowMs,
            resolveSessionRow: (_server, id) => rows.get(id) ?? null });
    }

    it('mirrors in Both, suppresses only childless Top bases, and has no shelf In place', () => {
        rows.clear(); attention('lead'); attention('child');
        const source = sourceFor('lead', 'child');
        source[0] = { ...source[0]!, type: 'session', sessionId: 'lead', reportsParent: true };
        source[1] = { ...source[1]!, type: 'session', sessionId: 'child', reportsDepth: 1,
            reportsParentContext: { serverId: 'home', project: null, machineId: 'lead-machine', workspaceId: 'lead-checkout' } };
        expect(ids(build(source, 'both')?.remainder)).toEqual(['lead', 'child']);
        expect(ids(build(source, 'top')?.remainder)).toEqual(['lead']);
        expect(build(source, 'both')?.attentionItems[1]).toMatchObject({ occurrenceRole: 'needsYou' });
        expect(build(source, 'both')?.attentionItems.filter(item => item.type === 'session'))
            .toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: 'child', reportsParentContext: undefined })]));
        expect(build(source, 'inPlace')).toBeNull();
    });

    it('appends arrivals without severity ranking and retains the presented order on subsequent changes', () => {
        rows.clear(); attention('first'); attention('urgent', true); attention('new');
        const first = build(sourceFor('first', 'urgent'), 'both')!;
        expect(ids(first.attentionItems)).toEqual(['first', 'urgent']);
        const next = build(sourceFor('new', 'urgent', 'first'), 'both', first.attentionItems)!;
        expect(ids(next.attentionItems)).toEqual(['first', 'urgent', 'new']);
    });

    it('keeps placement facts identical when request activity changes without changing eligibility', () => {
        rows.clear(); attention('steady');
        const source = sourceFor('steady');
        const first = build(source, 'both')!;
        rows.set('steady', { ...rows.get('steady')!, pendingRequestObservedAt: nowMs });
        const next = build(source, 'both', first.attentionItems)!;
        expect(next.attentionItems).toEqual(first.attentionItems);
    });

    it('holds membership with live facts, reconciles on release, and removes revoked rows immediately', () => {
        rows.clear(); attention('old'); attention('arriving', true);
        const initial = build(sourceFor('old'), 'both')!;
        rows.set('old', createRow({ id: 'old', latestTurnStatus: undefined }));
        const held = build(sourceFor('arriving', 'old'), 'both', initial.attentionItems, true)!;
        expect(ids(held.attentionItems)).toEqual(['old']);
        const heldRow = held.attentionItems.find(item => item.type === 'session');
        expect(heldRow?.type === 'session' ? heldRow.attentionPlacementReason : null).toBeUndefined();
        expect(ids(build(sourceFor('arriving', 'old'), 'both', held.attentionItems)?.attentionItems)).toEqual(['arriving']);
        expect(build(sourceFor('arriving'), 'both', initial.attentionItems, true)).toBeNull();
    });

    it.each(['both', 'top'] as const)('does not leak the first outside shortcut into a held %s base', placement => {
        rows.clear(); attention('outside', true);
        rows.set('inside', createRow({ id: 'inside', latestTurnStatus: undefined }));
        const result = buildSessionListGlobalPlacements({
            source: sourceFor('inside', 'outside'), placement,
            previousPresentedIndex: sourceFor('inside'), holdMembership: true,
            supplementalNeedsYouSessionKeys: new Set([key('outside')]),
            attentionOptions: { mode: 'global' }, workingOptions: { mode: 'global' }, nowMs,
            resolveSessionRow: (_server, id) => rows.get(id) ?? null,
        });
        expect(result?.attentionItems).toEqual([]);
        expect(result?.attentionEligibleCount).toBe(1);
        expect(ids(result?.remainder)).toEqual(['inside']);
    });

    it('keeps a held Working occurrence while its permission glyph changes, then moves it on release', () => {
        rows.clear(); rows.set('work', createRow({ id: 'work', latestTurnStatus: 'in_progress', activeAt: nowMs, thinking: true }));
        const initial = build(sourceFor('work'), 'both')!;
        attention('work', true);
        const held = build(sourceFor('work'), 'both', initial.workingItems, true)!;
        expect(ids(held.workingItems)).toEqual(['work']);
        expect(ids(held.attentionItems)).toEqual([]);
        expect(ids(build(sourceFor('work'), 'both', held.workingItems)?.attentionItems)).toEqual(['work']);
    });

    it('resolves each admitted row once without reading private project or detail data at scale', () => {
        const source = sourceFor(...Array.from({ length: 1_000 }, (_, index) => `session-${index}`));
        let reads = 0;
        buildSessionListGlobalPlacements({ source, placement: 'both', attentionOptions: { mode: 'global' },
            workingOptions: { mode: 'global' }, nowMs, resolveSessionRow: (_server, id) => {
                reads += 1; return createRow({ id, latestTurnStatus: undefined, hasUnreadMessages: key(id) === key('session-0') });
            } });
        expect(reads).toBe(1_000);
    });
});

describe('working eligibility', () => {
    it('places completed background activity at the front of its group', () => {
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

        expect(result?.workingItems.filter(item => item.type === 'session')).toEqual([
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

        const result = buildSessionListWorkingPlacement({
            source,
            options: { mode: 'global' },
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

        expect(result?.workingItems.filter(item => item.type === 'session')).toEqual([
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

        const result = buildSessionListWorkingPlacement({
            source,
            options: { mode: 'global' },
            nowMs,
            resolveSessionRow: () => createRow({
                id: 'inactive-runtime',
                runtimeActivityState: 'active',
                runtimeActivityActiveCount: 1,
                runtimeActivityRevision: 1,
                ...overrides,
            }),
        });

        expect(result).toBeNull();
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

describe('canonical Needs-you admission', () => {
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

    it('keeps unread activity in Updates rather than inventing a Needs-you request', () => {
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

        expect(result).toBeNull();
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

    it('keeps an unread background session working by default', () => {
        const source = createSource(['working-and-unread']);
        const resolveSessionRow = () => createRow({
            id: 'working-and-unread', latestTurnStatus: undefined,
            runtimeActivityState: 'active', runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 1_000, runtimeActivityRevision: 1,
            seq: 12, lastViewedSessionSeq: 4, hasUnreadMessages: true,
        });
        expect(buildSessionListAttentionPlacement({ source, options: { mode: 'global' }, nowMs, resolveSessionRow })).toBeNull();
        expect(buildSessionListWorkingPlacement({ source, options: { mode: 'global' }, nowMs, resolveSessionRow })?.promotedCount).toBe(1);
    });

    it('does not promote completed unread work as a Needs-you request', () => {
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

        expect(result).toBeNull();
    });

    it('configures unread completion placement without claiming continuing work is ready', () => {
        const source = createSource(['ready-over-background']);
        const row = createRow({
            id: 'ready-over-background',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 10_000,
            latestReadyEventAt: nowMs - 10_000,
            seq: 9,
            lastViewedSessionSeq: 4,
            meaningfulActivityAt: nowMs - 10_500,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 1_000,
            runtimeActivityRevision: 1,
        });

        for (const backgroundWorkAttentionMode of ['keepWorking', 'keepWorkingUnread', 'showUnread'] as const) {
            const params = { source, options: { mode: 'global' as const }, nowMs, resolveSessionRow: () => row, backgroundWorkAttentionMode };
            const attention = buildSessionListAttentionPlacement(params);
            expect(attention).toBeNull();
            expect(buildSessionListWorkingPlacement(params)?.promotedCount ?? 0).toBe(1);
        }

        const read = { ...row, lastViewedSessionSeq: 9 };
        expect(buildSessionListAttentionPlacement({
            source, options: { mode: 'global' }, nowMs, resolveSessionRow: () => read,
        })).toBeNull();
        expect(buildSessionListWorkingPlacement({
            source, options: { mode: 'global' }, nowMs, resolveSessionRow: () => read,
        })?.promotedCount).toBe(1);
    });

    it('does not infer readiness from a disconnected runtime with reported background work', () => {
        const source = createSource(['disconnected-background']);
        const row = createRow({
            id: 'disconnected-background', active: false, presence: 0,
            latestTurnStatus: 'completed', latestTurnStatusObservedAt: nowMs - 10_000,
            meaningfulActivityAt: nowMs - 10_500, seq: 9, lastViewedSessionSeq: 4,
            runtimeActivityState: 'active', runtimeActivityActiveCount: 1,
        });
        const params = { source, options: { mode: 'global' as const }, nowMs, resolveSessionRow: () => row };
        expect(buildSessionListAttentionPlacement(params)).toBeNull();
        expect(buildSessionListWorkingPlacement(params)).toBeNull();
    });

    it('configures background placement using authoritative modern unread facts', () => {
        const source = createSource(['modern-unread-background']);
        const viewer = (needsAttention: boolean) => createSessionViewerFixture({
            latestFailureSeq: null,
            readState: { state: 'tracking' as const, lastViewedSessionSeq: 0, unreadSince: 100 },
            relevance: { relevant: true, reasons: ['followed_by_me' as const] },
            follow: { follows: true, notificationLevel: 'none' as const },
            notification: { level: 'none' as const, source: 'preference' as const },
            attention: needsAttention
                ? { needsAttention: true, reasons: ['unread' as const], primary: 'unread' as const, presentation: 'full' as const }
                : { needsAttention: false, reasons: [], primary: null, presentation: 'full' as const },
        });
        const row = (needsAttention: boolean) => createRow({
            id: 'modern-unread-background',
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 1_000,
            runtimeActivityRevision: 1,
            viewer: viewer(needsAttention),
        });

        for (const backgroundWorkAttentionMode of ['keepWorking', 'keepWorkingUnread', 'showUnread'] as const) {
            const params = { source, options: { mode: 'global' as const }, nowMs, resolveSessionRow: () => row(true), backgroundWorkAttentionMode };
            const attention = buildSessionListAttentionPlacement(params);
            expect(attention).toBeNull();
            expect(buildSessionListWorkingPlacement(params)?.promotedCount ?? 0).toBe(1);
        }
        expect(buildSessionListAttentionPlacement({
            source, options: { mode: 'global' }, nowMs, resolveSessionRow: () => row(false),
        })).toBeNull();
        expect(buildSessionListWorkingPlacement({
            source, options: { mode: 'global' }, nowMs, resolveSessionRow: () => row(false),
        })?.promotedCount).toBe(1);
    });

    it('keeps modern manual standing below background work and restores it when work settles', () => {
        const source = createSource(['modern-standing-background']);
        const row = (backgroundActive: boolean) => createRow({
            id: 'modern-standing-background',
            runtimeActivityState: backgroundActive ? 'active' : 'idle',
            runtimeActivityActiveCount: backgroundActive ? 1 : 0,
            runtimeActivityObservedAt: nowMs - 1_000,
            runtimeActivityRevision: 1,
            viewer: createSessionViewerFixture({
                latestFailureSeq: null,
                readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null },
                relevance: { relevant: true, reasons: ['followed_by_me'] },
                follow: { follows: true, notificationLevel: 'none' },
                notification: { level: 'none', source: 'preference' },
                attention: { needsAttention: true, reasons: ['manual'], primary: 'manual', presentation: 'full' },
            }),
        });

        expect(buildSessionListAttentionPlacement({
            source, options: { mode: 'global', standingPolicy: {
                defaultStanding: false, overridesBySessionKey: { [sessionAddressKey({ serverId: 'server-a', sessionId: 'modern-standing-background' })]: true },
            } }, nowMs, resolveSessionRow: () => row(true),
        })).toBeNull();
        expect(buildSessionListWorkingPlacement({
            source, options: { mode: 'global' }, nowMs, resolveSessionRow: () => row(true),
        })?.promotedCount).toBe(1);
        expect(buildSessionListAttentionPlacement({
            source, options: { mode: 'global', standingPolicy: {
                defaultStanding: false, overridesBySessionKey: { [sessionAddressKey({ serverId: 'server-a', sessionId: 'modern-standing-background' })]: true },
            } }, nowMs, resolveSessionRow: () => row(false),
        })?.attentionItems[1]).toEqual(expect.objectContaining({
            sessionId: 'modern-standing-background',
            attentionPlacementReason: 'standing',
        }));
    });

    it('does not admit an unread update alongside a blocked delivery', () => {
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
        ]);
    });

    it('keeps operational attention in traversal order regardless of severity', () => {
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
        ))).toEqual(['attention', 'action', 'permission']);
    });

    it('does not promote unread Updates regardless of activity time', () => {
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

        expect(result).toBeNull();
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
                viewer: createSessionViewerFixture({
                    latestFailureSeq: null,
                    readState: { state: 'not_started' },
                    relevance: { relevant: false, reasons: [] },
                    follow: { follows: false, notificationLevel: null },
                    notification: { level: 'none', source: 'none' },
                    attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
                }),
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

    it('does not promote modern unread Updates regardless of unreadSince', () => {
        const source = createSource(['older-entry-new-activity', 'newer-entry-old-activity']);
        const result = buildSessionListAttentionPlacement({
            source,
            options: { mode: 'global' },
            nowMs,
            resolveSessionRow: (_serverId, sessionId) => createRow({
                id: sessionId,
                meaningfulActivityAt: sessionId === 'older-entry-new-activity' ? nowMs - 100 : nowMs - 500_000,
                viewer: createSessionViewerFixture({
                    latestFailureSeq: null,
                    readState: {
                        state: 'tracking',
                        lastViewedSessionSeq: 0,
                        unreadSince: sessionId === 'older-entry-new-activity' ? 100 : 200,
                    },
                    relevance: { relevant: true, reasons: ['followed_by_me'] },
                    follow: { follows: true, notificationLevel: 'none' },
                    notification: { level: 'none', source: 'preference' },
                    attention: { needsAttention: true, reasons: ['unread'], primary: 'unread', presentation: 'full' },
                }),
            }),
        });

        expect(result).toBeNull();
    });

    it('keeps mentions and plain unread in Updates rather than Needs you', () => {
        const source = createSource(['mentions-me', 'merely-unread']);
        const result = buildSessionListAttentionPlacement({
            source,
            options: { mode: 'global' },
            nowMs,
            resolveSessionRow: (_serverId, sessionId) => createRow({
                id: sessionId,
                viewer: createSessionViewerFixture({
                    latestFailureSeq: null,
                    readState: { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: 100 },
                    relevance: { relevant: true, reasons: ['followed_by_me'] },
                    follow: { follows: true, notificationLevel: 'none' },
                    notification: { level: 'none', source: 'preference' },
                    attention: sessionId === 'mentions-me'
                        ? { needsAttention: true, reasons: ['mentioned'], primary: 'mentioned', presentation: 'full' }
                        : { needsAttention: true, reasons: ['unread'], primary: 'unread', presentation: 'full' },
                }),
            }),
        });

        expect(result).toBeNull();
    });

});
