import { describe, expect, it } from 'vitest';
import { createWorkBoardArtifactBoundary } from './workBoardArtifactV1.testkit.js';
import { createWorkBoardArtifactPortV1, readWorkBoardArtifactV1 } from './workBoardArtifactV1.js';
import { buildWorkBoardItemKeyV1, createWorkBoardV1, WorkBoardIntentV1Schema } from './workBoardV1.js';
import { normalizeSessionListFilterV1 } from '../sessions/listFilter/sessionListFilterV1.js';

describe('one Artifact per Board', () => {
    it('replays widget inputs/width/order with concurrent work positions and reloads only its own Board', async () => {
        const surface = { serverId: 'home', accountId: 'account', owner: { kind: 'workBoard', boardId: 'one' } } as const;
        const instance = { v: 1, id: 'copy-a', definition: { kind: 'builtin', id: 'changes' }, bindings: {} } as const;
        const ref = { surface, instanceId: instance.id };
        const b = createWorkBoardArtifactBoundary([createWorkBoardV1({ id: 'one', name: 'One' }), createWorkBoardV1({ id: 'two', name: 'Two' })]);
        const port = createWorkBoardArtifactPortV1(b.transport);
        const other = b.rows.get('two');
        await port.apply(WorkBoardIntentV1Schema.parse({ kind: 'widget_add', boardId: 'one', ref, instance, position: { x: 12, y: 24 } }));
        await port.apply(WorkBoardIntentV1Schema.parse({ kind: 'widget_add', boardId: 'one', ref: { surface, instanceId: 'copy-b' }, instance: { ...instance, id: 'copy-b' } }));
        const workKey = buildWorkBoardItemKeyV1({ kind: 'session', qualifiedId: { serverId: 'home', id: 's1' } });
        await Promise.all([
            port.apply(WorkBoardIntentV1Schema.parse({ kind: 'widget_inputs', boardId: 'one', ref, bindings: { count: { kind: 'value', value: 7 } } })),
            port.apply(WorkBoardIntentV1Schema.parse({ kind: 'widget_width', boardId: 'one', ref, width: 2 })),
            port.apply({ kind: 'add_items', boardId: 'one', refs: [{ kind: 'session', qualifiedId: { serverId: 'home', id: 's1' } }], positionsByItemRef: { [workKey]: { x: 36, y: 48 } } }),
        ]);
        await port.apply(WorkBoardIntentV1Schema.parse({ kind: 'widget_move', boardId: 'one', ref, nativeIndex: 2 }));
        const board = await createWorkBoardArtifactPortV1(b.transport).readBoard('one');
        expect(board?.widgets).toMatchObject([{ instance: { id: 'copy-a', bindings: { count: { kind: 'value', value: 7 } } }, width: 2 }, { instance: { id: 'copy-b', bindings: {} }, width: 1 }]);
        expect(board?.itemOrder?.[2]).toBe(JSON.stringify(['widget', 'home', 'account', 'one', 'copy-a']));
        expect(board?.positionsByItemRef).toEqual({ [workKey]: { x: 36, y: 48 }, [JSON.stringify(['widget', 'home', 'account', 'one', 'copy-a'])]: { x: 12, y: 24 } });
        expect(b.rows.get('two')).toBe(other);
        const controller = new AbortController(); controller.abort();
        await expect(port.apply(WorkBoardIntentV1Schema.parse({ kind: 'widget_remove', boardId: 'one', ref }), controller.signal)).rejects.toThrow();
        expect((await port.readBoard('one'))?.widgets).toHaveLength(2);
    });
    it('persists explicit source clears without clearing the other setting or picked custody', async () => {
        const filter = normalizeSessionListFilterV1();
        const picked = [{ kind: 'session', qualifiedId: { serverId: 'a', id: 'picked' } }] as const;
        const b = createWorkBoardArtifactBoundary([{ ...createWorkBoardV1({ id: 'one', name: 'One' }),
            source: { sections: ['running'], filter, picked } }]);
        const port = createWorkBoardArtifactPortV1(b.transport);
        await port.apply(WorkBoardIntentV1Schema.parse({ kind: 'update', boardId: 'one', patch: { source: { filter: null } } }));
        expect((await port.readBoard('one'))?.source).toEqual({ sections: ['running'], picked });
        await port.apply(WorkBoardIntentV1Schema.parse({ kind: 'update', boardId: 'one', patch: { source: { filter, sections: null } } }));
        expect((await port.readBoard('one'))?.source).toEqual({ filter, picked });
    });

    it.each(['filter_first', 'sections_first'] as const)('replays independent source edits on the CAS winner (%s)', async order => {
        const initialFilter = normalizeSessionListFilterV1();
        const changedFilter = normalizeSessionListFilterV1({ homeServerIds: ['home-b'] });
        const b = createWorkBoardArtifactBoundary([{ ...createWorkBoardV1({ id: 'one', name: 'One' }),
            source: { sections: ['running'], filter: initialFilter, picked: [] } }]);
        let conflicts = 0;
        const transport = { ...b.transport, update: async (input: Parameters<typeof b.transport.update>[0]) => {
            const result = await b.transport.update(input);
            if (!result.ok && result.errorCode === 'version_mismatch') conflicts++;
            return result;
        } };
        const first = createWorkBoardArtifactPortV1(transport);
        const second = createWorkBoardArtifactPortV1(transport);
        const filterEdit = { kind: 'update', boardId: 'one', patch: { source: { filter: changedFilter } } } as const;
        const sectionsEdit = { kind: 'update', boardId: 'one', patch: { source: { sections: ['needs_you'] } } } as const;
        await Promise.all(order === 'filter_first'
            ? [first.apply(filterEdit), second.apply(sectionsEdit)]
            : [first.apply(sectionsEdit), second.apply(filterEdit)]);
        expect(conflicts).toBeGreaterThan(0);
        expect((await first.readBoard('one'))?.source).toEqual({ sections: ['needs_you'], filter: changedFilter, picked: [] });
    });

    it('isolates malformed JSON, preserves its bytes, and refuses its mutation while publishing a readable neighbor', async () => {
        const valid = createWorkBoardV1({ id: 'valid', name: 'Valid' });
        const b = createWorkBoardArtifactBoundary([createWorkBoardV1({ id: 'broken', name: 'Broken' }), valid]);
        const broken = { ...b.rows.get('broken')!, body: '{ "id": "broken",\n invalid' };
        b.rows.set('broken', broken);
        const port = createWorkBoardArtifactPortV1(b.transport);
        expect(await port.read()).toEqual({ v: 1, boards: [valid], unreadable: [broken.body] });
        expect(await port.readBoard('broken')).toBeNull();
        for (const kind of ['update', 'delete', 'create'] as const) {
            const intent = kind === 'update' ? { kind, boardId: 'broken', patch: { name: 'Overwrite' } }
                : kind === 'delete' ? { kind, boardId: 'broken' } : { kind, board: { id: 'broken', name: 'Overwrite' } };
            await expect(port.apply(intent)).rejects.toMatchObject({ code: 'invalid_board_record' });
        }
        expect(b.rows.get('broken')).toBe(broken);
        await port.apply({ kind: 'update', boardId: 'valid', patch: { name: 'Renamed' } });
        expect(b.rows.get('broken')).toBe(broken);
    });

    it.each(['transport_unavailable', 'authentication_required', 'encryption_mode_mismatch', 'decryption_failed'])('propagates %s without classifying it as unreadable content', async code => {
        const b = createWorkBoardArtifactBoundary([createWorkBoardV1({ id: 'one', name: 'One' })]);
        const failure = Object.assign(new Error(code), { code });
        const port = createWorkBoardArtifactPortV1({ ...b.transport, read: async () => { throw failure; } });
        await expect(port.read()).rejects.toBe(failure);
        await expect(port.readBoard('one')).rejects.toBe(failure);
        await expect(port.apply({ kind: 'update', boardId: 'one', patch: { name: 'Overwrite' } })).rejects.toBe(failure);
        expect(b.updates).toEqual([]);
    });

    it('acknowledges the actual winner when exact-id create returns a raced existing Board', async () => {
        const b = createWorkBoardArtifactBoundary();
        const port = createWorkBoardArtifactPortV1({ ...b.transport, create: async input => {
            b.add(createWorkBoardV1({ id: input.artifactId, name: 'Other creator' }));
            return b.transport.create(input);
        } });
        const result = await port.apply({ kind: 'create', board: { id: 'one', name: 'My attempted name' } });
        expect(result.boards[0]?.name).toBe('Other creator');
    });
    it('replays two concurrent position intents on the winner without writing another Board', async () => {
        const b = createWorkBoardArtifactBoundary([createWorkBoardV1({ id: 'one', name: 'One' }), createWorkBoardV1({ id: 'two', name: 'Two' })]);
        const first = buildWorkBoardItemKeyV1({ kind: 'session', qualifiedId: { serverId: 'a', id: 'first' } });
        const second = buildWorkBoardItemKeyV1({ kind: 'session', qualifiedId: { serverId: 'b', id: 'second' } });
        const port = createWorkBoardArtifactPortV1(b.transport);
        const other = b.rows.get('two');
        await Promise.all([
            port.apply({ kind: 'set_positions', boardId: 'one', positionsByItemRef: { [first]: { x: 10, y: 20 } } }),
            port.apply({ kind: 'set_positions', boardId: 'one', positionsByItemRef: { [second]: { x: 30, y: 40 } } }),
        ]);
        expect((await port.readBoard('one'))?.positionsByItemRef).toEqual({ [first]: { x: 10, y: 20 }, [second]: { x: 30, y: 40 } });
        expect(b.rows.get('two')).toBe(other);
        expect(b.updates).toEqual(['one', 'one']);
    });

    it('lists pin/name/Inbox metadata from headers without opening any body, and drains Artifact pages', async () => {
        const b = createWorkBoardArtifactBoundary([{ ...createWorkBoardV1({ id: 'one', name: 'Pinned' }), pinnedInSessions: true, source: { picked: [], sections: ['needs_you'] } }, createWorkBoardV1({ id: 'two', name: 'Two' })]);
        const items = (await b.transport.list({ limit: 500 })).items;
        const port = createWorkBoardArtifactPortV1({ ...b.transport, list: async options => options.cursor
            ? { items: [items[1]!] } : { items: [items[0]!], nextCursor: 'next' } });
        expect(await port.list()).toEqual([
            { id: 'one', name: 'Pinned', pinnedInSessions: true, source: { sections: ['needs_you'] } },
            { id: 'two', name: 'Two', pinnedInSessions: false, source: { sections: [] } },
        ]);
        expect(b.reads).toEqual([]);
    });

    it('preserves an unreadable Board, unknown kind, unknown header fields and source values on neighboring edits', async () => {
        const future = { ...createWorkBoardV1({ id: 'future', name: 'Future' }), newField: { retained: true } };
        const picked = { kind: 'future-kind', qualifiedId: { serverId: 'a', id: 'new' } };
        const b = createWorkBoardArtifactBoundary([future, { ...createWorkBoardV1({ id: 'one', name: 'One' }), source: { sections: ['needs_you', 'new-section'], picked: [picked] } }]);
        const one = b.rows.get('one')!;
        b.rows.set('one', { ...one, header: { ...one.header, extra: 'retained' } });
        b.rows.set('other-kind', { artifactId: 'other-kind', header: { kind: 'future-board.v2' }, body: 'opaque', revision: { headerVersion: 1, bodyVersion: 1 } });
        const untouched = b.rows.get('future');
        const port = createWorkBoardArtifactPortV1(b.transport);
        await port.apply({ kind: 'update', boardId: 'one', patch: { pinnedInSessions: true, name: 'Renamed' } });
        expect(b.rows.get('future')).toBe(untouched);
        expect(b.rows.get('other-kind')?.body).toBe('opaque');
        expect(b.rows.get('one')?.header).toMatchObject({ title: 'Renamed', pinnedInSessions: true, extra: 'retained' });
        const read = await port.read();
        expect(read.unreadable).toEqual([future]);
        expect(read.boards[0]?.source.unknown).toEqual({ sections: ['new-section'], picked: [picked] });
        await expect(port.apply({ kind: 'update', boardId: 'future', patch: { name: 'Wrong' } })).rejects.toMatchObject({ code: 'invalid_board_record' });
    });

    it('refuses a retired Home/Account after an in-flight read and on Retry', async () => {
        const b = createWorkBoardArtifactBoundary([createWorkBoardV1({ id: 'one', name: 'One' })]);
        let current = true;
        const port = createWorkBoardArtifactPortV1({ ...b.transport, read: async id => {
            const row = await b.transport.read(id); current = false; return row;
        } }, { shouldContinue: () => current });
        const intent = { kind: 'update', boardId: 'one', patch: { name: 'Wrong Account' } } as const;
        await expect(port.apply(intent)).rejects.toMatchObject({ code: 'board_scope_retired' });
        await expect(port.apply(intent)).rejects.toMatchObject({ code: 'board_scope_retired' });
        expect(b.updates).toEqual([]);
    });

    it('does not interpret a same-id non-Board Artifact as Board content', async () => {
        const b = createWorkBoardArtifactBoundary([createWorkBoardV1({ id: 'one', name: 'One' })]);
        const row = b.rows.get('one')!;
        expect(() => readWorkBoardArtifactV1({ ...row, header: { kind: 'role.v1' } })).toThrowError('invalid_board_record');
    });
});
