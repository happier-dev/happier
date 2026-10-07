import { describe, expect, it } from 'vitest';
import { createWorkBoardArtifactBoundary } from './workBoardArtifactV1.testkit.js';
import { buildWorkBoardPreviewLayoutV1, createWorkBoardArtifactPortV1, readWorkBoardArtifactV1, readWorkBoardArtifactSummaryV1, WorkBoardPreviewLayoutV1Schema } from './workBoardArtifactV1.js';
import { buildWorkBoardItemKeyV1, createWorkBoardV1, WorkBoardIntentV1Schema } from './workBoardV1.js';
import { normalizeSessionListFilterV1 } from '../sessions/listFilter/sessionListFilterV1.js';
import { prepareArtifactHeaderForBodyV1, prepareArtifactHeaderForRevisionV1 } from '../artifacts/artifactHeaderRestorationV1.js';
import { createActionExecutor, type ActionExecutorDeps } from '../actions/actionExecutor.js';

describe('one Artifact per Board', () => {
    it('reads only canonical Board header summary and preview fields', () => {
        const known = createWorkBoardV1({ id: 'one', name: 'One' });
        const preview = buildWorkBoardPreviewLayoutV1(known);
        const footprint = { columns: 2, columnSpan: 1, rowSpan: 2 };
        expect(WorkBoardPreviewLayoutV1Schema.parse({ ...preview, obsolete: true,
            source: { ...preview.source, obsolete: true }, widgets: [{ title: 'Snapshot', size: 'medium',
                footprint: { ...footprint, obsolete: true },
                position: { x: 1, y: 2, obsolete: true }, obsolete: true }] })).toEqual({
            ...preview, widgets: [{ title: 'Snapshot', size: 'medium', footprint, position: { x: 1, y: 2 } }],
        });
        expect(WorkBoardPreviewLayoutV1Schema.safeParse({ ...preview, widgets: [{ title: null, size: 'medium' }] }).success).toBe(false);
        expect(WorkBoardPreviewLayoutV1Schema.safeParse({ ...preview, source: { sections: [], pickedCount: 0 } }).success).toBe(false);
        const header = { kind: 'work-board.v1', v: 1, title: 'One', pinnedInSessions: false, readsNeedsYou: false, obsolete: true };
        expect(readWorkBoardArtifactSummaryV1('one', header)).toEqual({ id: 'one', name: 'One', pinnedInSessions: false, source: { sections: [] } });
        const { title: _title, ...missingTitle } = header;
        expect(readWorkBoardArtifactSummaryV1('one', missingTitle)).toBeNull();
    });
    it('reads and lists persisted extras as available, writes canonical fields, and keeps Action inputs closed', async () => {
        const ref = { kind: 'session', qualifiedId: { serverId: 'home', id: 'session' } } as const;
        const key = buildWorkBoardItemKeyV1(ref);
        const known = { ...createWorkBoardV1({ id: 'one', name: 'One' }),
            source: { picked: [ref] }, positionsByItemRef: { [key]: { x: 24, y: 48 } } };
        const stored = { ...known, extra: true, source: { extra: true,
            picked: [{ ...ref, extra: true, qualifiedId: { ...ref.qualifiedId, extra: true } }] },
            positionsByItemRef: { [key]: { ...known.positionsByItemRef[key], extra: true } } };
        const missing = { id: 'missing', name: 'Missing required source', extra: true };
        const boundary = createWorkBoardArtifactBoundary([stored, missing]);
        const port = createWorkBoardArtifactPortV1(boundary.transport);
        const executor = createActionExecutor({ workBoardArtifacts: port } as unknown as ActionExecutorDeps);
        const context = { surface: 'ui', bypassApprovals: true } as const;
        expect(readWorkBoardArtifactV1(boundary.rows.get('one')!)).toEqual(known);
        expect(await executor.execute('boards.list', {}, context)).toEqual({ ok: true, result: { boards: [known] } });
        expect(await port.read()).toEqual({ v: 1, boards: [known], unreadable: [missing] });
        await expect(port.apply({ kind: 'update', boardId: 'missing', patch: { name: 'Overwrite' } }))
            .rejects.toMatchObject({ code: 'invalid_board_record' });
        for (const input of [
            { extra: true, intent: { kind: 'update', boardId: 'one', patch: { name: 'Invalid' } } },
            { intent: { kind: 'update', boardId: 'one', extra: true, patch: { name: 'Invalid' } } },
            { intent: { kind: 'add_items', boardId: 'one', refs: stored.source.picked } },
            { intent: { kind: 'set_positions', boardId: 'one', positionsByItemRef: stored.positionsByItemRef } },
            { intent: { kind: 'update', boardId: 'one', patch: { source: { filter: { ...normalizeSessionListFilterV1(), extra: true } } } } },
        ]) {
            expect(await executor.execute('boards.apply', input, context)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        }
        expect(await executor.execute('boards.list', { extra: true }, context)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(boundary.updates).toEqual([]);
        expect(await executor.execute('boards.apply', { intent: { kind: 'update', boardId: 'one', patch: { name: 'Renamed' } } }, context))
            .toMatchObject({ ok: true, result: { board: { ...known, name: 'Renamed' } } });
        expect(JSON.parse(String(boundary.rows.get('one')?.body))).toEqual({ ...known, name: 'Renamed' });
        expect(JSON.parse(String(boundary.rows.get('missing')?.body))).toEqual(missing);
    });
    it('persists admitted session attribution through Board Actions and refreshes it for the next human edit', async () => {
        const boundary = createWorkBoardArtifactBoundary();
        const writes: unknown[] = [];
        const port = createWorkBoardArtifactPortV1({ ...boundary.transport,
            create: async input => { writes.push(input); return boundary.transport.create(input); },
            update: async input => { writes.push(input); return boundary.transport.update(input); },
        });
        const executor = createActionExecutor({ workBoardArtifacts: port } as unknown as ActionExecutorDeps);
        expect(await executor.execute('boards.apply', { intent: { kind: 'create', board: { id: 'one', name: 'One' } } },
            { surface: 'mcp', bypassApprovals: true, runtimeAccountId: 'account', defaultSessionId: 'other-session',
                actionCaller: { kind: 'session', sessionId: 'admitted-session' } })).toMatchObject({ ok: true });
        expect(writes[0]).toMatchObject({ savedBy: { kind: 'agent', accountId: 'account', sessionId: 'admitted-session' } });
        expect(await executor.execute('boards.apply', { intent: { kind: 'update', boardId: 'one', patch: { name: 'Edited' } } },
            { surface: 'ui', bypassApprovals: true, runtimeAccountId: 'account', actionCaller: { kind: 'host' } })).toMatchObject({ ok: true });
        expect(writes[1]).toMatchObject({ savedBy: { kind: 'person', accountId: 'account' } });
        expect(boundary.rows.get('one')?.header).not.toHaveProperty('savedBy');
        expect(JSON.parse(String(boundary.rows.get('one')?.body))).not.toHaveProperty('savedBy');
    });
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
            port.apply(WorkBoardIntentV1Schema.parse({ kind: 'widget_size', boardId: 'one', ref, size: 'full' })),
            port.apply({ kind: 'add_items', boardId: 'one', refs: [{ kind: 'session', qualifiedId: { serverId: 'home', id: 's1' } }], positionsByItemRef: { [workKey]: { x: 36, y: 48 } } }),
        ]);
        await port.apply(WorkBoardIntentV1Schema.parse({ kind: 'widget_move', boardId: 'one', ref, nativeIndex: 2 }));
        const board = await createWorkBoardArtifactPortV1(b.transport).readBoard('one');
        expect(board?.widgets).toMatchObject([{ instance: { id: 'copy-a', bindings: { count: { kind: 'value', value: 7 } } }, size: 'full' }, { instance: { id: 'copy-b', bindings: {} }, size: 'medium' }]);
        expect(board?.itemOrder?.[2]).toBe(JSON.stringify(['widget', 'home', 'account', 'one', 'copy-a']));
        expect(board?.positionsByItemRef).toEqual({ [workKey]: { x: 36, y: 48 }, [JSON.stringify(['widget', 'home', 'account', 'one', 'copy-a'])]: { x: 12, y: 24 } });
        const previewLayout = { mode: 'canvas', source: { sections: [], hasFilter: false, pickedCount: 1 },
            widgets: [{ title: null, size: 'medium', footprint: { columns: 2, columnSpan: 1, rowSpan: 2 } },
                { title: null, size: 'full', footprint: { columns: 2, columnSpan: 2, rowSpan: 2 }, position: { x: 12, y: 24 } }] };
        expect(b.rows.get('one')?.header.previewLayout).toEqual(previewLayout);
        // Generic writes and restores cannot retain a displaced layout projection.
        const header = { ...b.rows.get('one')!.header, previewLayout: { stale: true } };
        expect(prepareArtifactHeaderForBodyV1(header, JSON.stringify(board)).previewLayout).toEqual(previewLayout);
        expect(prepareArtifactHeaderForRevisionV1({ artifactId: 'one', header, body: JSON.stringify(board),
            expectedRevision: { headerVersion: 1, bodyVersion: 1 }, nextRevision: { headerVersion: 2, bodyVersion: 2 } }).previewLayout).toEqual(previewLayout);
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
        expect(b.rows.get('one')?.header.previewLayout).toMatchObject({ source: { sections: [], hasFilter: true, pickedCount: 1 } });
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

    it('isolates content-unavailable exact reads through boards.list and direct Board reads without rewriting the record', async () => {
        const valid = createWorkBoardV1({ id: 'valid', name: 'Valid' });
        const malformed = { id: 'malformed', name: 'Missing required source', futureField: true };
        const b = createWorkBoardArtifactBoundary([createWorkBoardV1({ id: 'unavailable', name: 'Unavailable' }), malformed, valid]);
        const original = b.rows.get('unavailable');
        const published = new Map<string, unknown>();
        const port = createWorkBoardArtifactPortV1({ ...b.transport, read: async (id, options) => {
            if (id === 'unavailable') throw Object.assign(new Error('Artifact content is unavailable'), { code: 'content_unavailable' });
            return b.transport.read(id, options);
        } }, { onBoard: (id, board) => { published.set(id, board); } });
        const executor = createActionExecutor({ workBoardArtifacts: port } as unknown as ActionExecutorDeps);
        const context = { surface: 'ui', bypassApprovals: true } as const;

        expect(await executor.execute('boards.list', {}, context)).toEqual({ ok: true, result: { boards: [valid] } });
        expect(await port.read()).toEqual({ v: 1, boards: [valid], unreadable: [{ id: 'unavailable' }, malformed] });
        expect(published.get('unavailable')).toBeNull();
        expect(published.get('malformed')).toBeNull();
        expect(await port.readBoard('unavailable')).toBeNull();
        expect(await port.readBoard('valid')).toEqual(valid);
        for (const intent of [
            { kind: 'update', boardId: 'unavailable', patch: { name: 'Overwrite' } },
            { kind: 'delete', boardId: 'unavailable' },
            { kind: 'create', board: { id: 'unavailable', name: 'Overwrite' } },
        ] as const) {
            expect(await executor.execute('boards.apply', { intent }, context))
                .toMatchObject({ ok: false, errorCode: 'invalid_board_record' });
        }
        expect(await executor.execute('boards.apply', { intent: { kind: 'update', boardId: 'valid', patch: { name: 'Renamed' } } }, context))
            .toMatchObject({ ok: true, result: { board: { id: 'valid', name: 'Renamed' } } });
        expect(b.rows.get('unavailable')).toBe(original);
        expect(b.updates).toEqual(['valid']);
    });

    it.each(['abort', 'retire'] as const)('does not hide %s during a content-unavailable exact read', async mode => {
        const b = createWorkBoardArtifactBoundary([createWorkBoardV1({ id: 'one', name: 'One' })]);
        const controller = new AbortController();
        const cancellation = new Error('Cancelled');
        let current = true;
        const port = createWorkBoardArtifactPortV1({ ...b.transport, read: async () => {
            if (mode === 'abort') controller.abort(cancellation);
            else current = false;
            throw Object.assign(new Error('Artifact content is unavailable'), { code: 'content_unavailable' });
        } }, { shouldContinue: () => current });
        if (mode === 'abort') await expect(port.read(controller.signal)).rejects.toBe(cancellation);
        else await expect(port.read(controller.signal)).rejects.toMatchObject({ code: 'board_scope_retired' });
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
        const future = { id: 'future', name: 'Missing required source', newField: { retained: true } };
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
