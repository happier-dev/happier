import { describe, expect, it } from 'vitest';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { computeVisibleSessionListProjection } from './computeVisibleSessionListIndex';

describe('coordinator query context', () => {
    it.each(['work', 'space'] as const)('nests server-admitted workers under coordinators without rechecking query membership (%s)', (surface) => {
        const rows = new Map([
            ['lead', createSessionListRenderableSessionFixture({ id: 'lead', ownerAccountId: 'me',
                managedSessions: { total: 2, working: 2, needsYou: 0, stalled: 0, finished: 0, attentionPrimary: null }, receivedRuleCount: 0 })],
            ...['first', 'second'].map(id => [id, createSessionListRenderableSessionFixture({ id, ownerAccountId: 'me',
                manager: { sessionId: 'lead' }, managedSessions: null, receivedRuleCount: 0 })] as const),
        ]);
        const params = { source: [...rows.keys()].map(sessionId => ({ type: 'session' as const, serverId: 'home', sessionId })),
            resolveSessionRow: (_home: string | null | undefined, id: string) => rows.get(id) ?? null,
            viewerAccountIdByServerId: new Map([['home', 'me']]), hideInactiveSessions: false,
            pinnedSessionKeysV1: [], sessionListGroupOrderV1: {}, nowMs: 20,
            presentation: { enabled: false, presentation: 'grouped' as const },
            workFilter: normalizeSessionListFilterV1({ scope: 'all_accessible', homeServerIds: ['home'],
                startedBy: ['you', 'triggers', 'agents'], ...(surface === 'work' ? { coordinator: 'coordinator' as const } : {}) }),
            ...(surface === 'space' ? { spaceMembership: {
                filter: normalizeSessionListFilterV1({ scope: 'all_accessible', homeServerIds: ['home'],
                    startedBy: ['you', 'triggers', 'agents'], coordinator: 'coordinator' }),
                membership: { mode: 'filter_or_manual' as const, tags: [] },
            } } : {}) };
        const result = computeVisibleSessionListProjection(params);
        expect(result.items?.filter(item => item.type === 'session').map(item => ({
            id: item.sessionId, depth: item.reportsDepth ?? 0,
        }))).toEqual([{ id: 'lead', depth: 0 }, { id: 'first', depth: 1 }, { id: 'second', depth: 1 }]);
        expect(result.filterResult.matchedCount).toBe(3);
    });
});
