import { describe, expect, it } from 'vitest';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { selectSessionReportSubtree } from './reportSubtree';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';

describe('selectSessionReportSubtree', () => {
    it('names unopened layout-v1 reports from the owner list projection', () => {
        const source = createSessionFixture({ id: 'child', reportsTo: { sessionId: 'lead' }, metadataLayoutVersion: 1,
            accessLevel: 'owner', metadata: null,
            ownerMetadataView: { name: 'Unopened report', path: '/repo', host: 'machine' } });
        const row = buildSessionListRenderableFromSession(source);
        const reports = selectSessionReportSubtree({}, 'lead', 'home-a', { 'home-a': { child: row } });
        expect(reports.map(session => getSessionName(session))).toEqual(['Unopened report']);
    });
    it('keeps the tree in its exact Home when lead and child ids collide across Homes', () => {
        const child = createSessionFixture({ id: 'child', serverId: 'home-a', reportsTo: { sessionId: 'lead' } });
        const grandchild = createSessionFixture({ id: 'grandchild', serverId: 'home-a', reportsTo: { sessionId: 'child' }, createdAt: 2 });
        const otherHome = createSessionFixture({ id: 'other', serverId: 'home-b', reportsTo: { sessionId: 'lead' } });
        const crossHomeDescendant = createSessionFixture({ id: 'cross', serverId: 'home-b', reportsTo: { sessionId: 'child' } });
        const unqualified = createSessionFixture({ id: 'unqualified', reportsTo: { sessionId: 'lead' } });
        const sessions = { child, grandchild, otherHome, crossHomeDescendant, unqualified };
        expect(selectSessionReportSubtree(sessions, 'lead', 'home-a')).toEqual([child, grandchild]);
        expect(selectSessionReportSubtree(sessions, 'lead', 'home-b')).toEqual([otherHome]);
        expect(selectSessionReportSubtree(sessions, 'lead', null)).toEqual([]);
    });

    it('includes unopened reports from the qualified list without borrowing another Home or a stale opened relation', () => {
        const child = createSessionListRenderableSessionFixture({ id: 'child', reportsTo: { sessionId: 'lead' } });
        const grandchild = createSessionListRenderableSessionFixture({ id: 'grandchild', reportsTo: { sessionId: 'child' }, createdAt: 2 });
        const detached = createSessionListRenderableSessionFixture({ id: 'detached', reportsTo: null });
        const state = {
            sessions: {
                child: createSessionFixture({ id: 'child', serverId: 'home-b', reportsTo: { sessionId: 'other' } }),
                detached: createSessionFixture({ id: 'detached', serverId: 'home-a', reportsTo: { sessionId: 'lead' } }),
            },
            sessionListRowsByServerId: { 'home-a': { child, grandchild, detached } },
        };
        const reports = selectSessionReportSubtree(state.sessions, 'lead', 'home-a', state.sessionListRowsByServerId);
        expect(reports.map((session) => [session.id, session.serverId, session.reportsTo?.sessionId]))
            .toEqual([['child', 'home-a', 'lead'], ['grandchild', 'home-a', 'child']]);
        const next = selectSessionReportSubtree({ ...state.sessions, unrelated: createSessionFixture({ id: 'unrelated', serverId: 'home-a' }) },
            'lead', 'home-a', state.sessionListRowsByServerId);
        expect(next[0]).toBe(reports[0]);
        expect(next[1]).toBe(reports[1]);
    });
});
