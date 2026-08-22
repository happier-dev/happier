import { describe, expect, it } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionAttentionStandingPolicy } from '@/sync/domains/session/organization/attentionStanding';

import {
    applySessionListAttentionPlacementWithinGroups,
    buildSessionListAttentionPlacement,
    buildSessionListWorkingPlacement,
} from './sessionListAttentionPlacement';
import type { SessionListRenderableSession } from './sessionListRenderable';

const NOW_MS = 1_000_000;

function createRow(overrides: Partial<SessionListRenderableSession> = {}): SessionListRenderableSession {
    return {
        id: 'session',
        seq: 4,
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
        latestTurnStatus: 'completed',
        latestTurnStatusObservedAt: NOW_MS - 500_000,
        lastTurnCompletedAt: NOW_MS - 500_000,
        lastViewedSessionSeq: 4,
        hasUnreadMessages: false,
        meaningfulActivityAt: NOW_MS - 500_000,
        ...overrides,
    };
}

function createSource(sessionIds: ReadonlyArray<string>): ReadonlyArray<SessionListIndexItem> {
    return sessionIds.map((sessionId) => ({
        type: 'session',
        serverId: 'server-a',
        sessionId,
        groupKey: 'project-a',
        groupKind: 'project',
    })) satisfies ReadonlyArray<SessionListIndexItem>;
}

function policy(overrides: Readonly<{
    defaultStanding?: boolean;
    overridesBySessionKey?: Readonly<Record<string, boolean>>;
}> = {}): SessionAttentionStandingPolicy {
    return {
        defaultStanding: overrides.defaultStanding === true,
        overridesBySessionKey: overrides.overridesBySessionKey ?? {},
    };
}

describe('attention standing placement', () => {
    it('floors a read, idle session into the band with its own reason', () => {
        const result = buildSessionListAttentionPlacement({
            source: createSource(['kept']),
            options: {
                mode: 'global',
                standingPolicy: policy({ overridesBySessionKey: { 'server-a:kept': true } }),
            },
            nowMs: NOW_MS,
            resolveSessionRow: () => createRow({ id: 'kept' }),
        });

        expect(result?.attentionItems[1]).toEqual(expect.objectContaining({
            sessionId: 'kept',
            groupKind: 'attention',
            attentionPlacementReason: 'standing',
        }));
    });

    it('leaves a session alone when no standing applies', () => {
        expect(buildSessionListAttentionPlacement({
            source: createSource(['quiet']),
            options: { mode: 'global', standingPolicy: policy() },
            nowMs: NOW_MS,
            resolveSessionRow: () => createRow({ id: 'quiet' }),
        })).toBeNull();
    });

    it('lets an explicit removal beat a standing account default', () => {
        expect(buildSessionListAttentionPlacement({
            source: createSource(['removed']),
            options: {
                mode: 'global',
                standingPolicy: policy({
                    defaultStanding: true,
                    overridesBySessionKey: { 'server-a:removed': false },
                }),
            },
            nowMs: NOW_MS,
            resolveSessionRow: () => createRow({ id: 'removed' }),
        })).toBeNull();
    });

    it('never replaces an earned attention reason', () => {
        const result = buildSessionListAttentionPlacement({
            source: createSource(['unread-and-kept']),
            options: {
                mode: 'global',
                standingPolicy: policy({ defaultStanding: true }),
            },
            nowMs: NOW_MS,
            resolveSessionRow: () => createRow({
                id: 'unread-and-kept',
                hasUnreadMessages: true,
                seq: 12,
                lastViewedSessionSeq: 12,
                latestTurnStatus: undefined,
                latestTurnStatusObservedAt: undefined,
                lastTurnCompletedAt: undefined,
            }),
        });

        expect(result?.attentionItems[1]).toEqual(expect.objectContaining({
            sessionId: 'unread-and-kept',
            attentionPlacementReason: 'unread',
        }));
    });

    it('leaves a working session in the working lane', () => {
        const resolveSessionRow = () => createRow({
            id: 'working-and-kept',
            active: true,
            presence: 'online',
            latestTurnStatus: undefined,
            latestTurnStatusObservedAt: undefined,
            lastTurnCompletedAt: undefined,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: NOW_MS - 1_000,
            runtimeActivityRevision: NOW_MS + 60_000,
        });

        expect(buildSessionListAttentionPlacement({
            source: createSource(['working-and-kept']),
            options: { mode: 'global', standingPolicy: policy({ defaultStanding: true }) },
            nowMs: NOW_MS,
            resolveSessionRow,
        })).toBeNull();
        expect(buildSessionListWorkingPlacement({
            source: createSource(['working-and-kept']),
            options: { mode: 'global' },
            nowMs: NOW_MS,
            resolveSessionRow,
        })).toMatchObject({ promotedCount: 1 });
    });

    it('sorts standing behind every earned reason', () => {
        const result = buildSessionListAttentionPlacement({
            source: createSource(['kept', 'unread']),
            options: {
                mode: 'global',
                standingPolicy: policy({ overridesBySessionKey: { 'server-a:kept': true } }),
            },
            nowMs: NOW_MS,
            resolveSessionRow: (_serverId, sessionId) => (sessionId === 'unread'
                ? createRow({
                    id: 'unread',
                    hasUnreadMessages: true,
                    seq: 12,
                    lastViewedSessionSeq: 12,
                    latestTurnStatus: undefined,
                    latestTurnStatusObservedAt: undefined,
                    lastTurnCompletedAt: undefined,
                    meaningfulActivityAt: NOW_MS - 900_000,
                })
                : createRow({ id: 'kept' })),
        });

        expect(result?.attentionItems.map((item) => (item.type === 'session' ? item.sessionId : item.headerKind))).toEqual([
            'attention',
            'unread',
            'kept',
        ]);
    });

    it('exempts an explicitly kept session from hide-inactive but not a default-kept one', () => {
        const build = (standingPolicy: SessionAttentionStandingPolicy) => buildSessionListAttentionPlacement({
            source: createSource(['kept']),
            options: { mode: 'global', standingPolicy },
            nowMs: NOW_MS,
            resolveSessionRow: () => createRow({ id: 'kept' }),
        });

        expect(build(policy({ overridesBySessionKey: { 'server-a:kept': true } }))?.attentionItems[1])
            .toEqual(expect.objectContaining({ keepVisibleWhenInactive: true }));
        const defaultKept = build(policy({ defaultStanding: true }))?.attentionItems[1];
        expect(defaultKept).toEqual(expect.objectContaining({ attentionPlacementReason: 'standing' }));
        expect(defaultKept && defaultKept.type === 'session' ? defaultKept.keepVisibleWhenInactive : null)
            .not.toBe(true);
    });

    it('keeps the same floor and exemption rule within groups', () => {
        const [item] = applySessionListAttentionPlacementWithinGroups({
            source: createSource(['kept']),
            options: {
                mode: 'withinGroups',
                standingPolicy: policy({ defaultStanding: true }),
            },
            nowMs: NOW_MS,
            resolveSessionRow: () => createRow({ id: 'kept' }),
        });

        expect(item).toEqual(expect.objectContaining({ attentionPlacementReason: 'standing' }));
        expect(item && item.type === 'session' ? item.keepVisibleWhenInactive : null).not.toBe(true);
    });
});
