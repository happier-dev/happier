import { describe, expect, it } from 'vitest';

import type { WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import {
    buildSessionListIndexEntityId,
    type SessionListIndexItem,
} from './sessionListIndex';
import { projectSessionListIndexGroupRollups, type SessionListGroupSubject } from './sessionListGroupRollups';

const permission: WorkStatusPresentation = {
    state: 'permission_required', bucket: 'needs_you', tone: 'attention', attentionType: 'approval', word: 'Permission',
};
const failed: WorkStatusPresentation = {
    state: 'failed', bucket: 'idle', tone: 'danger', attentionType: 'update', word: 'Failed',
};
const working: WorkStatusPresentation = {
    state: 'thinking', bucket: 'working', tone: 'neutral', attentionType: null, word: 'Working',
};

function member(sessionId: string, groupKey: string): Extract<SessionListIndexItem, { type: 'session' }> {
    return { type: 'session', sessionId, serverId: 'home', groupKey, groupKind: 'project' };
}

function header(groupKey: string): Extract<SessionListIndexItem, { type: 'header' }> {
    return { type: 'header', headerKind: 'project', title: groupKey, groupKey };
}

describe('Session list group rollups', () => {
    it.each(['pinned', 'attention', 'working'] as const)('ends the flat %s band before a following Project', (headerKind) => {
        const flat = member('flat', 'flat');
        const run: SessionListIndexItem = { type: 'workflow_run', serverId: 'home', runId: 'run', groupKey: 'project' };
        const result = projectSessionListIndexGroupRollups({ items: [
            { type: 'header', title: 'Band', headerKind, groupKey: 'flat' }, flat, header('project'), run,
        ], subjects: new Map([
            [buildSessionListIndexEntityId(flat), { status: working, coverage: 'complete' as const }],
            [buildSessionListIndexEntityId(run), { status: failed, coverage: 'complete' as const }],
        ]) });
        expect(result.items[0]).toMatchObject({ rollup: { status: working, needsYouCount: 0, coverage: 'complete' } });
        expect(result.items[2]).toMatchObject({ rollup: { status: failed, needsYouCount: 0, coverage: 'complete' } });
    });

    it('uses complete folder membership and rolls descendants into their ancestors before disclosure', () => {
        const child = { ...member('child', 'child'), groupKind: 'folder' as const, folderDepth: 2 };
        const parent = { ...member('parent', 'parent'), groupKind: 'folder' as const, folderDepth: 1 };
        const root = { ...member('root', 'root'), groupKind: 'folder' as const, folderDepth: 0 };
        const items: SessionListIndexItem[] = [header('project'),
            { type: 'header', headerKind: 'folder', title: 'Parent', groupKey: 'parent', folderDepth: 0 },
            { type: 'header', headerKind: 'folder', title: 'Child', groupKey: 'child', folderDepth: 1 }, child, parent, root];
        const result = projectSessionListIndexGroupRollups({ items, subjects: new Map([
            [buildSessionListIndexEntityId(child), { status: permission, coverage: 'complete' as const }],
            [buildSessionListIndexEntityId(parent), { status: failed, coverage: 'complete' as const }],
            [buildSessionListIndexEntityId(root), { status: working, coverage: 'complete' as const }],
        ]) });
        expect(result.items[0]).toMatchObject({ rollup: { status: failed, needsYouCount: 1 } });
        expect(result.items[1]).toMatchObject({ rollup: { status: failed, needsYouCount: 1 } });
        expect(result.items[2]).toMatchObject({ rollup: { status: permission, needsYouCount: 1 } });
    });

    it('counts distinct admitted subjects while retaining failure as the strongest display independently of needs-you', () => {
        const a = member('a', 'one');
        const b = member('b', 'one');
        const subjects = new Map<string, SessionListGroupSubject>([
            [buildSessionListIndexEntityId(a), { status: permission, coverage: 'complete' }],
            [buildSessionListIndexEntityId(b), { status: failed, coverage: 'complete' }],
        ]);
        const result = projectSessionListIndexGroupRollups({ items: [header('one'), a, { ...a, occurrenceRole: 'needsYou' }, b], subjects });
        expect(result.items[0]).toMatchObject({ rollup: { status: failed, needsYouCount: 1, coverage: 'complete' } });
        expect(result.items.slice(1)).toEqual([a, { ...a, occurrenceRole: 'needsYou' }, b]);
    });

    it('keeps partial and unavailable coverage truthful instead of manufacturing a known zero', () => {
        const a = member('a', 'one');
        const b = member('b', 'one');
        const c = member('c', 'two');
        const result = projectSessionListIndexGroupRollups({ items: [header('one'), a, b, header('two'), c], subjects: new Map([
            [buildSessionListIndexEntityId(a), { status: permission, coverage: 'complete' as const }],
        ]) });
        expect(result.items[0]).toMatchObject({ rollup: { status: permission, needsYouCount: 1, coverage: 'partial' } });
        expect(result.items[3]).toMatchObject({ rollup: { status: null, needsYouCount: null, coverage: 'unavailable' } });
    });

    it('retains partial query coverage for a fully classified loaded page and uses canonical quiet admission', () => {
        const a = member('a', 'one');
        const quietDecision: WorkStatusPresentation = { ...permission, state: 'action_required', tone: 'neutral', attentionType: 'decision' };
        const result = projectSessionListIndexGroupRollups({ items: [header('one'), a], coverage: 'partial',
            subjects: new Map([[buildSessionListIndexEntityId(a), { status: quietDecision, coverage: 'complete' }]]) });
        expect(result.items[0]).toMatchObject({ rollup: { status: quietDecision, needsYouCount: 1, coverage: 'partial' } });
    });

    it('updates both former and new groups when a subject moves, without retaining its old urgency', () => {
        const a = member('a', 'one');
        const b = member('b', 'one');
        const c = member('c', 'two');
        const subjects = new Map<string, SessionListGroupSubject>([
            [buildSessionListIndexEntityId(a), { status: permission, coverage: 'complete' }],
            [buildSessionListIndexEntityId(b), { status: working, coverage: 'complete' }],
            [buildSessionListIndexEntityId(c), { status: working, coverage: 'complete' }],
        ]);
        const first = projectSessionListIndexGroupRollups({ items: [header('one'), a, b, header('two'), c], subjects });
        const moved = projectSessionListIndexGroupRollups({ items: [first.items[0], b, first.items[3], c, { ...a, groupKey: 'two' }],
            subjects, previous: first, changedSubjectKeys: [] });
        expect(moved.items[0]).toMatchObject({ rollup: { status: working, needsYouCount: 0 } });
        expect(moved.items[2]).toMatchObject({ rollup: { status: permission, needsYouCount: 1 } });
    });

    it('keeps same-id subjects from different Homes and kinds distinct in a primary band', () => {
        const a = member('same', 'one');
        const otherHome = { ...a, serverId: 'other', groupKey: 'two' };
        const run: SessionListIndexItem = { type: 'workflow_run', runId: 'same', serverId: 'home', groupKey: 'two' };
        const subjects = new Map([a, otherHome, run].map(item => [buildSessionListIndexEntityId(item),
            { status: permission, coverage: 'complete' as const }]));
        const result = projectSessionListIndexGroupRollups({ items: [
            { type: 'header', title: 'All', headerKind: 'sessions', groupKey: 'all' },
            header('one'), a, header('two'), otherHome, run,
        ], subjects });
        expect(result.items[0]).toMatchObject({ rollup: { needsYouCount: 3, coverage: 'complete' } });
        expect(result.items[3]).toMatchObject({ rollup: { needsYouCount: 2 } });
    });

    it('rolls project subjects into their Home header without crossing the next Home', () => {
        const a = member('a', 'one');
        const b = member('b', 'two');
        const c = { ...member('c', 'three'), serverId: 'other' };
        const result = projectSessionListIndexGroupRollups({ items: [
            { type: 'header', headerKind: 'server', title: 'Home', groupKey: 'server:home', serverId: 'home' },
            header('one'), a, header('two'), b,
            { type: 'header', headerKind: 'server', title: 'Other', groupKey: 'server:other', serverId: 'other' },
            header('three'), c,
        ], subjects: new Map([a, b, c].map(item => [buildSessionListIndexEntityId(item), { status: permission, coverage: 'complete' as const }])) });
        expect(result.items[0]).toMatchObject({ rollup: { needsYouCount: 2 } });
        expect(result.items[5]).toMatchObject({ rollup: { needsYouCount: 1 } });
    });

    it('reads only affected group members at scale and preserves every unrelated header and row identity', () => {
        const items: SessionListIndexItem[] = [];
        const subjects = new Map<string, SessionListGroupSubject>();
        for (let group = 0; group < 100; group += 1) {
            items.push(header(`group-${group}`));
            for (let index = 0; index < 10; index += 1) {
                const item = member(`${group}-${index}`, `group-${group}`);
                items.push(item);
                subjects.set(buildSessionListIndexEntityId(item), { status: working, coverage: 'complete' });
            }
        }
        let result = projectSessionListIndexGroupRollups({ items, subjects });
        const unchangedHeader = result.items[11];
        let reads = 0;
        let structuralKeyReads = 0;
        for (const item of items) {
            if (item.type !== 'session') continue;
            const id = item.sessionId;
            Object.defineProperty(item, 'sessionId', { get() { structuralKeyReads += 1; return id; } });
        }
        class ObservedSubjects extends Map<string, SessionListGroupSubject> {
            override get(key: string) { reads += 1; return super.get(key); }
        }
        for (let arrival = 0; arrival < 5; arrival += 1) {
            const changed = buildSessionListIndexEntityId(member('0-0', 'group-0'));
            const next = new ObservedSubjects(subjects);
            next.set(changed, { status: arrival % 2 === 0 ? permission : working, coverage: 'complete' });
            const previous = result;
            result = projectSessionListIndexGroupRollups({ items: [...result.items], subjects: next,
                previous: result, changedSubjectKeys: [changed] });
            expect(result.items[11]).toBe(unchangedHeader);
            expect(result.items[1]).toBe(previous.items[1]);
        }
        expect(reads).toBe(50);
        // New arrangements pay one structural-only pass; payload reads stay local
        // to the ten subjects in the affected group rather than all 1,000 subjects.
        expect(structuralKeyReads).toBe(5_000);
        projectSessionListIndexGroupRollups({ items: result.items, subjects, previous: result, changedSubjectKeys: [] });
        expect(structuralKeyReads).toBe(5_000);
    });
});
