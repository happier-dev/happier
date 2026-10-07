import { describe, expect, it, vi } from 'vitest';
import { applyWorkBoardIntentV1, createWorkBoardV1, buildWorkBoardItemKeyV1, type BoardItemRefV1, type WorkBoardV1 } from '@happier-dev/protocol';
import { createEntityDragDropRuntime, createEntityDragGestureAdapter } from '@/components/ui/treeDragDrop';
import { createWorkBoardArtifactBoundary } from '@/dev/testkit/harness/workBoardArtifactBoundary';
import { createWorkBoardAccountStore } from './workBoardAccountStore';
import { createWorkBoardUiActionPort, resolveWorkBoardAdd, resolveWorkBoardEntityDrop, workBoardDragItem, type WorkBoardEntityContext } from './workBoardEntityDrop';
import { projectBoardMembership } from './boardMembership';
import { resolveBoardCardDrop } from './boardCanvasGeometry';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
const scope = { serverId: 'home-a', accountId: 'account-a' };
const ref: BoardItemRefV1 = { kind: 'session', qualifiedId: { serverId: 'home-a', id: 's1' } };
const key = buildWorkBoardItemKeyV1(ref);
function context(board: WorkBoardV1): WorkBoardEntityContext {
    return { scope, board, membership: projectBoardMembership(board, { isHomeMounted: () => true, sections: {}, filtered: null }), isHomeMounted: () => true };
}

describe('WorkBoard shared entity owner', () => {
    it('refuses a Canvas edit when the mounted membership context is no longer available', async () => {
        const board = { ...createWorkBoardV1({ id: 'b1', name: 'Board' }), source: { picked: [ref] } };
        const persistence = createWorkBoardArtifactBoundary({ v: 1, boards: [board] });
        const store = createWorkBoardAccountStore(persistence.transport, () => true);
        await store.refresh();
        const port = createWorkBoardUiActionPort(() => null, store.queue, store.getBoards);
        await expect(port.apply({ kind: 'set_positions', boardId: board.id, positionsByItemRef: { [key]: { x: 24, y: 48 } } }))
            .rejects.toMatchObject({ code: 'board_context_unavailable' });
        expect(persistence.acknowledged().boards[0]!.positionsByItemRef).toEqual({});
    });
    it('admits external configured copies through the widget destination DTO, without turning same-Board XY into a transfer', () => {
        const board = { ...createWorkBoardV1({ id: 'b1', name: 'Launch' }), source: { picked: [ref] } };
        for (const item of [
            { kind: 'home-section' as const, scope, sectionId: 'configured' },
            { kind: 'work-board-widget' as const, scope, boardId: 'other', instanceId: 'configured' },
            { kind: 'companion-item' as const, scope, address: { serverId: scope.serverId, sessionId: 's1' }, item: {
                kind: 'instance' as const, instance: { v: 1 as const, id: 'configured', definition: { kind: 'builtin' as const, id: 'changes' }, bindings: {} },
            } },
        ]) {
            expect(resolveWorkBoardEntityDrop({ item, context: context(board), destination: null, canvasAvailable: false })).toMatchObject({
                status: 'allowed', effect: { actionId: 'widgets.instance.move', input: {
                    to: { surface: { ...scope, owner: { kind: 'workBoard', boardId: board.id } }, index: 1 },
                }, preview: { target: 'Launch' } },
            });
        }
        expect(resolveWorkBoardEntityDrop({ item: { kind: 'work-board-widget', scope, boardId: board.id, instanceId: 'gone' },
            context: context(board), destination: null, canvasAvailable: false }).status).toBe('refused');
    });
    it('adds a Session once through add_items and refuses unsupported references and duplicate releases', async () => {
        const board = createWorkBoardV1({ id: 'b1', name: 'Board' });
        const persistence = createWorkBoardArtifactBoundary({ v: 1, boards: [board] });
        const store = createWorkBoardAccountStore(persistence.transport, () => true);
        await store.refresh();
        const runtime = createEntityDragDropRuntime();
        const item = { kind: 'session' as const, scope, address: { serverId: scope.serverId, sessionId: ref.qualifiedId.id } };
        runtime.registerSource({ id: 'session', scope, getItem: () => item, isCurrent: () => true });
        runtime.registerTarget({ id: 'board', scope, acceptedKinds: ['session'], getBounds: () => ({ x: 0, y: 0, width: 200, height: 200 }),
            resolve: ({ item, destination }) => resolveWorkBoardEntityDrop({ item, destination, canvasAvailable: true, context: context(store.getBoards().boards[0]!) }),
            execute: async effect => {
                const input = effect.input;
                if (!input || typeof input !== 'object' || Array.isArray(input) || !('intent' in input)) throw new Error('invalid effect');
                const { WorkBoardIntentV1Schema } = await import('@happier-dev/protocol');
                const outcome = await store.queue.dispatch(WorkBoardIntentV1Schema.parse(input.intent));
                return outcome.status === 'applied' ? { status: 'applied' } : { status: outcome.status, reason: { code: outcome.code, message: outcome.code } };
            } });
        const carry = runtime.begin('session')!;
        carry.move({ x: 50, y: 50 });
        expect(runtime.getSnapshot().admission).toMatchObject({ status: 'allowed', effect: { actionId: 'boards.apply', input: { intent: { kind: 'add_items' } } } });
        expect(await carry.release()).toEqual({ status: 'applied' });
        await carry.release();
        expect(persistence.acknowledged().boards[0]!.source.picked).toEqual([ref]);
        expect(await runtime.perform('session', 'board')).toMatchObject({ status: 'refused', reason: { code: 'board-already-here' } });
        expect(resolveWorkBoardAdd({ kind: 'widget', qualifiedId: ref.qualifiedId }, context(board))).toMatchObject({ status: 'refused', reason: { code: 'board-kind-unsupported' } });
        expect(resolveWorkBoardEntityDrop({ item: { ...item, scope: { ...scope, accountId: 'other' } }, context: context(board), destination: null, canvasAvailable: true }))
            .toMatchObject({ status: 'refused', reason: { code: 'board-scope-mismatch' } });
    });

    it.each(['session', 'workflow_run', 'workflow', 'machine'] as const)('admits the actual %s BoardItemRef without an invented widget arm', kind => {
        const board = createWorkBoardV1({ id: 'b1', name: 'Board' });
        const item = { kind, qualifiedId: { serverId: 'home-b', id: 'item' } };
        expect(resolveWorkBoardEntityDrop({ item: workBoardDragItem(scope, 'another-board', item), context: context(board), destination: null, canvasAvailable: false }))
            .toMatchObject({ status: 'allowed', effect: { input: { intent: { kind: 'add_items', refs: [item] } } } });
    });

    it('rebases XY/Shift against current membership, freezes flow, and preserves the agent no-pruning distinction', async () => {
        const other: BoardItemRefV1 = { kind: 'machine', qualifiedId: { serverId: 'home-b', id: 'm1' } };
        const otherKey = buildWorkBoardItemKeyV1(other);
        const staleKey = buildWorkBoardItemKeyV1({ ...ref, qualifiedId: { ...ref.qualifiedId, id: 'stale' } });
        let board = { ...createWorkBoardV1({ id: 'b1', name: 'Board' }), source: { picked: [ref, other] }, positionsByItemRef: { [staleKey]: { x: 3, y: 4 } } };
        const persistence = createWorkBoardArtifactBoundary({ v: 1, boards: [board] });
        const store = createWorkBoardAccountStore(persistence.transport, () => true);
        const current = { ...context(board), measuredPositions: new Map([[key, { x: 10, y: 20 }], [otherKey, { x: 200, y: 20 }]]) };
        const position = resolveBoardCardDrop({ origin: { x: 10, y: 20 }, translation: { x: 31, y: 7 }, snap: false, snapOnce: true });
        const admission = resolveWorkBoardEntityDrop({ item: workBoardDragItem(scope, board.id, ref), context: current, destination: position, canvasAvailable: true });
        expect(admission.status).toBe('allowed');
        if (admission.status !== 'allowed') throw new Error('expected move');
        const { WorkBoardActionInputSchemasV1 } = await import('@happier-dev/protocol');
        const intent = WorkBoardActionInputSchemasV1['boards.apply'].parse(admission.effect.input).intent;
        const port = createWorkBoardUiActionPort(() => current, store.queue);
        await port.apply(intent);
        const saved = persistence.acknowledged().boards[0]!;
        expect(saved.positionsByItemRef).toEqual({ [key]: position, [otherKey]: { x: 200, y: 20 } });
        const agent = applyWorkBoardIntentV1({ v: 1, boards: [board] }, intent);
        expect(agent.status === 'applied' && agent.boards.boards[0]!.positionsByItemRef[staleKey]).toEqual({ x: 3, y: 4 });
        const mode = applyWorkBoardIntentV1({ v: 1, boards: [saved] }, { kind: 'update', boardId: board.id, patch: { mode: 'by_status' } });
        expect(mode.status === 'applied' && mode.boards.boards[0]!.positionsByItemRef).toEqual(saved.positionsByItemRef);
        expect(resolveWorkBoardEntityDrop({ item: workBoardDragItem(scope, board.id, ref), context: context(saved), destination: position, canvasAvailable: true }))
            .toMatchObject({ status: 'refused', reason: { code: 'board-no-change' } });
        board = { ...board, source: { picked: [other] } };
        expect(resolveWorkBoardEntityDrop({ item: workBoardDragItem(scope, board.id, ref), context: context(board), destination: position, canvasAvailable: true }))
            .toMatchObject({ status: 'refused', reason: { code: 'board-item-gone' } });
    });

    it('failed native end and finalize never write a canvas position', async () => {
        const board = { ...createWorkBoardV1({ id: 'b1', name: 'Board' }), source: { picked: [ref] } };
        const persistence = createWorkBoardArtifactBoundary({ v: 1, boards: [board] });
        const store = createWorkBoardAccountStore(persistence.transport, () => true);
        const runtime = createEntityDragDropRuntime();
        runtime.registerSource({ id: 'card', scope, getItem: () => workBoardDragItem(scope, board.id, ref), isCurrent: () => true });
        runtime.registerTarget({ id: 'canvas', scope, acceptedKinds: ['work-board-item'], getBounds: () => ({ x: 0, y: 0, width: 200, height: 200 }),
            resolve: ({ item }) => resolveWorkBoardEntityDrop({ item, context: context(board), destination: { x: 24, y: 48 }, canvasAvailable: true }),
            execute: async () => { await store.queue.dispatch({ kind: 'set_positions', boardId: board.id, positionsByItemRef: { [key]: { x: 24, y: 48 } } }); return { status: 'applied' }; } });
        const adapter = createEntityDragGestureAdapter(runtime.begin('card')!);
        adapter.update({ x: 50, y: 50 });
        await adapter.end(false); adapter.finalize();
        expect(persistence.acknowledged().boards[0]!.positionsByItemRef).toEqual({});
    });

    it('refuses an admitted move when membership disappears before the UI Action port executes', async () => {
        const board = { ...createWorkBoardV1({ id: 'b1', name: 'Board' }), source: { picked: [ref] } };
        const admission = resolveWorkBoardEntityDrop({ item: workBoardDragItem(scope, board.id, ref), context: context(board),
            destination: { x: 24, y: 48 }, canvasAvailable: true });
        if (admission.status !== 'allowed') throw new Error('expected admitted move');
        const current = { ...board, source: { picked: [] } };
        const persistence = createWorkBoardArtifactBoundary({ v: 1, boards: [current] });
        const store = createWorkBoardAccountStore(persistence.transport, () => true);
        const port = createWorkBoardUiActionPort(() => context(current), store.queue);
        const { WorkBoardActionInputSchemasV1 } = await import('@happier-dev/protocol');
        await expect(port.apply(WorkBoardActionInputSchemasV1['boards.apply'].parse(admission.effect.input).intent))
            .rejects.toMatchObject({ code: 'board-item-gone' });
        expect(persistence.acknowledged().boards[0]!.positionsByItemRef).toEqual({});
    });
});
