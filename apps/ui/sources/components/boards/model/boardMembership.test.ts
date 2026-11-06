import { describe, expect, it } from 'vitest';
import {
    buildWorkBoardItemKeyV1,
    createWorkBoardV1,
    type BoardItemRefV1,
    type WorkBoardV1,
} from '@happier-dev/protocol/boards/workBoardV1';
import {
    normalizeSessionListFilterV1} from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';

import { projectBoardMembership, resolveBoardPruneMembership } from './boardMembership';

const session = (serverId: string, id: string): BoardItemRefV1 => ({ kind: 'session', qualifiedId: { serverId, id } });
const run = (serverId: string, id: string): BoardItemRefV1 => ({ kind: 'workflow_run', qualifiedId: { serverId, id } });
const machine = (serverId: string, id: string): BoardItemRefV1 => ({ kind: 'machine', qualifiedId: { serverId, id } });

function board(source: WorkBoardV1['source'], positions: WorkBoardV1['positionsByItemRef'] = {}): WorkBoardV1 {
    return { ...createWorkBoardV1({ id: 'b1', name: 'Overview' }), source, positionsByItemRef: positions };
}

const mounted = (serverIds: readonly string[]) => (serverId: string) => serverIds.includes(serverId);

describe('projectBoardMembership', () => {
    it('separates source settlement from an empty projection and pruning completeness', () => {
        const filteredBoard = board({ picked: [], filter: normalizeSessionListFilterV1({ homeServerIds: ['home-a'] }) });
        const sources = { isHomeMounted: mounted(['home-a']), sections: {}, filterComplete: false };
        expect(projectBoardMembership(filteredBoard, { ...sources, filtered: null })).toMatchObject({ members: [], settled: false });
        expect(projectBoardMembership(filteredBoard, { ...sources, filtered: [], filterSettled: false })).toMatchObject({ members: [], settled: false });
        expect(projectBoardMembership(filteredBoard, { ...sources, filtered: [], filterSettled: true })).toMatchObject({ members: [], complete: false, settled: true });
        expect(projectBoardMembership(filteredBoard, { ...sources, filtered: [session('home-a', 's1')], filterSettled: true }))
            .toMatchObject({ members: [{ ref: session('home-a', 's1') }], settled: true });
        const unknownKey = buildWorkBoardItemKeyV1(session('home-a', 'unknown'));
        const positioned = { ...filteredBoard, positionsByItemRef: { [unknownKey]: { x: 0, y: 0 } } };
        const undetermined = { count: 1, reasons: [{ kind: 'session' as const, reason: 'project_association_unavailable' as const, count: 1 }] };
        const partial = projectBoardMembership(positioned, { ...sources, filtered: [session('home-a', 's1')],
            filterComplete: true, filterSettled: true, filterUndetermined: undetermined });
        expect(partial).toMatchObject({ settled: true, complete: false, undetermined });
        expect(partial.members.map(member => member.ref)).toEqual([session('home-a', 's1')]);
        expect(resolveBoardPruneMembership(positioned, partial, sources.isHomeMounted).liveItemKeys).toContain(unknownKey);
    });

    it('represents sourced linked Sessions by an available task but keeps explicit picks and qualified neighbors', () => {
        const task = { kind: 'task', qualifiedId: { serverId: 'home-a', id: 'task-1' }, pluginId: 'com.acme.tasks' } as const;
        const sources = {
            isHomeMounted: mounted(['home-a', 'home-b']), sections: { needs_you: [session('home-a', 'linked'), session('home-b', 'linked')] },
            filtered: undefined, linkedSessionsForTask: () => [session('home-a', 'linked')],
        };
        const implicit = projectBoardMembership(board({ sections: ['needs_you'], picked: [task] }), sources);
        expect(implicit.members.map(member => member.ref)).toEqual([session('home-b', 'linked'), task]);
        const explicit = projectBoardMembership(board({ sections: ['needs_you'], picked: [task, session('home-a', 'linked')] }), sources);
        expect(explicit.members.map(member => member.ref)).toEqual([session('home-a', 'linked'), session('home-b', 'linked'), task]);
        const unavailable = projectBoardMembership(board({ sections: ['needs_you'], picked: [task] }), {
            ...sources, isSourceAvailable: (ref: BoardItemRefV1) => ref.kind !== 'task',
        });
        expect(unavailable.members.map(member => member.ref)).toContainEqual(session('home-a', 'linked'));
        const unresolved = projectBoardMembership(board({ sections: ['needs_you'], picked: [task] }), {
            ...sources, linkedSessionsForTask: () => null,
        });
        expect(unresolved.members.map(member => member.ref)).toContainEqual(session('home-a', 'linked'));
        expect(resolveBoardPruneMembership(board({ picked: [task] }), implicit, sources.isHomeMounted).liveItemKeys)
            .toContain(buildWorkBoardItemKeyV1(session('home-a', 'linked')));
    });

    it('reads sections from their owners, mixes kinds, and lists an item once whatever brought it in', () => {
        const membership = projectBoardMembership(board({
            sections: ['needs_you', 'running', 'my_machines'],
            picked: [session('home-a', 's1'), machine('home-a', 'm1')],
        }), {
            isHomeMounted: mounted(['home-a']),
            sections: {
                needs_you: [session('home-a', 's1'), run('home-a', 'r1')],
                running: [run('home-a', 'r1'), run('home-a', 'r2')],
                my_machines: [machine('home-a', 'm1'), machine('home-a', 'm2')],
            },
            filtered: undefined,
        });
        expect(membership.members.map((member) => [member.ref.kind, member.ref.qualifiedId.id, member.picked])).toEqual([
            ['session', 's1', true],
            ['workflow_run', 'r1', false],
            ['workflow_run', 'r2', false],
            ['machine', 'm1', true],
            ['machine', 'm2', false],
        ]);
        expect(membership.complete).toBe(true);
    });

    it('keeps a picked item from a Home that is not mounted, marked unavailable, and never drops it', () => {
        const membership = projectBoardMembership(board({ picked: [session('home-off', 's9'), session('home-a', 's1')] }), {
            isHomeMounted: mounted(['home-a']),
            sections: {},
            filtered: undefined,
        });
        expect(membership.members.map((member) => [member.ref.qualifiedId.serverId, member.available])).toEqual([
            ['home-off', false],
            ['home-a', true],
        ]);
    });

    it('applies an inline Sessions filter as one more membership source', () => {
        const membership = projectBoardMembership(board({ filter: normalizeSessionListFilterV1(), picked: [] }), {
            isHomeMounted: mounted(['home-a']),
            sections: {},
            filtered: [session('home-a', 's1'), session('home-a', 's2')],
        });
        expect(membership.complete).toBe(true);
        expect(membership.members.map((member) => member.key)).toEqual([
            buildWorkBoardItemKeyV1(session('home-a', 's1')),
            buildWorkBoardItemKeyV1(session('home-a', 's2')),
        ]);
    });

    it('is incomplete while a chosen section has not answered, so no position is pruned meanwhile', () => {
        const sectionItem = session('home-a', 's3');
        const sectionKey = buildWorkBoardItemKeyV1(sectionItem);
        const loading = board({ sections: ['needs_you'], picked: [] }, { [sectionKey]: { x: 0, y: 0 } });
        const membership = projectBoardMembership(loading, {
            isHomeMounted: mounted(['home-a']),
            sections: { needs_you: null },
            filtered: undefined,
        });
        expect(membership.complete).toBe(false);
        expect(resolveBoardPruneMembership(loading, membership, mounted(['home-a'])).liveItemKeys).toContain(sectionKey);

        const answered = projectBoardMembership(loading, {
            isHomeMounted: mounted(['home-a']),
            sections: { needs_you: [] },
            filtered: undefined,
        });
        expect(resolveBoardPruneMembership(loading, answered, mounted(['home-a'])).liveItemKeys).not.toContain(sectionKey);
    });

    it('counts a picked item that a section also holds as live, so removing the pick keeps its place', () => {
        const s1 = session('home-a', 's1');
        const value = board({ sections: ['needs_you'], picked: [s1] }, { [buildWorkBoardItemKeyV1(s1)]: { x: 0, y: 0 } });
        const membership = projectBoardMembership(value, {
            isHomeMounted: mounted(['home-a']),
            sections: { needs_you: [s1] },
            filtered: undefined,
        });
        expect(resolveBoardPruneMembership(value, membership, mounted(['home-a'])).liveItemKeys).toContain(buildWorkBoardItemKeyV1(s1));
    });

    it('shows a placed card that only a section brought in from an unmounted Home as unavailable, never dropping it', () => {
        const away = session('home-off', 's9');
        const gone = session('home-a', 's8');
        const value = board({ sections: ['needs_you'], picked: [] }, {
            [buildWorkBoardItemKeyV1(away)]: { x: 0, y: 0 },
            // A mounted Home answered without it: its live source decides, so it is not on the board.
            [buildWorkBoardItemKeyV1(gone)]: { x: 400, y: 0 },
        });
        const membership = projectBoardMembership(value, {
            isHomeMounted: mounted(['home-a']),
            sections: { needs_you: [] },
            filtered: undefined,
        });
        expect(membership.members.map((member) => [member.key, member.available])).toEqual([[buildWorkBoardItemKeyV1(away), false]]);
    });

    it('names the unmounted Homes whose positions must survive a save', () => {
        const offKey = buildWorkBoardItemKeyV1(session('home-off', 's9'));
        const value = board({ picked: [] }, { [offKey]: { x: 0, y: 0 } });
        const membership = projectBoardMembership(value, { isHomeMounted: mounted(['home-a']), sections: {}, filtered: undefined });
        expect(resolveBoardPruneMembership(value, membership, mounted(['home-a'])).unavailableServerIds).toEqual(['home-off']);
    });
});
