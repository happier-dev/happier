import { describe, expect, it } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import { nestSessionListReports } from './nestSessionListReports';
import type { SessionListRenderableSession } from './sessionListRenderable';

function session(sessionId: string, groupKey = 'g1'): SessionListIndexItem {
    return { type: 'session', sessionId, groupKey, serverId: 'home' };
}

function header(groupKey: string): SessionListIndexItem {
    return { type: 'header', title: groupKey, groupKey };
}

function rows(leads: Record<string, string | null>) {
    return (_serverId: string | null, sessionId: string) => (
        sessionId in leads
            ? ({ id: sessionId, manager: leads[sessionId] ? { sessionId: leads[sessionId] } : null } as unknown as SessionListRenderableSession)
            : null
    );
}

function shape(items: SessionListIndexItem[]) {
    return items.map((item) => (item.type === 'header' ? `# ${item.groupKey}` : `${item.type === 'session' ? item.sessionId : item.runId}:${item.reportsDepth ?? 0}`));
}

describe('nestSessionListReports', () => {
    it('preserves a filed child membership and execution workspace when its lead owns display placement', () => {
        const lead = { ...session('lead', 'lead-project'), type: 'session' as const, sessionId: 'lead',
            folderId: null, workspace: { t: 'workspaceScope' as const, serverId: 'home', machineId: 'lead-machine', rootPath: '/lead' } };
        const child = { ...session('child', 'filed-section'), type: 'session' as const, sessionId: 'child', folderId: 'launch',
            workspace: { t: 'workspaceScope' as const, serverId: 'home', machineId: 'child-machine', rootPath: '/child' } };
        const nested = nestSessionListReports([header('lead-project'), lead, header('filed-section'), child],
            rows({ lead: null, child: 'lead' }));
        expect(nested[2]).toMatchObject({ sessionId: 'child', reportsDepth: 1, groupKey: 'lead-project',
            folderId: 'launch', workspace: child.workspace });
    });

    it('keeps attention shortcuts flat while the base child nests under its visible lead', () => {
        const child = { ...session('child'), type: 'session' as const, sessionId: 'child', occurrenceRole: 'needsYou' as const, groupKey: 'attention' };
        const lead = { ...session('lead'), type: 'session' as const, sessionId: 'lead', occurrenceRole: 'working' as const, groupKey: 'working' };
        const nested = nestSessionListReports([
            header('attention'), child, header('working'), lead,
            header('base'), session('lead', 'base'), session('child', 'filed-section'),
        ], rows({ lead: null, child: 'lead' }));
        expect(nested[1]).toBe(child);
        expect(nested[3]).toBe(lead);
        expect(shape(nested)).toEqual(['# attention', 'child:0', '# working', 'lead:0', '# base', 'lead:0', 'child:1']);
        expect(nested[5]).toMatchObject({ reportsParent: true });
    });

    it('projects Bot child disclosure from the admitted parent marker and clears it after demotion', () => {
        const resolve = rows({ bot: null, worker: 'bot', ordinary: null, other: 'ordinary' });
        const items = [session('bot'), session('worker'), session('ordinary'), session('other')];
        const nested = nestSessionListReports(items, (serverId, sessionId) => {
            const row = resolve(serverId, sessionId);
            return row && sessionId === 'bot' ? { ...row, metadata: { path: '', bot: { kind: 'bot' } } } : row;
        });
        expect(nested[0]).toMatchObject({ sessionId: 'bot', reportsParent: true, reportsDefaultCollapsed: true });
        expect(nested[2]).toMatchObject({ sessionId: 'ordinary', reportsParent: true });
        expect(nested[2]).not.toHaveProperty('reportsDefaultCollapsed');
        expect(nested[1]).not.toHaveProperty('reportsParent');
        expect(shape(nested)).toEqual(['bot:0', 'worker:1', 'ordinary:0', 'other:1']);
        expect(nestSessionListReports(nested, resolve)[0]).not.toHaveProperty('reportsDefaultCollapsed');
        // A lead whose reports were detached is no longer a disclosure.
        expect(nestSessionListReports(nested, rows({ bot: null, worker: null, ordinary: null, other: null }))[0])
            .not.toHaveProperty('reportsParent');
    });

    it('draws each report under its lead in the same group, one level deeper, reports of reports deeper still', () => {
        const items = [header('g1'), session('ledger'), session('lead'), session('solo'), session('api'), session('checkout')];
        const nested = nestSessionListReports(items, rows({
            lead: null, solo: null, api: 'lead', checkout: 'lead', ledger: 'api',
        }));

        expect(shape(nested)).toEqual(['# g1', 'lead:0', 'api:1', 'ledger:2', 'checkout:1', 'solo:0']);
    });

    it('pulls reports and reports of reports into their root lead display group', () => {
        const items = [header('today'), session('lead', 'today'), header('yesterday'), session('worker', 'yesterday'),
            header('older'), session('grandchild', 'older'), session('solo', 'older')];
        const nested = nestSessionListReports(items, rows({ lead: null, worker: 'lead', grandchild: 'worker', solo: null }));

        expect(shape(nested)).toEqual(['# today', 'lead:0', 'worker:1', 'grandchild:2', '# yesterday', '# older', 'solo:0']);
        expect(nested.filter(item => item.type === 'session').map(item => item.groupKey)).toEqual(['today', 'today', 'today', 'older']);
        expect(nested[1]).toMatchObject({ reportsParent: true });
        expect(nested[2]).toMatchObject({ reportsParent: true });
    });

    it('returns the same array and rows when nothing reports to anything', () => {
        const items = [header('g1'), session('a'), session('b')];
        expect(nestSessionListReports(items, rows({ a: null, b: null }))).toBe(items);
    });

    it('keeps both members of a transient cycle visible', () => {
        const items = [session('a'), session('b')];
        const nested = nestSessionListReports(items, rows({ a: 'b', b: 'a' }));
        expect(nested.map((item) => (item.type === 'session' ? item.sessionId : null)).sort()).toEqual(['a', 'b']);
    });

    it('keeps a transient manager cycle in its own group before the following header', () => {
        const nested = nestSessionListReports([header('g1'), session('a'), session('b'), header('g2'), session('solo', 'g2')],
            rows({ a: 'b', b: 'a', solo: null }));
        expect(shape(nested)).toEqual(['# g1', 'a:0', 'b:1', '# g2', 'solo:0']);
    });

    it('moves the whole descendant subtree to a new manager on warm reprojection', () => {
        const items = [header('old'), session('first', 'old'), session('child', 'old'),
            session('grandchild', 'old'), session('leaf', 'old'), header('new'), session('second', 'new')];
        const before = nestSessionListReports(items, rows({ first: null, second: null,
            child: 'first', grandchild: 'child', leaf: 'grandchild' }));
        expect(shape(before)).toEqual(['# old', 'first:0', 'child:1', 'grandchild:2', 'leaf:3', '# new', 'second:0']);
        const moved = nestSessionListReports(before, rows({ first: null, second: null,
            child: 'second', grandchild: 'child', leaf: 'grandchild' }));
        expect(shape(moved)).toEqual(['# old', 'first:0', '# new', 'second:0', 'child:1', 'grandchild:2', 'leaf:3']);
        expect(moved.filter(item => item.type === 'session').map(item => [item.sessionId, item.groupKey]))
            .toEqual([['first', 'old'], ['second', 'new'], ['child', 'new'], ['grandchild', 'new'], ['leaf', 'new']]);
    });

    it('returns a report to its own level once it is detached', () => {
        const nested = nestSessionListReports([session('lead'), session('worker')], rows({ lead: null, worker: 'lead' }));
        const detached = nestSessionListReports(nested, rows({ lead: null, worker: null }));
        expect(shape(detached)).toEqual(['lead:0', 'worker:0']);
    });
});
