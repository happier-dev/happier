import { classifyVerticalThird } from './geometry/classifyVerticalThird';
import { computeNestInstructionDepth, computeReorderInstructionDepth } from './geometry/computeInstructionDepth';
import { containsPointer, hitTestRowAtPointer } from './geometry/hitTestRowAtPointer';
import { canTreeRowHaveChildren } from './rules/leafContainer';
import type {
    ResolveTreeInstructionParams,
    TreeContainerDropZone,
    TreeDropResult,
    TreeInstruction,
    TreeInstructionVisual,
    TreeRow,
    BlockedReason,
} from './treeDragDropTypes';

/**
 * Container rows get a wider, more forgiving middle "nest" band so dropping
 * *into* a folder is easy even on short folder headers — the top/bottom quarters
 * stay reorder edges. Leaf rows keep strict thirds (the default): their middle
 * band is a no-op (leaves can't be parents), so widening it would only grow a
 * "blocked" dead zone.
 */
const CONTAINER_NEST_BAND_RATIO = 0.5;

const idleResult: TreeDropResult = Object.freeze({
    instruction: Object.freeze({ kind: 'idle' as const }),
    visual: Object.freeze({ kind: 'none' as const }),
});

function blocked(reason: BlockedReason, hintTargetId?: string): TreeDropResult {
    return {
        instruction: hintTargetId ? { kind: 'blocked', reason, hintTargetId } : { kind: 'blocked', reason },
        visual: { kind: 'none' },
    };
}

function result(instruction: TreeInstruction, visual: TreeInstructionVisual): TreeDropResult {
    return { instruction, visual };
}

function hitTestDropZoneAtPointer(
    dropZones: ReadonlyArray<TreeContainerDropZone>,
    pointer: NonNullable<ResolveTreeInstructionParams['pointer']>,
): TreeContainerDropZone | null {
    const matches = dropZones.filter((zone) => containsPointer(zone.bounds, pointer));
    matches.sort((left, right) => {
        const rightPriority = right.role === 'sibling-before' || right.role === 'sibling-after' ? 1 : 0;
        const leftPriority = left.role === 'sibling-before' || left.role === 'sibling-after' ? 1 : 0;
        if (rightPriority !== leftPriority) return rightPriority - leftPriority;
        if (right.depth !== left.depth) return right.depth - left.depth;
        const leftArea = left.bounds.width * left.bounds.height;
        const rightArea = right.bounds.width * right.bounds.height;
        return leftArea - rightArea;
    });
    return matches[0] ?? null;
}

function resolveRowInstruction(params: ResolveTreeInstructionParams, target: TreeRow): TreeDropResult {
    if (target.id === params.source.id) return blocked('same-position', target.id);
    if (params.source.excludedDescendantIds.has(target.id)) return blocked('descendant-cycle', target.id);

    const canHaveChildren = canTreeRowHaveChildren(target);
    const verticalThird = classifyVerticalThird(
        target.bounds,
        params.pointer!,
        canHaveChildren ? CONTAINER_NEST_BAND_RATIO : undefined,
    );
    if (verticalThird === 'top' || verticalThird === 'bottom') {
        const depth = computeReorderInstructionDepth(target);
        if (typeof params.rules.maxDepth === 'number' && depth > params.rules.maxDepth) {
            return blocked('max-depth-exceeded', target.id);
        }
        if (!params.rules.canReorderAround(params.source, target, target.parentId)) {
            return blocked('workspace-scope-mismatch', target.id);
        }
        const kind = verticalThird === 'top' ? 'reorder-before' : 'reorder-after';
        const edge = verticalThird === 'top' ? 'top' : 'bottom';
        return result({
            kind,
            targetId: target.id,
            containerId: target.containerId,
            parentId: target.parentId,
            depth,
        }, {
            kind: 'line',
            targetId: target.id,
            edge,
            depth,
        });
    }

    if (!canHaveChildren) return blocked('leaf-cannot-be-parent', target.id);
    const depth = computeNestInstructionDepth({ ...target, depth: target.depth + 1 });
    if (typeof params.rules.maxDepth === 'number' && depth > params.rules.maxDepth) {
        return blocked('max-depth-exceeded', target.id);
    }
    if (!params.rules.canNestInto(params.source, target.id)) {
        return blocked('workspace-scope-mismatch', target.id);
    }
    return result({
        kind: 'nest-into',
        targetId: target.id,
        containerId: target.id,
        parentId: target.id,
        depth,
    }, {
        kind: 'outline',
        targetId: target.id,
    });
}

function resolveDropZoneInstruction(params: ResolveTreeInstructionParams, zone: TreeContainerDropZone): TreeDropResult {
    if (params.source.excludedDescendantIds.has(zone.containerId)) {
        return blocked('descendant-cycle', zone.containerId);
    }

    if ((zone.role === 'sibling-before' || zone.role === 'sibling-after') && zone.targetId) {
        const target = params.rows.find((row) => row.id === zone.targetId);
        if (!target) return blocked('no-target');
        if (params.source.excludedDescendantIds.has(target.id)) {
            return blocked('descendant-cycle', target.id);
        }
        if (typeof params.rules.maxDepth === 'number' && zone.depth > params.rules.maxDepth) {
            return blocked('max-depth-exceeded', target.id);
        }
        if (!params.rules.canReorderAround(params.source, target, zone.parentId)) {
            return blocked('workspace-scope-mismatch', target.id);
        }
        const kind = zone.role === 'sibling-before' ? 'reorder-before' : 'reorder-after';
        const edge = zone.role === 'sibling-before' ? 'top' : 'bottom';
        return result({
            kind,
            targetId: target.id,
            containerId: zone.containerId,
            parentId: zone.parentId,
            depth: zone.depth,
        }, {
            kind: 'line',
            targetId: target.id,
            edge,
            depth: zone.depth,
        });
    }

    if (zone.role === 'container-body') {
        const depth = computeNestInstructionDepth(zone);
        if (typeof params.rules.maxDepth === 'number' && depth > params.rules.maxDepth) {
            return blocked('max-depth-exceeded', zone.containerId);
        }
        if (!params.rules.canNestInto(params.source, zone.containerId)) {
            return blocked('workspace-scope-mismatch', zone.containerId);
        }
        return result({
            kind: 'nest-into',
            targetId: zone.containerId,
            containerId: zone.containerId,
            parentId: zone.containerId,
            depth,
        }, {
            kind: 'outline',
            targetId: zone.containerId,
        });
    }

    if (typeof params.rules.maxDepth === 'number' && zone.depth > params.rules.maxDepth) {
        return blocked('max-depth-exceeded', zone.containerId);
    }
    if (params.rules.canMoveToRoot && !params.rules.canMoveToRoot(params.source, zone)) {
        return blocked('workspace-scope-mismatch', zone.containerId);
    }

    const edge = zone.role === 'root-before-first' ? 'top' : 'bottom';
    return result({
        kind: 'move-to-root',
        containerId: zone.containerId,
        rootId: zone.rootId,
        depth: zone.depth,
    }, zone.role === 'root-empty' ? {
        kind: 'outline',
        targetId: zone.containerId,
    } : {
        kind: 'line',
        targetId: zone.containerId,
        edge,
        depth: zone.depth,
        dropZoneRole: zone.role,
    });
}

export function resolveTreeInstruction(params: ResolveTreeInstructionParams): TreeDropResult {
    if (!params.pointer) return idleResult;

    const rowTarget = hitTestRowAtPointer(params.rows, params.pointer);
    if (rowTarget) return resolveRowInstruction(params, rowTarget);

    const dropZoneTarget = hitTestDropZoneAtPointer(params.dropZones, params.pointer);
    if (dropZoneTarget) return resolveDropZoneInstruction(params, dropZoneTarget);

    return blocked('no-target');
}
