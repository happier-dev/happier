import type { WorkBoardArtifactPortV1 } from '../boards/workBoardArtifactV1.js';
import { WorkBoardMutationErrorV1 } from '../boards/workBoardArtifactV1.js';
import { buildWorkBoardWidgetKeyV1, resolveWorkBoardItemOrderV1, WorkBoardWidgetMutationErrorV1,
  type WorkBoardWidgetIntentV1, type WorkBoardV1 } from '../boards/workBoardV1.js';
import type { WidgetActionSurfacePortV1 } from './actionsV1.js';
import type { WidgetInstanceV1, WidgetSurfaceRefV1 } from './widgetInstanceV1.js';
import type { WidgetExpectedPresentationV1 } from './widgetPresentationV1.js';

const failure = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
const ordered = (board: WorkBoardV1, surface: WidgetSurfaceRefV1) => {
  const order = resolveWorkBoardItemOrderV1(board);
  return (board.widgets ?? []).filter(item => item.ref.surface.serverId === surface.serverId && item.ref.surface.accountId === surface.accountId)
    .slice().sort((a, b) => order.indexOf(buildWorkBoardWidgetKeyV1(a.ref)) - order.indexOf(buildWorkBoardWidgetKeyV1(b.ref)));
};
/** The Board's acknowledged instance and placement facts, shared by transfer and arrival Undo. */
export function captureWorkBoardWidgetMoveV1(board: WorkBoardV1, surface: WidgetSurfaceRefV1, instanceId: string): Readonly<{
  expectedInstance: WidgetInstanceV1;
  expectedPresentation: WidgetExpectedPresentationV1;
}> | null {
  const item = ordered(board, surface).find(item => item.instance.id === instanceId);
  const position = item ? board.positionsByItemRef[buildWorkBoardWidgetKeyV1(item.ref)] : undefined;
  return item ? { expectedInstance: item.instance, expectedPresentation: {
    nativeIndex: resolveWorkBoardItemOrderV1(board).indexOf(buildWorkBoardWidgetKeyV1(item.ref)),
    width: item.width === 2 ? 'full' : 'half', frameStyle: item.frameStyle ?? null,
    canvasPosition: position ? [position.x, position.y] : null,
  } } : null;
}

/** A translation into the Board semantic writer, shared by UI and daemon Actions. */
export function createWorkBoardWidgetActionPortV1(port: Pick<WorkBoardArtifactPortV1, 'read' | 'apply'> & Partial<Pick<WorkBoardArtifactPortV1, 'readBoard'>>): WidgetActionSurfacePortV1 {
  const read = async (surface: WidgetSurfaceRefV1, signal?: AbortSignal) => {
    if (surface.owner.kind !== 'workBoard') throw new WorkBoardWidgetMutationErrorV1('widget_placement_unsupported');
    const boardId = surface.owner.boardId;
    const board = port.readBoard ? await port.readBoard(boardId, signal)
      : (await port.read(signal)).boards.find(board => board.id === boardId);
    if (!board) throw new WorkBoardMutationErrorV1('board_not_found');
    return board;
  };
  return {
    async read(surface, _context, signal) {
      try {
        return { surface, canEdit: true, instances: ordered(await read(surface, signal), surface).map(item => ({
          instance: item.instance, width: item.width === 2 ? 'full' as const : 'half' as const,
          ...(item.frameStyle ? { frameStyle: item.frameStyle } : {}),
        })) };
      } catch (error) {
        if (error instanceof WorkBoardMutationErrorV1 || error instanceof WorkBoardWidgetMutationErrorV1) return failure(error.code);
        throw error;
      }
    },
    async captureMove(surface, instanceId, _context, signal) {
      try { return captureWorkBoardWidgetMoveV1(await read(surface, signal), surface, instanceId) ?? failure('widget_instance_not_found'); }
      catch (error) {
        if (error instanceof WorkBoardMutationErrorV1 || error instanceof WorkBoardWidgetMutationErrorV1) return failure(error.code);
        throw error;
      }
    },
    async apply(surface, intent, _context, signal) {
      try {
        if (surface.owner.kind !== 'workBoard') return failure('widget_placement_unsupported');
        const instanceId = intent.kind === 'add' ? intent.instance.id : intent.instanceId;
        const target = { boardId: surface.owner.boardId, ref: { surface, instanceId } };
        let domain: WorkBoardWidgetIntentV1;
        switch (intent.kind) {
          case 'add':
            if (intent.placement || intent.position?.tabId) return failure('widget_placement_unsupported');
            domain = { ...target, kind: 'widget_add', instance: intent.instance,
              ...(intent.toIndex === undefined ? {} : { toIndex: intent.toIndex }),
              ...(intent.position ? { nativeIndex: intent.position.index } : {}),
              ...(intent.presentation?.width === 'half' || intent.presentation?.width === 'full'
                ? { width: intent.presentation.width === 'full' ? 2 : 1 } : {}),
              ...(intent.presentation?.frameStyle ? { frameStyle: intent.presentation.frameStyle } : {}) }; break;
          case 'remove': domain = { ...target, kind: 'widget_remove',
            ...(intent.expectedInstance ? { expectedInstance: intent.expectedInstance } : {}),
            ...(intent.expectedPresentation ? { expectedPresentation: intent.expectedPresentation } : {}) }; break;
          case 'move':
            if ('nativeIndex' in intent && intent.tabId) return failure('widget_placement_unsupported');
            domain = { ...target, kind: 'widget_move', ...('nativeIndex' in intent ? { nativeIndex: intent.nativeIndex } : { toIndex: intent.toIndex }) }; break;
          case 'width':
            if (intent.width !== 'half' && intent.width !== 'full') return failure('widget_width_unsupported');
            domain = { ...target, kind: 'widget_width', width: intent.width === 'full' ? 2 : 1 }; break;
          case 'frame': domain = { ...target, kind: 'widget_frame', frameStyle: intent.frameStyle }; break;
          case 'rename': domain = { ...target, kind: 'widget_rename', displayName: intent.displayName }; break;
          case 'inputs': domain = { ...target, kind: 'widget_inputs', bindings: intent.bindings }; break;
        }
        const result = await port.apply(domain, signal);
        const board = result.boards.find(board => board.id === target.boardId)!;
        const item = ordered(board, surface).find(item => item.instance.id === instanceId);
        return { ok: true, result: { ref: target.ref, instance: item?.instance ?? null,
          ...(intent.kind === 'add' && intent.captureForMove ? { moveCapture: captureWorkBoardWidgetMoveV1(board, surface, instanceId) } : {}) } };
      } catch (error) {
        if (error instanceof WorkBoardMutationErrorV1 || error instanceof WorkBoardWidgetMutationErrorV1) return failure(error.code);
        throw error;
      }
    },
  };
}
