import { describe, expect, it } from 'vitest';

import { normalizeSessionListFilterV1 } from '../sessions/listFilter/sessionListFilterV1.js';
import {
    applyWorkBoardIntentV1,
    buildWorkBoardItemKeyV1,
    createWorkBoardV1,
    DEFAULT_WORK_BOARDS_V1,
    readWorkBoardItemKeyV1,
    WorkBoardIntentV1Schema,
    WorkBoardV1StrictSchema,
    WorkBoardsV1Schema,
    type BoardItemRefV1,
    type WorkBoardsV1,
} from './workBoardV1.js';

const session = (serverId: string, id: string): BoardItemRefV1 => ({ kind: 'session', qualifiedId: { serverId, id } });
const machine = (serverId: string, id: string): BoardItemRefV1 => ({ kind: 'machine', qualifiedId: { serverId, id } });

function boardsWith(...boards: WorkBoardsV1['boards']): WorkBoardsV1 {
    return WorkBoardsV1Schema.parse({ v: 1, boards });
}

function applied(result: ReturnType<typeof applyWorkBoardIntentV1>): WorkBoardsV1 {
    if (result.status !== 'applied') throw new Error(`expected applied, got ${result.status}`);
    return result.boards;
}

describe('WorkBoardV1', () => {
    it('reads known persisted fields and drops extras throughout the Board collection', () => {
        const ref = session('home-a', 's1');
        const key = buildWorkBoardItemKeyV1(ref);
        const filter = normalizeSessionListFilterV1({ audiences: [{ kind: 'team', serverId: 'home-a', teamId: 'team' }],
            tagIds: [{ serverId: 'home-a', tagId: 'tag' }] });
        const board = { ...createWorkBoardV1({ id: 'b1', name: 'B' }), source: { sections: ['needs_you'], filter, picked: [ref] },
            positionsByItemRef: { [key]: { x: 24, y: 48 } } };
        const stored = { ...board, extra: true, source: { ...board.source, extra: true,
            filter: { ...filter, extra: true, audiences: filter.audiences.map(value => ({ ...value, extra: true })),
                tagIds: filter.tagIds.map(value => ({ ...value, extra: true })) },
            picked: [{ ...ref, extra: true, qualifiedId: { ...ref.qualifiedId, extra: true } }] },
            positionsByItemRef: { [key]: { x: 24, y: 48, extra: true } } };
        expect(WorkBoardsV1Schema.parse({ v: 1, boards: [stored], extra: true })).toEqual({ v: 1, boards: [board] });
        for (const value of [stored, { ...board, source: stored.source }, { ...board, positionsByItemRef: stored.positionsByItemRef }]) {
            expect(WorkBoardV1StrictSchema.safeParse(value).success).toBe(false);
        }
    });

    it('reads persisted widget extras without weakening placement invariants or opaque binding values', () => {
        const surface = { serverId: 'home', accountId: 'owner', owner: { kind: 'workBoard', boardId: 'b1' } } as const;
        const instance = { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'summary' },
            bindings: { payload: { kind: 'value', value: { extra: 'meaningful input' } } } } as const;
        const ref = { surface, instanceId: instance.id };
        const board = { ...createWorkBoardV1({ id: 'b1', name: 'B' }), widgets: [{ kind: 'widget', ref, instance, size: 'medium' }] };
        const stored = { ...board, widgets: [{ ...board.widgets[0], extra: true,
            ref: { ...ref, extra: true, surface: { ...surface, extra: true, owner: { ...surface.owner, extra: true } } },
            instance: { ...instance, extra: true, definition: { ...instance.definition, extra: true },
                bindings: { payload: { ...instance.bindings.payload, extra: true } } } }] };
        const read = WorkBoardsV1Schema.parse({ v: 1, boards: [stored] });
        expect(read.boards[0]).toMatchObject(board);
        expect(read.boards[0]?.widgets).toEqual(board.widgets);
        for (const widgets of [
            [{ ...stored.widgets[0], ref: { ...ref, instanceId: 'other' } }],
            [{ ...stored.widgets[0], ref: { ...ref, surface: { ...surface, owner: { kind: 'workBoard', boardId: 'other' } } } }],
            [stored.widgets[0], stored.widgets[0]],
        ]) {
            const invalid = { ...stored, widgets };
            expect(WorkBoardsV1Schema.parse({ v: 1, boards: [invalid] })).toEqual({ v: 1, boards: [], unreadable: [invalid] });
        }
    });

    it('keeps invalid known fields unreadable even when extras are present', () => {
        const healthy = createWorkBoardV1({ id: 'healthy', name: 'Healthy' });
        const key = buildWorkBoardItemKeyV1(session('home', 'session'));
        for (const invalid of [
            { name: 'No identity', source: { picked: [] }, extra: true },
            { id: 'invalid', source: { picked: [] }, extra: true },
            { id: 'invalid', name: 'No source', extra: true },
            { ...healthy, id: 'invalid', source: null, extra: true },
            { ...healthy, id: 'invalid', mode: 'future-mode', extra: true },
            { ...healthy, id: 'invalid', positionsByItemRef: { [key]: { x: '24', y: 48, extra: true } }, extra: true },
        ]) {
            expect(WorkBoardsV1Schema.parse({ v: 1, boards: [invalid, healthy] })).toEqual({ v: 1, boards: [healthy], unreadable: [invalid] });
        }
    });

    it('preserves a Board with a wrong-surface widget as unreadable without breaking neighboring Boards', () => {
        const healthy = createWorkBoardV1({ id: 'healthy', name: 'Healthy' });
        const damaged = { ...createWorkBoardV1({ id: 'damaged', name: 'Damaged' }), widgets: [{
            kind: 'widget', size: 'medium',
            ref: { surface: { serverId: 'home', accountId: 'owner', owner: { kind: 'home' } }, instanceId: 'copy' },
            instance: { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'summary' }, bindings: {} },
        }] };
        expect(WorkBoardsV1Schema.parse({ v: 1, boards: [damaged, healthy] })).toEqual({
            v: 1, boards: [healthy], unreadable: [damaged],
        });
    });
    it('keeps qualified widget positions and independent copies beside smart work membership', () => {
        const surface = { serverId: 'home-a', accountId: 'owner', owner: { kind: 'workBoard', boardId: 'b1' } } as const;
        const instance = { v: 1, id: 'copy-a', definition: { kind: 'builtin', id: 'changes' }, bindings: {} } as const;
        const ref = { surface, instanceId: instance.id };
        const key = JSON.stringify(['widget', 'home-a', 'owner', 'b1', 'copy-a']);
        let state = boardsWith({ ...createWorkBoardV1({ id: 'b1', name: 'B' }), source: { picked: [session('home-a', 's1')], sections: ['running'] } });
        const edit = (input: unknown) => { state = applied(applyWorkBoardIntentV1(state, WorkBoardIntentV1Schema.parse(input))); };
        edit({ kind: 'widget_add', boardId: 'b1', ref, instance, size: 'full', position: { x: 12, y: 24 } });
        edit({ kind: 'widget_add', boardId: 'b1', ref: { surface, instanceId: 'copy-b' }, instance: { ...instance, id: 'copy-b' } });
        edit({ kind: 'widget_inputs', boardId: 'b1', ref, bindings: { session: { kind: 'value', value: 's2' } } });
        edit({ kind: 'set_positions', boardId: 'b1', positionsByItemRef: {}, membership: { liveItemKeys: [], unavailableServerIds: [] } });
        edit({ kind: 'update', boardId: 'b1', patch: { mode: 'by_status' } });
        const board = state.boards[0]!;
        expect(board).toMatchObject({ mode: 'by_status', widgets: [
            { kind: 'widget', ref, instance: { ...instance, bindings: { session: { kind: 'value', value: 's2' } } }, size: 'full' },
            { kind: 'widget', instance: { id: 'copy-b', bindings: {} }, size: 'medium' },
        ], positionsByItemRef: { [key]: { x: 12, y: 24 } } });
        edit({ kind: 'widget_remove', boardId: 'b1', ref });
        expect(state.boards[0]!.positionsByItemRef[key]).toBeUndefined();
        expect(state.boards[0]!.source).toEqual(board.source);
    });
    it('preserves omitted source settings and custody while explicitly clearing either setting', () => {
        const filter = normalizeSessionListFilterV1();
        const base = boardsWith({ ...createWorkBoardV1({ id: 'b1', name: 'B' }), source: {
            sections: ['running'], filter, picked: [session('home-a', 's1')],
            unknown: { sections: ['future-section'], picked: [{ kind: 'future-item' }] },
        } });
        const sectionEdit = applied(applyWorkBoardIntentV1(base, WorkBoardIntentV1Schema.parse({
            kind: 'update', boardId: 'b1', patch: { source: { sections: ['needs_you'] } },
        })));
        expect(sectionEdit.boards[0]!.source).toEqual({ ...base.boards[0]!.source, sections: ['needs_you'] });
        const filterClear = applied(applyWorkBoardIntentV1(sectionEdit, WorkBoardIntentV1Schema.parse({
            kind: 'update', boardId: 'b1', patch: { source: { filter: null } },
        })));
        expect(filterClear.boards[0]!.source).toEqual({
            sections: ['needs_you'], picked: base.boards[0]!.source.picked, unknown: base.boards[0]!.source.unknown,
        });
        const sectionClear = applied(applyWorkBoardIntentV1(base, WorkBoardIntentV1Schema.parse({
            kind: 'update', boardId: 'b1', patch: { source: { sections: null } },
        })));
        expect(sectionClear.boards[0]!.source.filter).toEqual(filter);
        expect(sectionClear.boards[0]!.source.sections).toEqual([]);
        expect(sectionClear.boards[0]!.source.unknown).toEqual(base.boards[0]!.source.unknown);
    });

    it('round-trips a qualified item key and keeps the same id on two Homes distinct', () => {
        const a = buildWorkBoardItemKeyV1(session('home-a', 's1'));
        const b = buildWorkBoardItemKeyV1(session('home-b', 's1'));
        expect(a).not.toBe(b);
        expect(buildWorkBoardItemKeyV1(session(' home-a ', ' s1 '))).toBe(a);
        expect(readWorkBoardItemKeyV1(a)).toEqual(session('home-a', 's1'));
        expect(readWorkBoardItemKeyV1('not a key')).toBeNull();
        expect(readWorkBoardItemKeyV1(JSON.stringify(['planet', 'home-a', 's1']))).toBeNull();
    });

    it('normalizes the source: sections, picked refs and the inline filter are deduplicated', () => {
        const parsed = boardsWith({
            ...createWorkBoardV1({ id: 'b1', name: '  Overview  ' }),
            source: {
                sections: ['needs_you', 'running', 'needs_you'],
                filter: { ...normalizeSessionListFilterV1(), homeServerIds: ['home-a', ' home-a '] },
                picked: [session('home-a', 's1'), session(' home-a ', 's1 '), session('home-b', 's1'), machine('home-a', 's1')],
            },
        });
        const board = parsed.boards[0]!;
        expect(board.name).toBe('Overview');
        expect(board.source.sections).toEqual(['needs_you', 'running']);
        expect(board.source.filter?.homeServerIds).toEqual(['home-a']);
        expect(board.source.picked).toEqual([session('home-a', 's1'), session('home-b', 's1'), machine('home-a', 's1')]);
    });

    it('keeps one board per id and drops positions whose key is not an item reference', () => {
        const parsed = boardsWith(
            { ...createWorkBoardV1({ id: 'b1', name: 'First' }), positionsByItemRef: { junk: { x: 1, y: 2 } } },
            createWorkBoardV1({ id: 'b1', name: 'Duplicate' }),
        );
        expect(parsed.boards.map((board) => board.name)).toEqual(['First']);
        expect(parsed.boards[0]!.positionsByItemRef).toEqual({});
    });

    it('defaults a new board to a hand-picked Canvas with snapping on and the Sessions pin off', () => {
        expect(createWorkBoardV1({ id: 'b1', name: 'Release week' })).toEqual({
            id: 'b1',
            name: 'Release week',
            source: { picked: [] },
            mode: 'canvas',
            snap: true,
            positionsByItemRef: {},
            pinnedInSessions: false,
        });
        expect(DEFAULT_WORK_BOARDS_V1).toEqual({ v: 1, boards: [] });
    });

    it('adds items once by qualified reference, wherever they came from', () => {
        const base = boardsWith({ ...createWorkBoardV1({ id: 'b1', name: 'B' }), source: { picked: [session('home-a', 's1')] } });
        const next = applied(applyWorkBoardIntentV1(base, {
            kind: 'add_items',
            boardId: 'b1',
            refs: [session('home-a', 's1'), machine('home-a', 'm1'), machine('home-a', 'm1')],
        }));
        expect(next.boards[0]!.source.picked).toEqual([session('home-a', 's1'), machine('home-a', 'm1')]);
        expect(applyWorkBoardIntentV1(base, { kind: 'add_items', boardId: 'missing', refs: [] }).status).toBe('not_found');
    });

    it('prunes a removed item position, and the positions of items that left a mounted Home membership', () => {
        const s1 = session('home-a', 's1');
        const s2 = session('home-a', 's2');
        const offHome = session('home-off', 's9');
        const sectionOnly = session('home-a', 's3');
        const base = boardsWith({
            ...createWorkBoardV1({ id: 'b1', name: 'B' }),
            source: { sections: ['needs_you'], picked: [s1, s2, offHome] },
            positionsByItemRef: {
                [buildWorkBoardItemKeyV1(s1)]: { x: 0, y: 0 },
                [buildWorkBoardItemKeyV1(s2)]: { x: 400, y: 0 },
                [buildWorkBoardItemKeyV1(offHome)]: { x: 800, y: 0 },
                [buildWorkBoardItemKeyV1(sectionOnly)]: { x: 0, y: 300 },
            },
        });

        const removed = applied(applyWorkBoardIntentV1(base, {
            kind: 'remove_item', boardId: 'b1', ref: s2, membership: { liveItemKeys: [], unavailableServerIds: ['home-off'] },
        })).boards[0]!;
        expect(removed.source.picked).toEqual([s1, offHome]);
        expect(Object.keys(removed.positionsByItemRef)).not.toContain(buildWorkBoardItemKeyV1(s2));

        // s3 left the Needs you section on a mounted Home; the unmounted Home's card keeps its place.
        const moved = applied(applyWorkBoardIntentV1(base, {
            kind: 'set_positions',
            boardId: 'b1',
            positionsByItemRef: { [buildWorkBoardItemKeyV1(s1)]: { x: 24.4, y: 48.6 } },
            membership: { liveItemKeys: [], unavailableServerIds: ['home-off'] },
        })).boards[0]!;
        expect(moved.positionsByItemRef).toEqual({
            [buildWorkBoardItemKeyV1(s1)]: { x: 24, y: 49 },
            [buildWorkBoardItemKeyV1(s2)]: { x: 400, y: 0 },
            [buildWorkBoardItemKeyV1(offHome)]: { x: 800, y: 0 },
        });
    });

    it('keeps a removed pick\'s place while a section or filter still holds the item', () => {
        const s1 = session('home-a', 's1');
        const key = buildWorkBoardItemKeyV1(s1);
        const sectioned = boardsWith({
            ...createWorkBoardV1({ id: 'b1', name: 'B' }),
            source: { sections: ['needs_you'], picked: [s1] },
            positionsByItemRef: { [key]: { x: 10, y: 20 } },
        });
        const remove = (boards: WorkBoardsV1, membership?: Readonly<{ liveItemKeys: string[]; unavailableServerIds: string[] }>) => (
            applied(applyWorkBoardIntentV1(boards, { kind: 'remove_item', boardId: 'b1', ref: s1, ...(membership ? { membership } : {}) })).boards[0]!
        );

        // Still a Needs you member: no longer picked, but it keeps its place on the Canvas.
        const stillMember = remove(sectioned, { liveItemKeys: [key], unavailableServerIds: [] });
        expect(stillMember.source.picked).toEqual([]);
        expect(stillMember.positionsByItemRef).toEqual({ [key]: { x: 10, y: 20 } });
        // Gone from every source: its place goes with it.
        expect(remove(sectioned, { liveItemKeys: [], unavailableServerIds: [] }).positionsByItemRef).toEqual({});
        // A writer without live membership (an agent) never guesses: a sectioned board keeps the place…
        expect(remove(sectioned).positionsByItemRef).toEqual({ [key]: { x: 10, y: 20 } });
        // …while on a hand-picked board the pick was the only way onto it.
        const handPicked = boardsWith({
            ...createWorkBoardV1({ id: 'b1', name: 'B' }),
            source: { picked: [s1] },
            positionsByItemRef: { [key]: { x: 10, y: 20 } },
        });
        expect(remove(handPicked).positionsByItemRef).toEqual({});
    });

    it('keeps a board it cannot read raw and unrendered in the dedicated record', () => {
        const mine = createWorkBoardV1({ id: 'b1', name: 'Mine' });
        const newer = { id: 'b2', name: 'Missing required source', color: 'teal' };
        const boards = WorkBoardsV1Schema.parse({ v: 1, boards: [mine, newer] });
        expect(boards.boards.map((board) => board.id)).toEqual(['b1']);

        // Editing another board writes the unreadable one back untouched.
        const edited = applied(applyWorkBoardIntentV1(boards, { kind: 'update', boardId: 'b1', patch: { name: 'Renamed' } }));
        const stored = JSON.parse(JSON.stringify(edited));
        expect(JSON.stringify(stored)).toContain(JSON.stringify(newer));
        expect(WorkBoardsV1Schema.parse(stored).boards.map((board) => board.name)).toEqual(['Renamed']);
    });

    it('drops section and item kinds it does not know from display, and writes them back on an edit', () => {
        const s1 = session('home-a', 's1');
        const pullRequest = { kind: 'pull_request', qualifiedId: { serverId: 'home-a', id: 'pr-7' } };
        const parsed = WorkBoardsV1Schema.parse({ v: 1, boards: [{
            ...createWorkBoardV1({ id: 'b1', name: 'B' }),
            source: { sections: ['needs_you', 'pull_requests'], picked: [s1, pullRequest] },
        }] });
        const board = parsed.boards[0]!;
        expect(board.source.sections).toEqual(['needs_you']);
        expect(board.source.picked).toEqual([s1]);

        const edited = applied(applyWorkBoardIntentV1(parsed, { kind: 'update', boardId: 'b1', patch: { name: 'Renamed' } }));
        const stored = JSON.stringify(WorkBoardsV1Schema.parse(JSON.parse(JSON.stringify(edited))));
        expect(stored).toContain('"pull_requests"');
        expect(stored).toContain(JSON.stringify(pullRequest));
    });

    it('keeps Canvas positions across a mode switch and changes only the requested settings', () => {
        const key = buildWorkBoardItemKeyV1(session('home-a', 's1'));
        const base = boardsWith({
            ...createWorkBoardV1({ id: 'b1', name: 'B' }),
            source: { picked: [session('home-a', 's1')] },
            positionsByItemRef: { [key]: { x: 10, y: 20 } },
        });
        const next = applied(applyWorkBoardIntentV1(base, {
            kind: 'update', boardId: 'b1', patch: { mode: 'by_status', pinnedInSessions: true },
        })).boards[0]!;
        expect(next.mode).toBe('by_status');
        expect(next.pinnedInSessions).toBe(true);
        expect(next.snap).toBe(true);
        expect(next.positionsByItemRef).toEqual({ [key]: { x: 10, y: 20 } });
    });

});
