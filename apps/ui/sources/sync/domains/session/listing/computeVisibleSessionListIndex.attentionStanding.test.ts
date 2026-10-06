import { describe, expect, it } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionAttentionStandingPolicy } from '@/sync/domains/session/organization/attentionStanding';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';

import { computeVisibleSessionListIndex } from './computeVisibleSessionListIndex';
import type { SessionListRenderableSession } from './sessionListRenderable';

const NOW_MS = 1_000_000;
const GROUP_KEY = 'server-a:inactive:project:repo';

function makeInactiveReadRow(id: string): SessionListRenderableSession {
    return {
        id,
        seq: 4,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 0,
        archivedAt: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 0,
        hasUnreadMessages: false,
        keepVisibleWhenInactive: false,
        latestTurnStatus: 'completed',
        latestTurnStatusObservedAt: NOW_MS - 500_000,
        lastTurnCompletedAt: NOW_MS - 500_000,
        lastViewedSessionSeq: 4,
        meaningfulActivityAt: NOW_MS - 500_000,
    };
}

function computeWithStanding(standingPolicy: SessionAttentionStandingPolicy): ReadonlyArray<SessionListIndexItem> | null {
    const source: SessionListIndexItem[] = [
        { type: 'header', headerKind: 'project', title: 'Repo', serverId: 'server-a', groupKey: GROUP_KEY },
        { type: 'session', sessionId: 'kept', serverId: 'server-a', section: 'inactive', groupKey: GROUP_KEY, groupKind: 'project' },
    ];
    return computeVisibleSessionListIndex({
        source,
        resolveSessionRow: (_serverId, sessionId) => makeInactiveReadRow(sessionId),
        hideInactiveSessions: true,
        pinnedSessionKeysV1: [],
        sessionListGroupOrderV1: {},
        sessionListOrderingModeV1: 'updated',
        attentionPlacement: { mode: 'global', standingPolicy },
        presentation: { enabled: false, presentation: 'grouped' },
        nowMs: NOW_MS,
    });
}

describe('computeVisibleSessionListIndex attention standing under hide-inactive', () => {
    it.each(['global', 'withinGroups'] as const)('preserves the position of an opened due reminder in %s placement until leaving', (mode) => {
        const key = buildSessionOrganizationSessionKey('server-a', 'reminded');
        const source = [
            { type: 'header', headerKind: 'project', title: 'Repo', serverId: 'server-a', groupKey: GROUP_KEY },
            ...['kept', 'reminded', 'unread', 'quiet'].map((sessionId) => ({
                type: 'session' as const, sessionId, serverId: 'server-a', section: 'inactive' as const,
                groupKey: GROUP_KEY, groupKind: 'project' as const,
            })),
        ] satisfies SessionListIndexItem[];
        const compute = (standingPolicy: SessionAttentionStandingPolicy, retainPlacements?: ReadonlyArray<{
            key: string; reason: 'standing'; timestamp: number;
        }>) => computeVisibleSessionListIndex({
            source,
            resolveSessionRow: (_serverId, sessionId) => ({
                ...makeInactiveReadRow(sessionId),
                ...(sessionId === 'unread' ? { seq: 5, hasUnreadMessages: true } : {}),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom',
            attentionPlacement: { mode, standingPolicy, retainPlacements },
            presentation: { enabled: false, presentation: 'grouped' },
            nowMs: NOW_MS,
        });
        const keptKey = buildSessionOrganizationSessionKey('server-a', 'kept');
        const afterPolicy = { defaultStanding: false, overridesBySessionKey: { [keptKey]: true } };
        const before = compute({ ...afterPolicy, overridesBySessionKey: {
            ...afterPolicy.overridesBySessionKey,
            [key]: { standing: false, remindAt: 1, updatedAt: 1 },
        } });
        const positions = (items: ReadonlyArray<SessionListIndexItem> | null) => items?.filter((item) => item.type === 'session')
            .map((item) => `${item.sessionId}:${item.attentionPlacementReason ? 'attention' : 'normal'}`);
        const retained = compute(afterPolicy, [{ key, reason: 'standing', timestamp: 0 }]);
        expect(positions(retained)).toEqual(positions(before));
        expect(retained?.find((item) => item.type === 'session' && item.sessionId === 'reminded'))
            .toHaveProperty('attentionPlacementReason', 'ready');
        expect(positions(compute(afterPolicy))).not.toEqual(positions(before));
    });

    it('keeps an explicitly kept inactive session visible in the band', () => {
        const result = computeWithStanding({
            defaultStanding: false,
            overridesBySessionKey: {
                [buildSessionOrganizationSessionKey('server-a', 'kept')]: { standing: true, updatedAt: 1 },
            },
        });

        expect(result?.map((item) => (item.type === 'session' ? `s:${item.sessionId}` : item.type === 'header' ? `h:${item.headerKind}` : `r:${item.runId}`)))
            .toEqual(['h:attention', 's:kept']);
    });

    it('hides an inactive session that stands only by the account default', () => {
        const result = computeWithStanding({
            defaultStanding: true,
            overridesBySessionKey: {},
        });

        expect(result?.some((item) => item.type === 'session')).toBe(false);
        expect(result?.some((item) => item.type === 'header' && item.headerKind === 'attention')).toBe(false);
    });
});
