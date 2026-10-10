import type { WorkBoardArtifactPortV1 } from '../boards/workBoardArtifactV1.js';
import { WorkBoardMutationErrorV1 } from '../boards/workBoardArtifactV1.js';
import { buildWorkBoardWidgetKeyV1, resolveWorkBoardItemOrderV1, WorkBoardWidgetMutationErrorV1,
  type WorkBoardWidgetIntentV1, type WorkBoardV1, type WorkBoardWidgetPlacementV1 } from '../boards/workBoardV1.js';
import type { WidgetActionSurfacePortV1 } from './actionsV1.js';
import type { WidgetInstanceV1, WidgetSurfaceRefV1 } from './widgetInstanceV1.js';
import { WidgetGridSizeV1Schema, normalizeWidgetSizeForSurfaceV1, type WidgetExpectedPresentationV1 } from './widgetPresentationV1.js';

const failure = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
const ordered = (board: WorkBoardV1, surface: WidgetSurfaceRefV1) => {
  const order = resolveWorkBoardItemOrderV1(board);
  // The admitted Artifact fixes the Home; stored server labels are client-local placement keys.
  return (board.widgets ?? []).filter(item => item.ref.surface.accountId === surface.accountId)
    .slice().sort((a, b) => order.indexOf(buildWorkBoardWidgetKeyV1(a.ref)) - order.indexOf(buildWorkBoardWidgetKeyV1(b.ref)));
};
/** A caller-routed id resolves only one retained placement within this admitted Board. */
export function resolveWorkBoardWidgetPlacementV1(board: WorkBoardV1, surface: WidgetSurfaceRefV1, instanceId: string): WorkBoardWidgetPlacementV1 | null {
  const matches = ordered(board, surface).filter(item => item.instance.id === instanceId);
  return matches.length === 1 ? matches[0]! : null;
}
/** The Board's acknowledged instance and placement facts, shared by transfer and arrival Undo. */
export function captureWorkBoardWidgetMoveV1(board: WorkBoardV1, surface: WidgetSurfaceRefV1, instanceId: string): Readonly<{
  expectedInstance: WidgetInstanceV1;
  expectedPresentation: WidgetExpectedPresentationV1;
}> | null {
  const item = resolveWorkBoardWidgetPlacementV1(board, surface, instanceId);
  const position = item ? board.positionsByItemRef[buildWorkBoardWidgetKeyV1(item.ref)] : undefined;
  return item ? { expectedInstance: item.instance, expectedPresentation: {
    nativeIndex: resolveWorkBoardItemOrderV1(board).indexOf(buildWorkBoardWidgetKeyV1(item.ref)),
    size: item.size, frameStyle: item.frameStyle ?? null,
    canvasPosition: position ? [position.x, position.y] : null,
  } } : null;
}

/** A translation into the Board semantic writer, shared by UI and daemon Actions. */
export function createWorkBoardWidgetActionPortV1(port: Pick<WorkBoardArtifactPortV1, 'readBoardAccess' | 'apply'>): WidgetActionSurfacePortV1 {
  const read = async (surface: WidgetSurfaceRefV1, signal?: AbortSignal) => {
    if (surface.owner.kind !== 'workBoard') throw new WorkBoardWidgetMutationErrorV1('widget_placement_unsupported');
    const admitted = await port.readBoardAccess(surface.owner.boardId, signal);
    if (!admitted) throw new WorkBoardMutationErrorV1('board_not_found');
    if (admitted.ownerAccountId && admitted.ownerAccountId !== surface.accountId) throw new WorkBoardMutationErrorV1('account_target_mismatch');
    return admitted;
  };
  return {
    async read(surface, _context, signal) {
      try {
        const admitted = await read(surface, signal);
        return { surface, canEdit: admitted.canEdit, isShared: admitted.isShared, instances: ordered(admitted.board, surface).map(item => ({
          instance: item.instance, size: item.size,
          ...(item.frameStyle ? { frameStyle: item.frameStyle } : {}),
        })) };
      } catch (error) {
        if (error instanceof WorkBoardMutationErrorV1 || error instanceof WorkBoardWidgetMutationErrorV1) return failure(error.code);
        throw error;
      }
    },
    async captureMove(surface, instanceId, _context, signal) {
      try { return captureWorkBoardWidgetMoveV1((await read(surface, signal)).board, surface, instanceId) ?? failure('widget_instance_not_found'); }
      catch (error) {
        if (error instanceof WorkBoardMutationErrorV1 || error instanceof WorkBoardWidgetMutationErrorV1) return failure(error.code);
        throw error;
      }
    },
    async apply(surface, intent, _context, signal) {
      try {
        if (surface.owner.kind !== 'workBoard') return failure('widget_placement_unsupported');
        if (intent.kind === 'group_create' || intent.kind === 'group_add' || intent.kind === 'group_ungroup'
          || intent.kind === 'group_set' || intent.kind === 'group_inputs' || intent.kind === 'width') return failure('unsupported_widget_group_surface');
        if (intent.kind === 'move' && intent.groupId !== undefined) return failure('unsupported_widget_group_surface');
        const instanceId = intent.kind === 'add' ? intent.instance.id : intent.instanceId;
        const admitted = await read(surface, signal);
        const placement = resolveWorkBoardWidgetPlacementV1(admitted.board, surface, instanceId);
        const present = ordered(admitted.board, surface).some(item => item.instance.id === instanceId);
        if (intent.kind === 'add' && present) return failure('widget_instance_already_exists');
        if (intent.kind !== 'add' && present && !placement) return failure('widget_placement_unsupported');
        if (intent.kind !== 'add' && !placement) return failure('widget_instance_not_found');
        const callerRef = { surface, instanceId };
        const target = { boardId: surface.owner.boardId, ref: placement?.ref ?? callerRef };
        let domain: WorkBoardWidgetIntentV1;
        switch (intent.kind) {
          case 'add': {
            if (intent.placement || intent.position?.tabId) return failure('widget_placement_unsupported');
            const size = normalizeWidgetSizeForSurfaceV1('workBoard', intent.presentation?.size);
            domain = { ...target, kind: 'widget_add', instance: intent.instance,
              ...(intent.toIndex === undefined ? {} : { toIndex: intent.toIndex }),
              ...(intent.position ? { nativeIndex: intent.position.index } : {}),
              size,
              ...(intent.presentation?.frameStyle ? { frameStyle: intent.presentation.frameStyle } : {}) }; break;
          }
          case 'remove': domain = { ...target, kind: 'widget_remove',
            ...(intent.expectedInstance ? { expectedInstance: intent.expectedInstance } : {}),
            ...(intent.expectedPresentation ? { expectedPresentation: intent.expectedPresentation } : {}) }; break;
          case 'move':
            if ('nativeIndex' in intent && intent.tabId) return failure('widget_placement_unsupported');
            domain = { ...target, kind: 'widget_move', ...('nativeIndex' in intent ? { nativeIndex: intent.nativeIndex } : { toIndex: intent.toIndex }) }; break;
          case 'size': {
            const size = WidgetGridSizeV1Schema.safeParse(intent.size);
            if (!size.success) return failure('widget_size_unsupported');
            domain = { ...target, kind: 'widget_size', size: size.data }; break;
          }
          case 'frame': domain = { ...target, kind: 'widget_frame', frameStyle: intent.frameStyle }; break;
          case 'rename': domain = { ...target, kind: 'widget_rename', displayName: intent.displayName }; break;
          case 'inputs': domain = { ...target, kind: 'widget_inputs', bindings: intent.bindings, ...(intent.paths ? { paths: [...intent.paths] } : {}) }; break;
          case 'inputs_reset': domain = { ...target, kind: 'widget_inputs_reset', ...(intent.paths ? { paths: [...intent.paths] } : {}) }; break;
        }
        const result = await port.apply(domain, signal);
        const board = result.boards.find(board => board.id === target.boardId)!;
        const item = ordered(board, surface).find(item => item.instance.id === instanceId);
        return { ok: true, result: { ref: callerRef, instance: item?.instance ?? null,
          ...(intent.kind === 'add' && intent.captureForMove ? { moveCapture: captureWorkBoardWidgetMoveV1(board, surface, instanceId) } : {}) } };
      } catch (error) {
        if (error instanceof WorkBoardMutationErrorV1 || error instanceof WorkBoardWidgetMutationErrorV1) return failure(error.code);
        throw error;
      }
    },
  };
}
