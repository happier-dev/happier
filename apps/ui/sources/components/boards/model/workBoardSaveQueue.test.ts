import { describe, expect, it } from 'vitest';
import { buildWorkBoardItemKeyV1, createWorkBoardV1, WorkBoardsV1Schema, type BoardItemRefV1, type WorkBoardArtifactV1 } from '@happier-dev/protocol';
import { createWorkBoardArtifactBoundary } from '@/dev/testkit/harness/workBoardArtifactBoundary';
import { createWorkBoardAccountStore } from './workBoardAccountStore';
import { projectDisplayedWorkBoards } from './workBoardSaveQueue';

const session = (id: string): BoardItemRefV1 => ({ kind: 'session', qualifiedId: { serverId: 'home-a', id } });
const base = WorkBoardsV1Schema.parse({ v: 1, boards: [{ ...createWorkBoardV1({ id: 'b1', name: 'Overview' }), source: { picked: [session('s1')] } }] });

/** Artifact CAS is the persistence boundary; reducer, rebase, queue and projection remain real. */
function boundary() {
    const persistence = createWorkBoardArtifactBoundary(base);
    let current = true;
    const store = createWorkBoardAccountStore(persistence.transport, () => current);
    return { store, ...persistence, retire: () => { current = false; } };
}

describe('WorkBoard Account Artifact save queue', () => {
    it('keeps an acknowledged add renderable while its pending intent is still being retired', async () => {
        const b = boundary(); await b.store.refresh();
        const surface = { serverId: 'home-a', accountId: 'owner', owner: { kind: 'workBoard', boardId: 'b1' } } as const;
        const instance = { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'changes' }, bindings: {} } as const;
        const observed: number[] = [];
        const release = b.store.subscribe(() => {
            observed.push(projectDisplayedWorkBoards(b.store.getBoards(), b.store.queue.getState().pending).boards[0]?.widgets?.length ?? 0);
        });
        try {
            expect(await b.store.queue.dispatch({ kind: 'widget_add', boardId: 'b1', ref: { surface, instanceId: instance.id }, instance })).toMatchObject({ status: 'applied' });
            expect(observed).toContain(1);
            expect(b.store.queue.getState().failure).toBeNull();
        } finally { release(); }
    });
    it('projects configured widgets, rolls back a failed input edit, retries and reloads without losing work', async () => {
        const b = boundary();
        await b.store.refresh();
        const surface = { serverId: 'home-a', accountId: 'owner', owner: { kind: 'workBoard', boardId: 'b1' } } as const;
        const instance = { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'changes' }, bindings: {} } as const;
        const ref = { surface, instanceId: instance.id };
        const release = b.hold();
        const saving = b.store.queue.dispatch({ kind: 'widget_add', boardId: 'b1', ref, instance, width: 2 });
        expect(projectDisplayedWorkBoards(b.store.getBoards(), b.store.queue.getState().pending).boards[0]?.widgets).toMatchObject([{ instance, width: 2 }]);
        release(); expect(await saving).toMatchObject({ status: 'applied' });
        b.offline(true);
        expect(await b.store.queue.dispatch({ kind: 'widget_inputs', boardId: 'b1', ref, bindings: { session: { kind: 'value', value: 's2' } } })).toMatchObject({ status: 'unknown' });
        expect(b.store.getBoards().boards[0]?.widgets?.[0]?.instance.bindings).toEqual({});
        b.offline(false); await b.store.queue.retry();
        const loaded = createWorkBoardAccountStore(b.transport, () => true);
        await loaded.refresh();
        expect(loaded.getBoards().boards[0]?.widgets).toMatchObject([{ instance: { id: 'copy', bindings: { session: { kind: 'value', value: 's2' } } }, width: 2 }]);
        expect(loaded.getBoards().boards[0]?.source.picked).toEqual(base.boards[0]?.source.picked);
        expect(await b.store.queue.dispatch({ kind: 'widget_add', boardId: 'b1', ref, instance })).toMatchObject({ status: 'refused', code: 'widget_instance_already_exists' });
    });
    it('returns the acknowledged outcome instead of reporting a refused or unknown write as applied', async () => {
        const b = boundary();
        expect(await b.store.queue.dispatch({ kind: 'update', boardId: 'b1', patch: { name: 'Acknowledged' } }))
            .toMatchObject({ status: 'applied' });
        expect(await b.store.queue.dispatch({ kind: 'add_items', boardId: 'gone', refs: [session('s2')] }))
            .toMatchObject({ status: 'refused', code: 'board_not_found' });
        b.offline(true);
        expect(await b.store.queue.dispatch({ kind: 'update', boardId: 'b1', patch: { name: 'Uncertain' } }))
            .toMatchObject({ status: 'unknown' });
        expect(b.acknowledged().boards[0]!.name).toBe('Acknowledged');
    });
    it('settles an admitted edit after the last Board view detaches', async () => {
        const b = boundary();
        const releaseView = b.store.retainView(() => () => {});
        const releaseTransport = b.hold();
        const saving = b.store.queue.dispatch({ kind: 'update', boardId: 'b1', patch: { name: 'After navigation' } });
        releaseView(); releaseTransport(); await saving;
        expect(b.acknowledged().boards[0]!.name).toBe('After navigation');
        expect(b.store.queue.getState()).toEqual({ pending: [], failure: null });
    });

    it('exposes an unavailable refresh with Retry while retaining the acknowledged record', async () => {
        const b = boundary();
        await b.store.refresh(); b.offline(true);
        await b.store.refresh();
        expect(b.store.getReadState()).toMatchObject({ status: 'error', hasSnapshot: true });
        expect(b.store.getBoards()).toEqual(base);
        b.offline(false); await b.store.refresh();
        expect(b.store.getReadState()).toMatchObject({ status: 'ready', hasSnapshot: true });
    });

    it('withdraws a malformed Board without overwriting its bytes and recovers when its content becomes readable', async () => {
        const b = boundary();
        await b.store.refresh(); const original = b.rows.get('b1')!;
        b.rows.set('b1', { ...original, body: 'invalid-json' });
        await b.store.refresh();
        expect(b.store.getReadState()).toMatchObject({ status: 'ready', hasSnapshot: true });
        expect(b.store.getBoards().boards).toEqual([]);
        expect(b.rows.get('b1')?.body).toBe('invalid-json');
        b.rows.set('b1', original); await b.store.refresh();
        expect(b.store.getReadState()).toMatchObject({ status: 'ready', hasSnapshot: true });
    });

    it('publishes an initially demanded readable neighbor when one Board has malformed JSON', async () => {
        const persistence = createWorkBoardArtifactBoundary(WorkBoardsV1Schema.parse({ v: 1, boards: [...base.boards, createWorkBoardV1({ id: 'b2', name: 'Other' })] }));
        const broken = { ...persistence.rows.get('b1')!, body: '{ invalid-json' };
        persistence.rows.set('b1', broken);
        const store = createWorkBoardAccountStore(persistence.transport, () => true);
        const release = store.retainView(() => () => {}, 'all');
        try {
            await store.refresh();
            expect(store.getReadState()).toMatchObject({ status: 'ready', hasSnapshot: true });
            expect(store.getBoards().boards.map(board => board.id)).toEqual(['b2']);
            expect(store.getSummaries().map(board => board.id)).toEqual(['b1', 'b2']);
            expect(persistence.rows.get('b1')).toBe(broken);
        } finally { release(); }
    });

    it('withdraws an unreadable Board projection without rewriting it or hiding readable neighbors', async () => {
        const persistence = createWorkBoardArtifactBoundary(WorkBoardsV1Schema.parse({ v: 1, boards: [...base.boards, createWorkBoardV1({ id: 'b2', name: 'Other' })] }));
        const store = createWorkBoardAccountStore(persistence.transport, () => true);
        await store.refresh();
        const row = persistence.rows.get('b1')!;
        const future = { ...row, body: JSON.stringify({ ...base.boards[0], futureField: true }), revision: { headerVersion: 2, bodyVersion: 2 } };
        persistence.rows.set('b1', future);
        await store.refresh();
        expect(store.getReadState().status).toBe('ready');
        expect(store.getBoards().boards.map(board => board.id)).toEqual(['b2']);
        expect(persistence.rows.get('b1')).toBe(future);
    });

    it('keeps a newer write acknowledgement when an older refresh returns later', async () => {
        const persistence = createWorkBoardArtifactBoundary(base);
        const original = persistence.rows.get('b1')!;
        let resolveOld!: (value: WorkBoardArtifactV1) => void;
        let markReading!: () => void;
        const reading = new Promise<void>(resolve => { markReading = resolve; });
        let first = true;
        const store = createWorkBoardAccountStore({
            ...persistence.transport,
            read: async id => {
                if (first) { first = false; markReading(); return await new Promise(resolve => { resolveOld = resolve; }); }
                return persistence.transport.read(id);
            },
        }, () => true);
        const refresh = store.refresh();
        await reading;
        await store.queue.dispatch({ kind: 'update', boardId: 'b1', patch: { name: 'Newer' } });
        resolveOld(original); await refresh;
        expect(store.getBoards().boards[0]!.name).toBe('Newer');
    });

    it('does not resurrect a deleted Board when an older body refresh arrives', async () => {
        const persistence = createWorkBoardArtifactBoundary(base);
        const original = persistence.rows.get('b1')!;
        let resolveOld!: (value: WorkBoardArtifactV1) => void;
        let markReading!: () => void;
        const reading = new Promise<void>(resolve => { markReading = resolve; });
        let first = true;
        const store = createWorkBoardAccountStore({ ...persistence.transport, read: async id => {
            if (first) { first = false; markReading(); return await new Promise(resolve => { resolveOld = resolve; }); }
            return persistence.transport.read(id);
        } }, () => true);
        const refresh = store.refresh(); await reading;
        await store.queue.dispatch({ kind: 'delete', boardId: 'b1' });
        resolveOld(original); await refresh;
        expect(store.getBoards().boards).toEqual([]);
        expect(store.getSummaries()).toEqual([]);
    });

    it('serves pin chrome from headers and loads only a demanded Board body', async () => {
        const persistence = createWorkBoardArtifactBoundary(WorkBoardsV1Schema.parse({ v: 1, boards: [...base.boards, createWorkBoardV1({ id: 'b2', name: 'Other' })] }));
        const store = createWorkBoardAccountStore(persistence.transport, () => true);
        const releaseHeaders = store.retainView(() => () => {}, 'headers');
        await store.refresh();
        expect(store.getSummaries().map(board => board.id)).toEqual(['b1', 'b2']);
        expect(persistence.reads).toEqual([]);
        const releaseBody = store.retainView(() => () => {}, 'board:b1');
        await store.refresh();
        expect(persistence.reads).toEqual(['b1']);
        releaseBody(); releaseHeaders();
    });

    it('acknowledges a newly created Board after its same id was deleted', async () => {
        const b = boundary();
        await b.store.queue.dispatch({ kind: 'update', boardId: 'b1', patch: { name: 'Before deletion' } });
        await b.store.queue.dispatch({ kind: 'delete', boardId: 'b1' });
        await b.store.queue.dispatch({ kind: 'create', board: { id: 'b1', name: 'Recreated' } });
        expect(b.store.queue.getState().failure).toBeNull();
        expect(b.store.getBoards().boards[0]?.name).toBe('Recreated');
    });

    it('loads independent Board bodies in parallel and publishes them in inventory order', async () => {
        const persistence = createWorkBoardArtifactBoundary(WorkBoardsV1Schema.parse({ v: 1, boards: [...base.boards, createWorkBoardV1({ id: 'b2', name: 'Other' })] }));
        let releaseFirst!: () => void;
        const firstResponse = new Promise<void>(resolve => { releaseFirst = resolve; });
        let startedFirst!: () => void;
        const firstRequest = new Promise<void>(resolve => { startedFirst = resolve; });
        let inFlight = 0;
        let peak = 0;
        const store = createWorkBoardAccountStore({ ...persistence.transport, read: async id => {
            inFlight++; peak = Math.max(peak, inFlight);
            if (id === 'b1') { startedFirst(); await firstResponse; }
            const row = await persistence.transport.read(id);
            inFlight--; return row;
        } }, () => true);
        const refresh = store.refresh(); await firstRequest;
        // Flush the other independent response; the first remains held at the persistence boundary.
        await new Promise<void>(resolve => { setTimeout(resolve, 0); });
        try { expect(peak).toBe(2); }
        finally { releaseFirst(); await refresh; }
        expect(store.getBoards().boards.map(board => board.id)).toEqual(['b1', 'b2']);
    });

    it('projects an edit immediately and keeps it once the dedicated record acknowledges it', async () => {
        const b = boundary();
        await b.store.refresh();
        const release = b.hold();
        const key = buildWorkBoardItemKeyV1(session('s1'));
        const saving = b.store.queue.dispatch({ kind: 'set_positions', boardId: 'b1', positionsByItemRef: { [key]: { x: 48, y: 96 } } });
        expect(projectDisplayedWorkBoards(b.store.getBoards(), b.store.queue.getState().pending).boards[0]!.positionsByItemRef).toEqual({ [key]: { x: 48, y: 96 } });
        release(); await saving;
        expect(b.store.queue.getState()).toEqual({ pending: [], failure: null });
        expect(b.store.getBoards().boards[0]!.positionsByItemRef).toEqual({ [key]: { x: 48, y: 96 } });
    });

    it('saves membership larger than Account settings bounds without dropping valid items', async () => {
        const b = boundary();
        await b.store.queue.dispatch({ kind: 'add_items', boardId: 'b1', refs: Array.from({ length: 300 }, (_, i) => session(`extra-${i}`)) });
        expect(b.store.queue.getState().failure).toBeNull();
        expect(b.acknowledged().boards[0]!.source.picked).toHaveLength(301);
    });

    it('retains acknowledged data on unavailable writes and retries the same semantic intent', async () => {
        const b = boundary();
        await b.store.refresh(); b.offline(true);
        await b.store.queue.dispatch({ kind: 'update', boardId: 'b1', patch: { mode: 'by_status' } });
        expect(b.store.queue.getState().failure?.reason).toBe('unavailable');
        expect(b.store.getBoards().boards[0]!.mode).toBe('canvas');
        b.offline(false); await b.store.queue.retry();
        expect(b.store.queue.getState().failure).toBeNull();
        expect(b.store.getBoards().boards[0]!.mode).toBe('by_status');
    });

    it('does not commit queued intents after their scope retires, including Retry', async () => {
        const b = boundary();
        const release = b.hold();
        const saving = b.store.queue.dispatch({ kind: 'create', board: { id: 'new', name: 'New' } });
        await Promise.resolve(); b.retire(); release(); await saving;
        expect(b.acknowledged()).toEqual(base);
        expect(b.store.queue.getState().failure?.reason).toBe('unavailable');
        await b.store.queue.retry();
        expect(b.acknowledged()).toEqual(base);
    });
});
