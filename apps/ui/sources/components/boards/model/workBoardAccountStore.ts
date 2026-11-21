import { createWorkBoardArtifactPortV1, buildWorkBoardArtifactHeaderV1, readWorkBoardArtifactSummaryV1, type WorkBoardArtifactTransportV1, type WorkBoardArtifactSummaryV1, type WorkBoardArtifactRevisionV1 } from '@happier-dev/protocol/boards/workBoardArtifactV1';
import { DEFAULT_WORK_BOARDS_V1, type WorkBoardIntentV1, type WorkBoardV1 } from '@happier-dev/protocol/boards/workBoardV1';
import { createWorkBoardSaveQueue, projectDisplayedWorkBoards } from './workBoardSaveQueue';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

export type WorkBoardReadState = Readonly<{ status: 'loading' | 'ready' | 'error'; hasSnapshot: boolean; errorCode?: string }>;
const UNREAD_BOARD: WorkBoardReadState = Object.freeze({ status: 'loading', hasSnapshot: false });
type BoardArtifactHeader = Readonly<{ artifactId: string; header: Readonly<Record<string, unknown>>; headerVersion: number }>;

/** Scoped Artifact projection. Headers serve chrome; bodies load only for mounted Board consumers. */
/**
 * The headers this device last read for the Account: served until the inventory read settles (chrome such as
 * boards pinned in the Sessions column paints with the first frame), and told each settled change.
 */
export type WorkBoardRetainedSummaries = Readonly<{
    summaries: readonly WorkBoardArtifactSummaryV1[];
    remember(summaries: readonly WorkBoardArtifactSummaryV1[]): void;
}>;

export function createWorkBoardAccountStore(transport: WorkBoardArtifactTransportV1, shouldContinue: () => boolean,
    retained?: WorkBoardRetainedSummaries) {
    let boards = DEFAULT_WORK_BOARDS_V1;
    let summaries: readonly WorkBoardArtifactSummaryV1[] = retained?.summaries ?? [];
    const revisions = new Map<string, WorkBoardArtifactRevisionV1>();
    /** Whether someone besides the owner can see or write each Board, from the read that delivered its body. */
    const sharedBoards = new Map<string, boolean>();
    const demand = new Map<string, number>();
    let writes = 0;
    let readState: WorkBoardReadState = shouldContinue() ? { status: 'loading', hasSnapshot: false }
        : { status: 'error', hasSnapshot: false, errorCode: 'board_scope_retired' };
    let references = 0;
    // A dirty body names the revision that made it dirty when one is known (null: unknown, always re-read).
    // A body this domain already holds at or past that revision is current, e.g. its own acknowledged write.
    const dirtyBodies = new Map<string, WorkBoardArtifactRevisionV1 | null>();
    const holdsRevision = (id: string) => {
        const observed = dirtyBodies.get(id);
        const held = revisions.get(id);
        return Boolean(observed && held && held.headerVersion >= observed.headerVersion && held.bodyVersion >= observed.bodyVersion);
    };
    /** Own writes in flight: their Artifact publication precedes their acknowledgement. */
    const ownWrites = new Map<string, Promise<unknown>>();
    const readBodies = new Set<string>();
    const headers = new Map<string, BoardArtifactHeader>();
    const inFlightBodies = new Map<string, Promise<void>>();
    const bodyReadStates = new Map<string, WorkBoardReadState>();
    let detach: (() => void) | null = null;
    const listeners = new Set<() => void>();
    const notify = () => { for (const listener of listeners) listener(); };
    const setBodyReadState = (id: string, next: WorkBoardReadState) => {
        const old = bodyReadStates.get(id);
        if (old?.status === next.status && old.hasSnapshot === next.hasSnapshot && old.errorCode === next.errorCode) return;
        bodyReadStates.set(id, next);
        notify();
    };
    const acceptBoard = (id: string, board: WorkBoardV1 | null, revision?: WorkBoardArtifactRevisionV1,
        access?: Readonly<{ isShared: boolean }>) => {
        const current = revisions.get(id);
        if (revision && current && (revision.bodyVersion < current.bodyVersion || revision.headerVersion < current.headerVersion)) return;
        const sharedChanged = access !== undefined ? sharedBoards.get(id) !== access.isShared : !board && sharedBoards.has(id);
        if (access) sharedBoards.set(id, access.isShared);
        else if (!board) sharedBoards.delete(id);
        if (board && revision && current && revision.bodyVersion === current.bodyVersion && revision.headerVersion === current.headerVersion
            && boards.boards.some(item => item.id === id)) { if (sharedChanged) notify(); return; }
        if (revision) revisions.set(id, revision);
        else if (!board) revisions.delete(id);
        const old = boards.boards.find(item => item.id === id);
        if (sameStrictJsonValue(board, old ?? null)) { if (sharedChanged) notify(); return; }
        const nextBoards = board
            ? old ? boards.boards.map(item => item.id === id ? board : item) : [...boards.boards, board]
            : boards.boards.filter(item => item.id !== id);
        const order = new Map(summaries.map((item, index) => [item.id, index]));
        boards = { ...boards, boards: nextBoards.sort((a, b) => (order.get(a.id) ?? order.size) - (order.get(b.id) ?? order.size)) };
        notify();
    };
    const reconcileSummaries = (next: readonly WorkBoardArtifactSummaryV1[]) => {
        const previous = new Map(summaries.map(item => [item.id, item]));
        const reconciled = next.map(item => {
            const old = previous.get(item.id);
            return old && sameStrictJsonValue(old, item) ? old : item;
        });
        if (reconciled.length === summaries.length && reconciled.every((item, index) => item === summaries[index])) return;
        summaries = reconciled;
        retained?.remember(summaries);
        notify();
    };
    const inventoryTransport: WorkBoardArtifactTransportV1 = { ...transport, list: async options => {
        const page = await transport.list(options);
        if (!shouldContinue()) return page;
        return { ...page, items: page.items.map(item => {
            if (!readWorkBoardArtifactSummaryV1(item.artifactId, item.header)) return item;
            const current = headers.get(item.artifactId);
            // An inventory admitted before an exact push cannot replace its newer header.
            if (current && current.headerVersion > item.headerVersion) return { ...item, ...current };
            if (current && current.headerVersion !== item.headerVersion) dirtyBodies.set(item.artifactId, null);
            headers.set(item.artifactId, item);
            return item;
        }) };
    } };
    const port = createWorkBoardArtifactPortV1(inventoryTransport, { shouldContinue, onBoard: acceptBoard });
    const queue = createWorkBoardSaveQueue({ port: { readBoard: port.readBoard, apply: async (intent, signal) => {
        const id = intent.kind === 'create' ? intent.board.id : intent.boardId;
        const write = port.apply(intent, signal);
        ownWrites.set(id, write);
        let result: Awaited<typeof write>;
        try { result = await write; } finally { if (ownWrites.get(id) === write) ownWrites.delete(id); }
        writes++;
        const board = result.boards[0];
        // The write is the newest read of this body; only a strictly newer pushed revision stays dirty.
        if (dirtyBodies.get(id) === null || holdsRevision(id)) dirtyBodies.delete(id);
        setBodyReadState(id, { status: 'ready', hasSnapshot: true });
        if (board) {
            readBodies.add(id);
            const revision = revisions.get(id);
            if (revision) headers.set(id, { artifactId: id, header: buildWorkBoardArtifactHeaderV1(board), headerVersion: revision.headerVersion });
        } else { readBodies.delete(id); headers.delete(id); }
        const summary = board ? readWorkBoardArtifactSummaryV1(id, buildWorkBoardArtifactHeaderV1(board)) : null;
        const previous = summaries.find(item => item.id === id);
        reconcileSummaries(summary ? previous ? summaries.map(item => item.id === id ? summary : item) : [...summaries, summary]
            : summaries.filter(item => item.id !== id));
        return result;
    } } });
    const displayedBoards = new Map<string, Readonly<{
        acknowledged: WorkBoardV1 | null; pending: readonly WorkBoardIntentV1[]; board: WorkBoardV1 | null;
    }>>();
    const getBoard = (id: string) => boards.boards.find(board => board.id === id) ?? null;
    const getDisplayedBoard = (id: string) => {
        const acknowledged = getBoard(id);
        const pending = queue.getState().pending.filter(intent => (intent.kind === 'create' ? intent.board.id : intent.boardId) === id);
        const old = displayedBoards.get(id);
        if (old && old.acknowledged === acknowledged && old.pending.length === pending.length
            && old.pending.every((intent, index) => intent === pending[index])) return old.board;
        const board = pending.length === 0 ? acknowledged : projectDisplayedWorkBoards({ v: 1, boards: acknowledged ? [acknowledged] : [] }, pending).boards[0] ?? null;
        displayedBoards.set(id, { acknowledged, pending, board });
        return board;
    };
    return {
        queue,
        readBoardAccess: port.readBoardAccess,
        getBoard,
        getDisplayedBoard,
        /** Unknown until a read of this Board settles; the HTML host treats unknown as shared. */
        isBoardShared: (id: string): boolean | undefined => sharedBoards.get(id),
        getBoards: () => boards,
        getSummaries: () => summaries,
        getReadState: () => readState,
        getBoardReadState: (id: string): WorkBoardReadState => readState.status !== 'ready' ? readState
            : bodyReadStates.get(id) ?? (!summaries.some(board => board.id === id) ? readState : UNREAD_BOARD),
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        /** Artifact body-only changes also arrive through the canonical head invalidation. */
        invalidateBodies(ids: readonly string[] = summaries.map(item => item.id),
            observed?: ReadonlyMap<string, WorkBoardArtifactRevisionV1>) {
            for (const id of ids) {
                const revision = observed?.get(id) ?? null;
                const previous = dirtyBodies.get(id);
                // An unknown cause keeps the unconditional re-read it already requested.
                dirtyBodies.set(id, previous === null || revision === null ? null
                    : previous && (previous.headerVersion > revision.headerVersion || previous.bodyVersion > revision.bodyVersion) ? previous : revision);
            }
        },
        applyArtifactHeaders(items: readonly BoardArtifactHeader[]) {
            let next = summaries;
            for (const item of items) {
                const current = headers.get(item.artifactId);
                if (current && current.headerVersion >= item.headerVersion) continue;
                const summary = readWorkBoardArtifactSummaryV1(item.artifactId, item.header);
                if (!summary) continue;
                headers.set(item.artifactId, item);
                next = next.some(board => board.id === item.artifactId)
                    ? next.map(board => board.id === item.artifactId ? summary : board) : [...next, summary];
            }
            reconcileSummaries(next);
        },
        async refresh(options: Readonly<{ inventory?: boolean }> = {}) {
            if (!shouldContinue()) return;
            if (readState.status === 'error') { readState = { status: 'loading', hasSnapshot: readState.hasSnapshot }; notify(); }
            try {
                if (options.inventory !== false || readState.status !== 'ready') {
                    const before = writes;
                    const next = await port.list();
                    if (!shouldContinue()) return;
                    // A delayed inventory cannot erase a newer local create/delete acknowledgement.
                    if (before === writes) {
                        reconcileSummaries(next);
                        const ids = new Set(next.map(item => item.id));
                        for (const id of headers.keys()) if (!ids.has(id)) headers.delete(id);
                        for (const id of [...readBodies]) if (!ids.has(id)) {
                            readBodies.delete(id); headers.delete(id); dirtyBodies.delete(id);
                            bodyReadStates.delete(id);
                            acceptBoard(id, null);
                        }
                        for (const old of boards.boards) if (!ids.has(old.id)) acceptBoard(old.id, null);
                    }
                }
                // The index is readable once its headers settle. Each demanded body's own
                // lifecycle below governs its page; it cannot delay or fail the collection.
                if (readState.status !== 'ready') {
                    readState = { status: 'ready', hasSnapshot: true };
                    notify();
                }
                const wanted = demand.has('all')
                    ? summaries.map(item => item.id) : [...demand.keys()].filter(id => id.startsWith('board:')).map(id => id.slice(6));
                // Join exact reads here; a slow body cannot hold its readable neighbours hostage.
                const readBody = async (id: string): Promise<void> => {
                    // Views can close while the inventory or an earlier body is pending.
                    // Keep admitted content, but do not start another read without a reader.
                    if (!shouldContinue() || !(demand.has('all') || demand.has(`board:${id}`))) return;
                    // An own write publishes its Artifact before it acknowledges; decide after it settles.
                    const writing = ownWrites.get(id);
                    if (writing) { await writing.catch(() => {}); return await readBody(id); }
                    const running = inFlightBodies.get(id);
                    if (running) {
                        await running;
                        if (dirtyBodies.has(id)) await readBody(id);
                        return;
                    }
                    if (readBodies.has(id) && (!dirtyBodies.has(id) || holdsRevision(id))) { dirtyBodies.delete(id); return; }
                    dirtyBodies.delete(id);
                    setBodyReadState(id, { status: 'loading', hasSnapshot: readBodies.has(id) });
                    const beforeRevision = revisions.get(id);
                    const beforeSummary = summaries.find(item => item.id === id);
                    const reader = createWorkBoardArtifactPortV1(transport, { shouldContinue, onBoard: (boardId, board, revision, access) => {
                        // A write to another Board does not retire this exact read. The revision
                        // owner still prevents a delayed body from replacing its own newer write.
                        if (beforeRevision === revisions.get(boardId)
                            && beforeSummary === summaries.find(item => item.id === boardId) && shouldContinue()) {
                            acceptBoard(boardId, board, revision, access);
                            readBodies.add(boardId);
                        }
                    } });
                    const pending = reader.readBoard(id).then(() => {
                        if (shouldContinue()) setBodyReadState(id, { status: 'ready', hasSnapshot: true });
                    }, error => {
                        dirtyBodies.set(id, null);
                        if (shouldContinue()) setBodyReadState(id, { status: 'error', hasSnapshot: readBodies.has(id),
                            errorCode: typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
                                ? error.code : 'board_record_unavailable' });
                        throw error;
                    }).finally(() => { inFlightBodies.delete(id); });
                    inFlightBodies.set(id, pending);
                    await pending;
                    // A second Artifact invalidation during this read remains demand, not a
                    // duplicate concurrent request or a wake silently consumed by the old body.
                    if (dirtyBodies.has(id) && shouldContinue()) await readBody(id);
                };
                await Promise.all(wanted.map(id => readBody(id).catch(() => {})));
            } catch (error) {
                if (!shouldContinue()) return;
                const errorCode = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
                    ? error.code : 'board_record_unavailable';
                readState = { status: 'error', hasSnapshot: readState.hasSnapshot, errorCode };
                notify();
            }
        },
        /** View subscriptions stop on navigation; already-admitted writes remain owned by the Account lifetime. */
        retainView(start: () => () => void, bodyDemand = 'all') {
            if (!shouldContinue()) return () => {};
            demand.set(bodyDemand, (demand.get(bodyDemand) ?? 0) + 1);
            references++;
            if (references === 1) detach = start();
            return () => {
                const count = demand.get(bodyDemand) ?? 0;
                if (count <= 1) demand.delete(bodyDemand); else demand.set(bodyDemand, count - 1);
                if (references > 0) references--;
                if (references === 0) { detach?.(); detach = null; }
            };
        },
        retire() { detach?.(); detach = null; references = 0; demand.clear(); displayedBoards.clear(); bodyReadStates.clear(); queue.reset(); },
    };
}
