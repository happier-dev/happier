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
            ? ({ id: sessionId, reportsTo: leads[sessionId] ? { sessionId: leads[sessionId] } : null } as unknown as SessionListRenderableSession)
            : null
    );
}

function shape(items: SessionListIndexItem[]) {
    return items.map((item) => (item.type === 'header' ? `# ${item.groupKey}` : `${item.type === 'session' ? item.sessionId : item.runId}:${item.reportsDepth ?? 0}`));
}

describe('nestSessionListReports', () => {
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

    it('never pulls a report across a group boundary', () => {
        const items = [header('today'), session('lead', 'today'), header('yesterday'), session('worker', 'yesterday')];
        const nested = nestSessionListReports(items, rows({ lead: null, worker: 'lead' }));

        expect(shape(nested)).toEqual(['# today', 'lead:0', '# yesterday', 'worker:0']);
        expect(nested).toBe(items);
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

    it('keeps a transient reportsTo cycle in its own group before the following header', () => {
        const nested = nestSessionListReports([header('g1'), session('a'), session('b'), header('g2'), session('solo', 'g2')],
            rows({ a: 'b', b: 'a', solo: null }));
        expect(shape(nested)).toEqual(['# g1', 'a:0', 'b:1', '# g2', 'solo:0']);
    });

    it('returns a report to its own level once it is detached', () => {
        const nested = nestSessionListReports([session('lead'), session('worker')], rows({ lead: null, worker: 'lead' }));
        const detached = nestSessionListReports(nested, rows({ lead: null, worker: null }));
        expect(shape(detached)).toEqual(['lead:0', 'worker:0']);
    });
});
