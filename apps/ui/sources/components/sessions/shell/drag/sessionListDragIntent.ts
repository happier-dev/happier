/**
 * Converts a final `TreeDropResult` into a stable, serializable
 * `SessionListDragIntent`.
 *
 * Phase 2/4 of the session-list drag geometry & performance unification
 * (`.project/plans/session-list-drag-geometry-performance-unification.md`,
 * sections 3.2, 3.5). This is the object that survives from the visual phase
 * (resolved against the FROZEN snapshot) into the commit phase (rebased onto
 * the LATEST live state by `commitSessionListDragIntent`). It carries stable
 * ids only — no pixel geometry, no frozen order arrays.
 *
 * `../dev` derives root placement from the visual `edge` (its `TreeInstruction`
 * has no `move-to-root.placement` field), so the intent carries no
 * `rootPlacement` — the commit reconstructs the root placement from `edge`.
 */

import type { TreeDropResult, TreeRowKind } from '@/components/ui/treeDragDrop';

import type { SessionListDragIntent } from './_types';

export type BuildSessionListDragIntentParams = Readonly<{
    /** The final resolved drop result at drop time. */
    result: TreeDropResult;
    /** Stable tree row id of the dragged source. */
    sourceRowId: string;
    /** Structural kind of the dragged source. */
    sourceKind: TreeRowKind;
    /** Frozen snapshot signature, for diagnostics only. */
    snapshotSignature: string;
}>;

export function buildSessionListDragIntent(params: BuildSessionListDragIntentParams): SessionListDragIntent {
    const { instruction } = params.result;
    const hasTarget = instruction.kind === 'reorder-before'
        || instruction.kind === 'reorder-after'
        || instruction.kind === 'nest-into';
    const hasContainer = hasTarget || instruction.kind === 'move-to-root';

    return {
        sourceRowId: params.sourceRowId,
        sourceKind: params.sourceKind,
        instructionKind: instruction.kind,
        targetRowId: hasTarget ? instruction.targetId : null,
        containerId: hasContainer ? instruction.containerId : null,
        parentRowId: hasTarget ? instruction.parentId : null,
        depth: instruction.kind === 'idle' || instruction.kind === 'blocked' ? null : instruction.depth,
        edge: params.result.visual.kind === 'line' ? params.result.visual.edge : null,
        sourceSnapshotSignature: params.snapshotSignature,
    };
}
