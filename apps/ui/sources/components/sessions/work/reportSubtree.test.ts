import { describe, expect, it } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { selectSessionReportSubtree } from './reportSubtree';

describe('selectSessionReportSubtree', () => {
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
});
