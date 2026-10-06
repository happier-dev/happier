import {
    BoardItemRefV1Schema, WorkBoardActionInputSchemasV1, WorkBoardMutationErrorV1,
    WorkBoardPositionV1Schema, buildWorkBoardItemKeyV1,
    buildWorkBoardWidgetKeyV1, resolveWorkBoardItemOrderV1,
    type BoardItemRefV1, type WorkBoardArtifactPortV1, type WorkBoardV1,
} from '@happier-dev/protocol';
import type { WidgetInstanceRefV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { entityDragScopesEqualV1, type EntityDragItemV1, type EntityDragScopeV1, type EntityDropAdmissionV1 } from '@happier-dev/protocol/plugins/ui';
import { t } from '@/text';
import { resolveBoardPruneMembership, type BoardMembership } from './boardMembership';
import { BOARD_CANVAS_METRICS, type BoardCanvasPoint } from './boardCanvasGeometry';
import type { WorkBoardSaveQueue } from './workBoardSaveQueue';
import { widgetEntitySourceRef } from '@/sync/ops/actions/widgetEntityMovement';

export type WorkBoardEntityContext = Readonly<{
    scope: EntityDragScopeV1;
    board: WorkBoardV1;
    membership: BoardMembership;
    isHomeMounted: (serverId: string) => boolean;
    /** Measured content positions, not another target registry or persisted layout. */
    measuredPositions?: ReadonlyMap<string, BoardCanvasPoint>;
}>;

const refused = (code: string, message: string): EntityDropAdmissionV1 => ({ status: 'refused', reason: { code, message } });

export class WorkBoardUiAdmissionError extends Error {
    constructor(readonly code: string) { super(code); this.name = 'WorkBoardUiAdmissionError'; }
}

/** Menu and external carries admit only the Board reference owner's actual kinds. */
export function resolveWorkBoardAdd(ref: unknown, context: WorkBoardEntityContext): EntityDropAdmissionV1 {
    const parsed = BoardItemRefV1Schema.safeParse(ref);
    if (!parsed.success) return refused('board-kind-unsupported', t('entityDragDrop.reasons.generic'));
    const key = buildWorkBoardItemKeyV1(parsed.data);
    if (context.board.source.picked.some(ref => buildWorkBoardItemKeyV1(ref) === key)
        || context.membership.members.some(member => member.key === key)) {
        return refused('board-already-here', t('boards.add.onBoard'));
    }
    return { status: 'allowed', effect: { actionId: 'boards.apply',
        input: { intent: { kind: 'add_items', boardId: context.board.id, refs: [parsed.data] } },
        preview: { glyph: 'board', verb: t('boards.header.add'), target: context.board.name } } };
}

/** Current domain admission, shared by pointer, staged keyboard and chooser. */
export function resolveWorkBoardEntityDrop(input: Readonly<{
    item: EntityDragItemV1;
    context: WorkBoardEntityContext;
    destination: unknown;
    canvasAvailable: boolean;
}>): EntityDropAdmissionV1 {
    const { item, context } = input;
    if (!entityDragScopesEqualV1(item.scope, context.scope)) return refused('board-scope-mismatch', t('entityDragDrop.surface.scopeMismatch'));
    const configuredRef = widgetEntitySourceRef(item);
    if (configuredRef && (item.kind !== 'work-board-widget' || item.boardId !== context.board.id)) {
        return { status: 'allowed', effect: { actionId: 'widgets.instance.move', input: { ref: configuredRef,
            to: { surface: workBoardWidgetSurface(context.scope, context.board.id), index: resolveWorkBoardItemOrderV1(context.board).length } },
            preview: { glyph: 'move', verb: t('entityDragDrop.organize.title'), target: context.board.name } } };
    }
    if (item.kind === 'session') {
        return resolveWorkBoardAdd({ kind: 'session', qualifiedId: { serverId: item.address.serverId, id: item.address.sessionId } }, context);
    }
    if (item.kind !== 'work-board-item' && item.kind !== 'work-board-widget') return refused('board-kind-unsupported', t('entityDragDrop.reasons.generic'));
    // Live-work references copy membership; configured copies above delegate to the widget owner.
    if (item.kind === 'work-board-item' && item.boardId !== context.board.id) return resolveWorkBoardAdd(item.item, context);
    if (!input.canvasAvailable || context.board.mode !== 'canvas') return refused('board-canvas-unavailable', t('entityDragDrop.reasons.generic'));
    const key = workBoardCanvasKey(item)!;
    if (!readWorkBoardCanvasKeys(context).includes(key)) return refused('board-item-gone', t('entityDragDrop.reasons.gone'));
    const point = WorkBoardPositionV1Schema.safeParse(input.destination);
    if (!point.success) return refused('board-position-unavailable', t('entityDragDrop.keyboard.choose'));
    const current = context.board.positionsByItemRef[key] ?? context.measuredPositions?.get(key);
    if (current?.x === point.data.x && current.y === point.data.y) return refused('board-no-change', t('entityDragDrop.reasons.noChange'));
    const positions: Record<string, BoardCanvasPoint> = {};
    // Freeze only current unplaced cards, work and widget alike. Saved positions and unrelated concurrent edits stay with the owner.
    for (const memberKey of readWorkBoardCanvasKeys(context)) {
        if (context.board.positionsByItemRef[memberKey]) continue;
        const measured = context.measuredPositions?.get(memberKey);
        if (measured) positions[memberKey] = measured;
    }
    positions[key] = point.data;
    return { status: 'allowed', effect: { actionId: 'boards.apply',
        input: { intent: { kind: 'set_positions', boardId: context.board.id, positionsByItemRef: positions } },
        preview: { glyph: 'move', verb: t('entityDragDrop.organize.title'), target: context.board.name,
            consequence: t('boards.card.moved', { x: Math.round(point.data.x / BOARD_CANVAS_METRICS.gridStepPx), y: Math.round(point.data.y / BOARD_CANVAS_METRICS.gridStepPx) }) } } };
}

/** Every card the Canvas lays out: live work members, then the Board's configured widgets. */
export function readWorkBoardCanvasKeys(context: WorkBoardEntityContext): readonly string[] {
    return [...context.membership.members.map(member => member.key), ...(context.board.widgets ?? []).map(item => buildWorkBoardWidgetKeyV1(item.ref))];
}

/** The Canvas key a same-Board carry moves: a work card's ref key, or a widget placement's qualified key. */
export function workBoardCanvasKey(item: EntityDragItemV1): string | null {
    if (item.kind === 'work-board-item') return buildWorkBoardItemKeyV1(item.item);
    if (item.kind === 'work-board-widget') return buildWorkBoardWidgetKeyV1(workBoardWidgetRef(item.scope, item.boardId, item.instanceId));
    return null;
}

/** The qualified surface a WorkBoard's widgets belong to: the Board in its Account scope. */
export function workBoardWidgetSurface(scope: EntityDragScopeV1, boardId: string): WidgetSurfaceRefV1 {
    return { serverId: scope.serverId, accountId: scope.accountId, owner: { kind: 'workBoard', boardId } };
}

/** A WorkBoard widget placement's qualified instance ref. */
export function workBoardWidgetRef(scope: EntityDragScopeV1, boardId: string, instanceId: string): WidgetInstanceRefV1 {
    return { surface: workBoardWidgetSurface(scope, boardId), instanceId };
}

/** Bound present-user Action port: policy stays in the executor; replay/CAS/retry stay in the Account queue. */
export function createWorkBoardUiActionPort(
    getContext: () => WorkBoardEntityContext | null,
    queue: WorkBoardSaveQueue,
): Pick<WorkBoardArtifactPortV1, 'read' | 'apply'> {
    return {
        read: async () => { const context = getContext(); if (!context) throw new WorkBoardMutationErrorV1('board_scope_retired'); return { v: 1, boards: [context.board] }; },
        apply: async (intent, signal) => {
            signal?.throwIfAborted();
            const context = getContext();
            if (!context) throw new WorkBoardMutationErrorV1('board_scope_retired');
            const parsed = WorkBoardActionInputSchemasV1['boards.apply'].parse({ intent });
            if (parsed.intent.kind === 'create' || parsed.intent.boardId !== context.board.id) throw new WorkBoardMutationErrorV1('board_not_found');
            if (parsed.intent.kind === 'set_positions') {
                const keys = new Set([...context.membership.members.map(member => member.key),
                    ...(context.board.widgets ?? []).map(item => buildWorkBoardWidgetKeyV1(item.ref))]);
                if (Object.keys(parsed.intent.positionsByItemRef).some(key => !keys.has(key))) throw new WorkBoardUiAdmissionError('board-item-gone');
            }
            const currentIntent = parsed.intent.kind === 'set_positions' || parsed.intent.kind === 'remove_item'
                ? { ...parsed.intent, membership: resolveBoardPruneMembership(context.board, context.membership, context.isHomeMounted) } : parsed.intent;
            const outcome = await queue.dispatch(currentIntent);
            if (outcome.status === 'applied') return outcome.boards;
            if (outcome.status === 'refused') throw new WorkBoardUiAdmissionError(outcome.code);
            // Queue recovery owns the uncertain write; carry its disposition across the Action boundary.
            throw Object.assign(new Error(outcome.code), { code: 'outcome_unknown' });
        },
    };
}

export function workBoardDragItem(scope: EntityDragScopeV1, boardId: string, item: BoardItemRefV1): EntityDragItemV1 {
    return { kind: 'work-board-item', scope, boardId, item };
}

export function workBoardWidgetDragItem(scope: EntityDragScopeV1, boardId: string, instanceId: string): EntityDragItemV1 {
    return { kind: 'work-board-widget', scope, boardId, instanceId };
}
