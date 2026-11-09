import { describe, expect, it } from 'vitest';
import { buildWorkBoardItemKeyV1, createWorkBoardV1, WorkBoardsV1Schema, type BoardItemRefV1} from '@happier-dev/protocol/boards/workBoardV1';
import { type WorkBoardArtifactV1 } from '@happier-dev/protocol/boards/workBoardArtifactV1';
import { createWorkBoardArtifactBoundary } from '@/dev/testkit/harness/workBoardArtifactBoundary';
import { createDeferred } from '@/dev/testkit';
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

/** These recovery cases explicitly reopen/retry every Board, rather than demand a header refresh. */
async function readBoards(store: ReturnType<typeof createWorkBoardAccountStore>) {
    const release = store.retainView(() => () => {}, 'all');
    store.invalidateBodies();
    try { await store.refresh(); } finally { release(); }
}

describe('WorkBoard Account Artifact save queue', () => {
    it('forgets a removed header revision before a header-only Board id is recreated', async () => {
        const persistence = createWorkBoardArtifactBoundary(base);
        const original = persistence.rows.get('b1')!;
        persistence.rows.set('b1', { ...original, revision: { headerVersion: 7, bodyVersion: 7 } });
        const store = createWorkBoardAccountStore(persistence.transport, () => true);
        const release = store.retainView(() => () => {}, 'headers');
        try {
            await store.refresh();
            persistence.rows.delete('b1');
            await store.refresh();
            expect(store.getSummaries()).toEqual([]);
            const replacement = createWorkBoardArtifactBoundary({ v: 1, boards: [{ ...base.boards[0]!, name: 'Recreated' }] });
            persistence.rows.set('b1', replacement.rows.get('b1')!);
            await store.refresh();
            expect(store.getSummaries()[0]?.name).toBe('Recreated');
            expect(persistence.reads).toEqual([]);
        } finally { release(); }
    });
    it('refreshes an invalidated demanded body without re-listing its unchanged inventory', async () => {
        const persistence = createWorkBoardArtifactBoundary(base);
        let lists = 0;
        const store = createWorkBoardAccountStore({ ...persistence.transport, list: async options => {
            lists++;
            return persistence.transport.list(options);
        } }, () => true);
        const release = store.retainView(() => () => {}, 'board:b1');
        try {
            await store.refresh();
            lists = 0;
            persistence.reads.length = 0;
            const old = persistence.rows.get('b1')!;
            persistence.rows.set('b1', { ...old, body: JSON.stringify({ ...base.boards[0], name: 'Pushed change' }),
                revision: { ...old.revision, bodyVersion: old.revision.bodyVersion + 1 } });
            store.invalidateBodies(['b1']);
            await store.refresh({ inventory: false });
            expect(store.getBoard('b1')?.name).toBe('Pushed change');
            expect(persistence.reads).toEqual(['b1']);
            expect(lists).toBe(0);
        } finally { release(); }
    });
    it('continues only the surviving exact Board demand after a delayed inventory', async () => {
        const persistence = createWorkBoardArtifactBoundary({ v: 1, boards: [...base.boards, createWorkBoardV1({ id: 'b2', name: 'Other' })] });
        const started = createDeferred<void>();
        const response = createDeferred<void>();
        const store = createWorkBoardAccountStore({ ...persistence.transport, list: async options => {
            started.resolve();
            await response.promise;
            return persistence.transport.list(options);
        } }, () => true);
        const releaseFirst = store.retainView(() => () => {}, 'board:b1');
        const releaseSecond = store.retainView(() => () => {}, 'board:b2');
        const refreshing = store.refresh();
        try {
            await started.promise;
            releaseFirst();
            response.resolve();
            await refreshing;
            expect(persistence.reads).toEqual(['b2']);
            expect(store.getBoards().boards.map(board => board.id)).toEqual(['b2']);
        } finally { response.resolve(); releaseSecond(); await refreshing; }
    });

    it('retains an admitted body after close and postpones its invalidated follow-up until reopen', async () => {
        const persistence = createWorkBoardArtifactBoundary(base);
        const started = createDeferred<void>();
        const response = createDeferred<WorkBoardArtifactV1>();
        let reads = 0;
        const store = createWorkBoardAccountStore({ ...persistence.transport, read: async (id, options) => {
            if (++reads === 1) { started.resolve(); return response.promise; }
            return persistence.transport.read(id, options);
        } }, () => true);
        const release = store.retainView(() => () => {}, 'board:b1');
        const refreshing = store.refresh();
        const original = persistence.rows.get('b1')!;
        try {
            await started.promise;
            persistence.rows.set('b1', { ...original, body: JSON.stringify({ ...base.boards[0], name: 'Fresh after reopen' }),
                revision: { headerVersion: 2, bodyVersion: 2 } });
            store.invalidateBodies(['b1']);
            release();
            response.resolve(original);
            await refreshing;
            expect(reads).toBe(1);
            expect(store.getBoard('b1')?.name).toBe('Overview');
            const reopen = store.retainView(() => () => {}, 'board:b1');
            try {
                await store.refresh();
                expect(reads).toBe(2);
                expect(store.getBoard('b1')?.name).toBe('Fresh after reopen');
            } finally { reopen(); }
        } finally { response.resolve(original); release(); await refreshing; }
    });

    it.each(['inputs', 'size'] as const)('does not acknowledge an older uncertain add as a changed %s request', async changed => {
        const b = boundary();
        let readable = true;
        const store = createWorkBoardAccountStore({ ...b.transport,
            read: async (id, options) => { if (!readable) throw new Error('Read-back unavailable'); return b.transport.read(id, options); },
            update: async input => { await b.transport.update(input); readable = false; throw new Error('Acknowledgement lost'); },
        }, () => true);
        const instance = { v: 1, id: 'changed-copy', definition: { kind: 'builtin', id: 'changes' }, bindings: {} } as const;
        const ref = { surface: { serverId: 'home-a', accountId: 'owner', owner: { kind: 'workBoard', boardId: 'b1' } }, instanceId: instance.id } as const;
        expect(await store.queue.dispatch({ kind: 'widget_add', boardId: 'b1', ref, instance, size: 'medium' })).toMatchObject({ status: 'unknown' });
        const committed = b.rows.get('b1');
        readable = true;
        expect(await store.queue.dispatch({ kind: 'widget_add', boardId: 'b1', ref,
            instance: changed === 'inputs' ? { ...instance, bindings: { session: { kind: 'value', value: 'changed-session' } } } : instance,
            size: changed === 'size' ? 'wide' : 'medium',
        })).toMatchObject({ status: 'refused', code: 'widget_instance_already_exists' });
        expect(b.rows.get('b1')).toBe(committed);
    });
    it('reads back a committed add after its acknowledgement is lost', async () => {
        const b = boundary();
        const store = createWorkBoardAccountStore({ ...b.transport, update: async input => {
            await b.transport.update(input);
            throw new Error('Acknowledgement lost');
        } }, () => true);
        const instance = { v: 1, id: 'lost-ack', definition: { kind: 'builtin', id: 'changes' }, bindings: {} } as const;
        const ref = { surface: { serverId: 'home-a', accountId: 'owner', owner: { kind: 'workBoard', boardId: 'b1' } }, instanceId: instance.id } as const;
        expect(await store.queue.dispatch({ kind: 'widget_add', boardId: 'b1', ref, instance })).toMatchObject({ status: 'applied' });
        expect(store.queue.getState()).toEqual({ pending: [], failure: null });
        expect(store.getBoard('b1')?.widgets?.map(item => item.instance.id)).toEqual(['lost-ack']);
        expect(b.rows.get('b1')?.revision.bodyVersion).toBe(2);
    });
    it.each(['before_retry', 'during_retry'] as const)('reconciles one add when its original write commits %s', async lateCommit => {
        const b = boundary();
        let original: Parameters<typeof b.transport.update>[0] | undefined;
        let readUnavailable = true;
        const store = createWorkBoardAccountStore({ ...b.transport,
            read: async (id, options) => {
                if (original && readUnavailable) throw new Error('Read-back unavailable');
                return b.transport.read(id, options);
            },
            update: async input => {
                if (!original) { original = input; throw new Error('Write outcome unknown'); }
                if (lateCommit === 'during_retry') await b.transport.update(original);
                return b.transport.update(input);
            },
        }, () => true);
        const instance = { v: 1, id: 'late-copy', definition: { kind: 'builtin', id: 'changes' }, bindings: {} } as const;
        const ref = { surface: { serverId: 'home-a', accountId: 'owner', owner: { kind: 'workBoard', boardId: 'b1' } }, instanceId: instance.id } as const;
        expect(await store.queue.dispatch({ kind: 'widget_add', boardId: 'b1', ref, instance })).toMatchObject({ status: 'unknown' });
        // An unavailable read-back cannot authorize another write.
        expect(await store.queue.retry()).toMatchObject({ status: 'unknown' });
        expect(b.rows.get('b1')?.revision.bodyVersion).toBe(1);
        readUnavailable = false;
        if (lateCommit === 'before_retry') await b.transport.update(original!);
        expect(await store.queue.retry()).toMatchObject({ status: 'applied' });
        expect(store.queue.getState()).toEqual({ pending: [], failure: null });
        expect(store.getBoard('b1')?.widgets?.map(item => item.instance.id)).toEqual(['late-copy']);
        expect(b.rows.get('b1')?.revision.bodyVersion).toBe(2);
    });
    it('keeps every external-store snapshot stable when an inventory refresh changes nothing', async () => {
        const b = boundary();
        const releaseView = b.store.retainView(() => () => {}, 'headers');
        try {
            await b.store.refresh();
            const snapshots = [b.store.getReadState(), b.store.getSummaries(), b.store.getBoards()];
            let notifications = 0;
            const release = b.store.subscribe(() => { notifications++; });
            try {
                await b.store.refresh();
                expect(b.store.getReadState()).toBe(snapshots[0]);
                expect(b.store.getSummaries()).toBe(snapshots[1]);
                expect(b.store.getBoards()).toBe(snapshots[2]);
                expect(notifications).toBe(0);
            } finally { release(); }
        } finally { releaseView(); }
    });
    it('reloads the old source before acknowledgement and the edited source after acknowledgement', async () => {
        const b = boundary();
        let release!: () => void;
        const writeGate = new Promise<void>(resolve => { release = resolve; });
        const store = createWorkBoardAccountStore({ ...b.transport, update: async input => {
            await writeGate;
            return b.transport.update(input);
        } }, () => true);
        await readBoards(store);
        const saving = store.queue.dispatch({ kind: 'update', boardId: 'b1', patch: { source: { sections: ['my_machines'] } } });
        expect(projectDisplayedWorkBoards(store.getBoards(), store.queue.getState().pending).boards[0]?.source.sections)
            .toEqual(['my_machines']);
        const beforeAck = createWorkBoardAccountStore(b.transport, () => true);
        // Hold only the write boundary; a fresh reader still sees acknowledged bytes.
        await readBoards(beforeAck);
        expect(beforeAck.getBoards().boards[0]?.source.sections ?? []).toEqual([]);
        release();
        expect(await saving).toMatchObject({ status: 'applied' });
        const afterAck = createWorkBoardAccountStore(b.transport, () => true);
        await readBoards(afterAck);
        expect(afterAck.getBoards().boards[0]?.source.sections).toEqual(['my_machines']);
        expect(store.queue.getState().pending).toEqual([]);
    });
    it('keeps an acknowledged add renderable while its pending intent is still being retired', async () => {
        const b = boundary(); await readBoards(b.store);
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
        await readBoards(b.store);
        const surface = { serverId: 'home-a', accountId: 'owner', owner: { kind: 'workBoard', boardId: 'b1' } } as const;
        const instance = { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'changes' }, bindings: {} } as const;
        const ref = { surface, instanceId: instance.id };
        const release = b.hold();
        const saving = b.store.queue.dispatch({ kind: 'widget_add', boardId: 'b1', ref, instance, size: 'full' });
        expect(projectDisplayedWorkBoards(b.store.getBoards(), b.store.queue.getState().pending).boards[0]?.widgets).toMatchObject([{ instance, size: 'full' }]);
        release(); expect(await saving).toMatchObject({ status: 'applied' });
        b.offline(true);
        expect(await b.store.queue.dispatch({ kind: 'widget_inputs', boardId: 'b1', ref, bindings: { session: { kind: 'value', value: 's2' } } })).toMatchObject({ status: 'unknown' });
        expect(b.store.getBoards().boards[0]?.widgets?.[0]?.instance.bindings).toEqual({});
        b.offline(false); await b.store.queue.retry();
        const loaded = createWorkBoardAccountStore(b.transport, () => true);
        await readBoards(loaded);
        expect(loaded.getBoards().boards[0]?.widgets).toMatchObject([{ instance: { id: 'copy', bindings: { session: { kind: 'value', value: 's2' } } }, size: 'full' }]);
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
        await readBoards(b.store); b.offline(true);
        await readBoards(b.store);
        expect(b.store.getReadState()).toMatchObject({ status: 'error', hasSnapshot: true });
        expect(b.store.getBoardReadState('b1')).toMatchObject({ status: 'error', hasSnapshot: true });
        expect(b.store.getBoards()).toEqual(base);
        b.offline(false); await readBoards(b.store);
        expect(b.store.getReadState()).toMatchObject({ status: 'ready', hasSnapshot: true });
    });

    it('withdraws a malformed Board without overwriting its bytes and recovers when its content becomes readable', async () => {
        const b = boundary();
        await readBoards(b.store); const original = b.rows.get('b1')!;
        b.rows.set('b1', { ...original, body: 'invalid-json' });
        await readBoards(b.store);
        expect(b.store.getReadState()).toMatchObject({ status: 'ready', hasSnapshot: true });
        expect(b.store.getBoards().boards).toEqual([]);
        expect(b.rows.get('b1')?.body).toBe('invalid-json');
        b.rows.set('b1', original); await readBoards(b.store);
        expect(b.store.getReadState()).toMatchObject({ status: 'ready', hasSnapshot: true });
    });

    it.each(['malformed_json', 'content_unavailable'] as const)('publishes an initially demanded readable neighbor when one Board has %s', async failure => {
        const persistence = createWorkBoardArtifactBoundary(WorkBoardsV1Schema.parse({ v: 1, boards: [...base.boards, createWorkBoardV1({ id: 'b2', name: 'Other' })] }));
        const broken = { ...persistence.rows.get('b1')!, body: '{ invalid-json' };
        persistence.rows.set('b1', broken);
        const store = createWorkBoardAccountStore({ ...persistence.transport, read: async (id, options) => {
            if (id === 'b1' && failure === 'content_unavailable') {
                throw Object.assign(new Error('Artifact content is unavailable'), { code: 'content_unavailable' });
            }
            return persistence.transport.read(id, options);
        } }, () => true);
        const release = store.retainView(() => () => {}, 'all');
        try {
            await store.refresh();
            expect(store.getReadState()).toMatchObject({ status: 'ready', hasSnapshot: true });
            expect(store.getBoards().boards.map(board => board.id)).toEqual(['b2']);
            expect(store.getSummaries().map(board => board.id)).toEqual(['b1', 'b2']);
            expect(persistence.rows.get('b1')).toBe(broken);
        } finally { release(); }
    });

    it('keeps a failed body local to its Board while the index and readable neighbor remain ready', async () => {
        const persistence = createWorkBoardArtifactBoundary(WorkBoardsV1Schema.parse({ v: 1,
            boards: [...base.boards, createWorkBoardV1({ id: 'b2', name: 'Other' })] }));
        let failed = true;
        const store = createWorkBoardAccountStore({ ...persistence.transport, read: async (id, options) => {
            if (id === 'b1' && failed) throw new Error('Network unavailable');
            return persistence.transport.read(id, options);
        } }, () => true);
        const release = store.retainView(() => () => {}, 'all');
        try {
            await store.refresh();
            expect(store.getReadState()).toMatchObject({ status: 'ready', hasSnapshot: true });
            expect(store.getBoardReadState('b1')).toMatchObject({ status: 'error', hasSnapshot: false });
            expect(store.getBoardReadState('b2')).toMatchObject({ status: 'ready', hasSnapshot: true });
            expect(store.getBoards().boards.map(board => board.id)).toEqual(['b2']);
            failed = false;
            await store.refresh();
            expect(store.getBoardReadState('b1')).toMatchObject({ status: 'ready', hasSnapshot: true });
            expect(store.getBoards().boards.map(board => board.id)).toEqual(['b1', 'b2']);
        } finally { release(); }
    });

    it('withdraws an unreadable Board projection without rewriting it or hiding readable neighbors', async () => {
        const persistence = createWorkBoardArtifactBoundary(WorkBoardsV1Schema.parse({ v: 1, boards: [...base.boards, createWorkBoardV1({ id: 'b2', name: 'Other' })] }));
        const store = createWorkBoardAccountStore(persistence.transport, () => true);
        await readBoards(store);
        const row = persistence.rows.get('b1')!;
        const invalid = { ...row, body: JSON.stringify({ ...base.boards[0], name: 42 }), revision: { headerVersion: 2, bodyVersion: 2 } };
        persistence.rows.set('b1', invalid);
        await readBoards(store);
        expect(store.getReadState().status).toBe('ready');
        expect(store.getBoards().boards.map(board => board.id)).toEqual(['b2']);
        expect(persistence.rows.get('b1')).toBe(invalid);
    });

    it('publishes a delayed Board body despite a write acknowledgement to another Board', async () => {
        const persistence = createWorkBoardArtifactBoundary(WorkBoardsV1Schema.parse({ v: 1, boards: [...base.boards, createWorkBoardV1({ id: 'b2', name: 'Other' })] }));
        let resolveBody!: (value: WorkBoardArtifactV1) => void;
        let markReading!: () => void;
        const reading = new Promise<void>(resolve => { markReading = resolve; });
        const store = createWorkBoardAccountStore({ ...persistence.transport, read: async (id, options) => {
            if (id === 'b2') { markReading(); return await new Promise(resolve => { resolveBody = resolve; }); }
            return persistence.transport.read(id, options);
        } }, () => true);
        const release = store.retainView(() => () => {}, 'all');
        try {
            const refresh = store.refresh();
            await reading;
            await store.queue.dispatch({ kind: 'update', boardId: 'b1', patch: { name: 'Newer' } });
            resolveBody(persistence.rows.get('b2')!);
            await refresh;
            expect(store.getBoards().boards.map(board => [board.id, board.name])).toEqual([['b1', 'Newer'], ['b2', 'Other']]);
        } finally { release(); }
    });

    it('consumes a new exact invalidation received while that Board body is already loading', async () => {
        const persistence = createWorkBoardArtifactBoundary(base);
        let resolveBody!: (value: WorkBoardArtifactV1) => void;
        let markReading!: () => void;
        const reading = new Promise<void>(resolve => { markReading = resolve; });
        const old = persistence.rows.get('b1')!;
        let reads = 0;
        const store = createWorkBoardAccountStore({ ...persistence.transport, read: async (id, options) => {
            if (reads++ === 0) { markReading(); return await new Promise(resolve => { resolveBody = resolve; }); }
            return persistence.transport.read(id, options);
        } }, () => true);
        const release = store.retainView(() => () => {}, 'board:b1');
        try {
            const first = store.refresh();
            await reading;
            persistence.rows.set('b1', { ...old, body: JSON.stringify({ ...base.boards[0], name: 'Fresh' }), revision: { headerVersion: 2, bodyVersion: 2 } });
            store.invalidateBodies(['b1']);
            const second = store.refresh();
            resolveBody(old);
            await Promise.all([first, second]);
            expect(store.getBoard('b1')?.name).toBe('Fresh');
            expect(reads).toBe(2);
        } finally { release(); }
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
        const refresh = readBoards(store);
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
        const refresh = readBoards(store); await reading;
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

    it('settles the index as soon as headers arrive while demanded bodies remain pending', async () => {
        const persistence = createWorkBoardArtifactBoundary(base);
        let finish!: (value: WorkBoardArtifactV1 | null) => void;
        let started!: () => void;
        const reading = new Promise<void>(resolve => { started = resolve; });
        const store = createWorkBoardAccountStore({ ...persistence.transport, read: async () => {
            started(); return new Promise(resolve => { finish = resolve; });
        } }, () => true);
        const release = store.retainView(() => () => {}, 'all');
        const refreshing = store.refresh();
        try {
            await reading;
            expect(store.getSummaries().map(board => board.id)).toEqual(['b1']);
            expect(store.getReadState()).toMatchObject({ status: 'ready', hasSnapshot: true });
            expect(store.getBoardReadState('b1')).toMatchObject({ status: 'loading', hasSnapshot: false });
        } finally {
            finish(persistence.rows.get('b1')!);
            await refreshing;
            release();
        }
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
        const refresh = readBoards(store); await firstRequest;
        // Flush the other independent response; the first remains held at the persistence boundary.
        await new Promise<void>(resolve => { setTimeout(resolve, 0); });
        try {
            expect(peak).toBe(2);
            expect(store.getBoards().boards.map(board => board.id)).toEqual(['b2']);
        }
        finally { releaseFirst(); await refresh; }
        expect(store.getBoards().boards.map(board => board.id)).toEqual(['b1', 'b2']);
    });

    it('joins demanded reads and refetches only the invalidated Board', async () => {
        const persistence = createWorkBoardArtifactBoundary({ v: 1, boards: [...base.boards, createWorkBoardV1({ id: 'b2', name: 'Other' })] });
        const store = createWorkBoardAccountStore(persistence.transport, () => true);
        const release = store.retainView(() => () => {}, 'all');
        await Promise.all([store.refresh(), store.refresh()]);
        expect(persistence.reads).toEqual(['b1', 'b2']);
        await store.refresh();
        expect(persistence.reads).toEqual(['b1', 'b2']);
        const row = persistence.rows.get('b1')!;
        persistence.rows.set('b1', { ...row, body: JSON.stringify({ ...base.boards[0], name: 'Remote edit' }), revision: { ...row.revision, bodyVersion: 2 } });
        store.invalidateBodies(['b1']);
        await store.refresh();
        expect(persistence.reads).toEqual(['b1', 'b2', 'b1']);
        expect(store.getBoards().boards[0]?.name).toBe('Remote edit');
        release();
    });

    it('refreshes a recreated id and explicitly retries unreadable demanded content', async () => {
        const persistence = createWorkBoardArtifactBoundary(base);
        const store = createWorkBoardAccountStore(persistence.transport, () => true);
        const release = store.retainView(() => () => {}, 'all');
        await store.refresh();
        const original = persistence.rows.get('b1')!;
        persistence.rows.delete('b1');
        await store.refresh();
        expect(store.getBoards().boards).toEqual([]);
        persistence.rows.set('b1', { ...original, body: '{ bad' });
        await store.refresh();
        expect(store.getBoards().boards).toEqual([]);
        persistence.rows.set('b1', original);
        store.invalidateBodies();
        await store.refresh();
        expect(store.getBoards().boards).toEqual(base.boards);
        release();
    });

    it('projects an edit immediately and keeps it once the dedicated record acknowledges it', async () => {
        const b = boundary();
        await readBoards(b.store);
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
        await readBoards(b.store); b.offline(true);
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
