/**
 * Headless resolver: a `TreeInstructionVisual` plus content-coordinate row /
 * drop-zone geometry plus live viewport metrics -> numeric overlay geometry.
 *
 * Phase 1 of `.project/plans/session-list-drag-geometry-performance-unification.md`
 * (section 3.1). This is the pure bridge between the instruction layer
 * (`resolveTreeInstruction`) and the list-level drop overlay (`TreeDropOverlay`):
 * it turns "draw a line at the top edge of row X" into actual viewport-overlay
 * numbers the overlay can render without any React row reconciliation.
 *
 * No React, no theme, no session-list imports — only geometry math.
 */

import type { TreeInstructionVisual } from '../treeDragDropTypes';
import type { TreeContentBounds, TreeDropVisualGeometry, TreeViewportMetrics } from './treeContentGeometryTypes';
import type { TreeContentDropZone, TreeContentRow } from '../registry/treeDropRegistryTypes';
import { contentBoundsToOverlayGeometry } from './treeDropCoordinateSpace';

/**
 * Thickness, in px, of the reorder indicator line rectangle. The line is
 * centred on the target edge so it reads as sitting exactly between two rows.
 */
export const TREE_DROP_VISUAL_LINE_THICKNESS = 2;

export type ResolveTreeDropVisualGeometryParams = Readonly<{
    visual: TreeInstructionVisual;
    rows: ReadonlyArray<TreeContentRow>;
    dropZones: ReadonlyArray<TreeContentDropZone>;
    viewport: TreeViewportMetrics;
}>;

const noneGeometry: TreeDropVisualGeometry = Object.freeze({ kind: 'none' as const });

/**
 * Resolve the content bounds the visual `targetId` refers to. Row-hit visuals
 * intentionally prefer rows, while root drop-zone line visuals carry their
 * originating `dropZoneRole` so a container-id visual can target the implicit
 * zone band instead of a registered container/header row with the same id.
 */
function findTargetContentBounds(
    visual: Exclude<TreeInstructionVisual, { kind: 'none' }>,
    rows: ReadonlyArray<TreeContentRow>,
    dropZones: ReadonlyArray<TreeContentDropZone>,
): TreeContentBounds | null {
    const targetId = visual.targetId;
    if (visual.kind === 'line' && visual.dropZoneRole) {
        const dropZone = dropZones.find((candidate) => (
            candidate.role === visual.dropZoneRole
            && (candidate.containerId === targetId || candidate.targetId === targetId)
        ));
        if (dropZone) return dropZone.bounds;
    }

    const row = rows.find((candidate) => candidate.id === targetId);
    if (row) return row.bounds;
    const dropZone = dropZones.find((candidate) => (
        candidate.containerId === targetId || candidate.targetId === targetId
    ));
    return dropZone ? dropZone.bounds : null;
}

/**
 * Resolve numeric viewport-overlay geometry for the current drag visual.
 *
 * - `none`    -> `{ kind: 'none' }`.
 * - `line`    -> a thin rectangle centred on the target row/zone edge.
 * - `outline` -> a rectangle framing the whole target row/zone.
 *
 * If the visual references a target that is not currently registered (e.g. it
 * scrolled out of view before measuring), the result is `{ kind: 'none' }` so
 * the overlay simply hides rather than drawing stale geometry.
 */
export function resolveTreeDropVisualGeometry(
    params: ResolveTreeDropVisualGeometryParams,
): TreeDropVisualGeometry {
    const { visual, rows, dropZones, viewport } = params;
    if (visual.kind === 'none') return noneGeometry;

    const targetBounds = findTargetContentBounds(visual, rows, dropZones);
    if (!targetBounds) return noneGeometry;

    const frame = contentBoundsToOverlayGeometry(targetBounds, viewport);

    if (visual.kind === 'outline') {
        return { kind: 'outline', targetId: visual.targetId, geometry: frame };
    }

    const edgeCenterTop = visual.edge === 'top' ? frame.top : frame.top + frame.height;
    return {
        kind: 'line',
        depth: visual.depth,
        edge: visual.edge,
        targetId: visual.targetId,
        geometry: {
            top: edgeCenterTop - TREE_DROP_VISUAL_LINE_THICKNESS / 2,
            left: frame.left,
            width: frame.width,
            height: TREE_DROP_VISUAL_LINE_THICKNESS,
        },
    };
}
