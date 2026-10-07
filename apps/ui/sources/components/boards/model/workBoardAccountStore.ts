import { createWorkBoardArtifactPortV1, buildWorkBoardArtifactHeaderV1, readWorkBoardArtifactSummaryV1,
    DEFAULT_WORK_BOARDS_V1, type WorkBoardArtifactTransportV1, type WorkBoardArtifactSummaryV1,
    type WorkBoardArtifactRevisionV1, type WorkBoardIntentV1, type WorkBoardV1 } from '@happier-dev/protocol';
import { createWorkBoardSaveQueue, projectDisplayedWorkBoards } from './workBoardSaveQueue';

export type WorkBoardReadState = Readonly<{ status: 'loading' | 'ready' | 'error'; hasSnapshot: boolean; errorCode?: string }>;

/** Scoped Artifact projection. Headers serve chrome; bodies load only for mounted Board consumers. */
export function createWorkBoardAccountStore(transport: WorkBoardArtifactTransportV1, shouldContinue: () => boolean) {
    let boards = DEFAULT_WORK_BOARDS_V1;
    let summaries: readonly WorkBoardArtifactSummaryV1[] = [];
    const revisions = new Map<string, WorkBoardArtifactRevisionV1>();
    const demand = new Map<string, number>();
    let writes = 0;
    let readState: WorkBoardReadState = shouldContinue() ? { status: 'loading', hasSnapshot: false }
        : { status: 'error', hasSnapshot: false, errorCode: 'board_scope_retired' };
    let references = 0;
    const dirtyBodies = new Set<string>();
    const readBodies = new Set<string>();
    const headerVersions = new Map<string, number>();
    const inFlightBodies = new Map<string, Promise<void>>();
    let detach: (() => void) | null = null;
    const listeners = new Set<() => void>();
    const notify = () => { for (const listener of listeners) listener(); };
    const acceptBoard = (id: string, board: WorkBoardV1 | null, revision?: WorkBoardArtifactRevisionV1) => {
        const current = revisions.get(id);
        if (revision && current && (revision.bodyVersion < current.bodyVersion || revision.headerVersion < current.headerVersion)) return;
        if (revision) revisions.set(id, revision);
        else if (!board) revisions.delete(id);
        const old = boards.boards.find(item => item.id === id);
        if (JSON.stringify(board) === JSON.stringify(old ?? null)) return;
        const nextBoards = board
            ? old ? boards.boards.map(item => item.id === id ? board : item) : [...boards.boards, board]
            : boards.boards.filter(item => item.id !== id);
        const order = new Map(summaries.map((item, index) => [item.id, index]));
        boards = { ...boards, boards: nextBoards.sort((a, b) => (order.get(a.id) ?? order.size) - (order.get(b.id) ?? order.size)) };
        notify();
    };
    const reconcileSummaries = (next: readonly WorkBoardArtifactSummaryV1[]) => {
        if (JSON.stringify(next) === JSON.stringify(summaries)) return;
        const previous = new Map(summaries.map(item => [item.id, item]));
        summaries = next.map(item => {
            const old = previous.get(item.id);
            return old && JSON.stringify(old) === JSON.stringify(item) ? old : item;
        });
        notify();
    };
    const inventoryTransport: WorkBoardArtifactTransportV1 = { ...transport, list: async options => {
        const page = await transport.list(options);
        if (shouldContinue()) for (const item of page.items) {
            if (!readWorkBoardArtifactSummaryV1(item.artifactId, item.header)) continue;
            if (headerVersions.has(item.artifactId) && headerVersions.get(item.artifactId) !== item.headerVersion) dirtyBodies.add(item.artifactId);
            headerVersions.set(item.artifactId, item.headerVersion);
        }
        return page;
    } };
    const port = createWorkBoardArtifactPortV1(inventoryTransport, { shouldContinue, onBoard: acceptBoard });
    const queue = createWorkBoardSaveQueue({ port: { read: port.read, apply: async (intent, signal) => {
        const result = await port.apply(intent, signal);
        writes++;
        const id = intent.kind === 'create' ? intent.board.id : intent.boardId;
        const board = result.boards[0];
        dirtyBodies.delete(id);
        if (board) {
            readBodies.add(id);
            const revision = revisions.get(id);
            if (revision) headerVersions.set(id, revision.headerVersion);
        } else { readBodies.delete(id); headerVersions.delete(id); }
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
        getBoard,
        getDisplayedBoard,
        getBoards: () => boards,
        getSummaries: () => summaries,
        getReadState: () => readState,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        /** Artifact body-only changes also arrive through the canonical head invalidation. */
        invalidateBodies(ids: readonly string[] = summaries.map(item => item.id)) {
            for (const id of ids) dirtyBodies.add(id);
        },
        async refresh() {
            if (!shouldContinue()) return;
            if (readState.status === 'error') { readState = { status: 'loading', hasSnapshot: readState.hasSnapshot }; notify(); }
            try {
                const before = writes;
                const next = await port.list();
                if (!shouldContinue()) return;
                // A delayed inventory cannot erase a newer local create/delete acknowledgement.
                if (before === writes) {
                    reconcileSummaries(next);
                    const ids = new Set(next.map(item => item.id));
                    for (const id of [...readBodies]) if (!ids.has(id)) {
                        readBodies.delete(id); headerVersions.delete(id); dirtyBodies.delete(id);
                        acceptBoard(id, null);
                    }
                    for (const old of boards.boards) if (!ids.has(old.id)) acceptBoard(old.id, null);
                }
                const wanted = demand.has('all') || demand.size === 0
                    ? summaries.map(item => item.id) : [...demand.keys()].filter(id => id.startsWith('board:')).map(id => id.slice(6));
                // Join exact reads here; a slow body cannot hold its readable neighbours hostage.
                const readBody = async (id: string): Promise<void> => {
                    const running = inFlightBodies.get(id);
                    if (running) {
                        await running;
                        if (dirtyBodies.has(id)) await readBody(id);
                        return;
                    }
                    if (demand.size > 0 && readBodies.has(id) && !dirtyBodies.has(id)) return;
                    dirtyBodies.delete(id);
                    const beforeRevision = revisions.get(id);
                    const beforeSummary = summaries.find(item => item.id === id);
                    const reader = createWorkBoardArtifactPortV1(transport, { shouldContinue, onBoard: (boardId, board, revision) => {
                        // A write to another Board does not retire this exact read. The revision
                        // owner still prevents a delayed body from replacing its own newer write.
                        if (beforeRevision === revisions.get(boardId)
                            && beforeSummary === summaries.find(item => item.id === boardId) && shouldContinue()) {
                            acceptBoard(boardId, board, revision);
                            readBodies.add(boardId);
                        }
                    } });
                    const pending = reader.readBoard(id).then(() => {}, error => {
                        dirtyBodies.add(id);
                        throw error;
                    }).finally(() => { inFlightBodies.delete(id); });
                    inFlightBodies.set(id, pending);
                    await pending;
                    // A second Artifact invalidation during this read remains demand, not a
                    // duplicate concurrent request or a wake silently consumed by the old body.
                    if (dirtyBodies.has(id) && shouldContinue()) await readBody(id);
                };
                await Promise.all(wanted.map(readBody));
                if (!shouldContinue()) return;
                const wasReady = readState.status === 'ready';
                readState = { status: 'ready', hasSnapshot: true };
                if (!wasReady) notify();
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
        retire() { detach?.(); detach = null; references = 0; demand.clear(); displayedBoards.clear(); queue.reset(); },
    };
}
