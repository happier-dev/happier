/**
 * Derives content-coordinate bounds for the session list's implicit drop zones.
 *
 * B1 fix for the session-list drag geometry & performance unification
 * (`.project/plans/session-list-drag-geometry-performance-unification.md`,
 * sections 3.1, 3.2, 3.6).
 *
 * The frozen `SessionListDragSnapshot` carries STRUCTURAL drop zones only
 * (`topology.dropZones`: containerId/role/anchorRowId/targetRowId, no bounds).
 * The live geometry registry, on the other hand, only ever registers ROWS — so
 * `registry.getContentGeometry().dropZones` is always empty. Without a bridge,
 * dropping into a gap that misses every row resolves to `blocked('no-target')`
 * and silently no-ops (drop below the last row, above the first row, or in the
 * gap between two sibling subtrees).
 *
 * This module is that bridge. It re-expresses the original
 * `appendImplicitRootDropZones` (`drop-resolution/buildSessionListTreeRows.ts`)
 * in content-coordinate space: for each structural zone it looks up the
 * anchor row's LIVE content bounds and synthesizes a `TreeContentDropZone` band
 * the resolver can hit-test:
 *
 * - `root-before-first` -> a band directly ABOVE the container's first row;
 * - `root-after-last`   -> a band directly BELOW the container's last row;
 * - `sibling-before`    -> the gap before the target row, bounded above by the
 *                          bottom of the preceding sibling's visible subtree.
 *
 * Implicit-zone band height preserves `../dev`'s larger sizing intent
 * (`Math.max(16, Math.min(anchorHeight, 40))`) so root-edge drops stay easy to
 * hit — identical to `buildImplicitDropZoneBounds` in `buildSessionListTreeRows`.
 *
 * Pure geometry: no React, no platform imports.
 */

import type { TreeContentDropZone, TreeContentRow } from '@/components/ui/treeDragDrop';

import type { SessionListDragTopologyDropZone } from './_types';
import type { SessionListTreeRowMetadata } from '../drop-resolution/sessionListTreeTypes';

/**
 * Minimum / maximum height, in content px, of an implicit root-edge band.
 *
 * Preserves the `../dev` `Math.max(16, Math.min(anchor.height, 40))` intent
 * (plan §2.4): a root-edge / gap band is at least 16px tall so it is reliably
 * hit, and at most 40px so it never swallows neighbouring rows.
 */
export const IMPLICIT_ROOT_DROP_ZONE_MIN_HEIGHT = 16;
export const IMPLICIT_ROOT_DROP_ZONE_MAX_HEIGHT = 40;

function clampBandHeight(anchorHeight: number): number {
    return Math.max(
        IMPLICIT_ROOT_DROP_ZONE_MIN_HEIGHT,
        Math.min(anchorHeight, IMPLICIT_ROOT_DROP_ZONE_MAX_HEIGHT),
    );
}

/**
 * Collects the row ids of a row's visible subtree (the row itself plus every
 * transitive descendant) from the frozen topology's parent links. Used to find
 * how far down a preceding sibling's subtree reaches so the `sibling-before`
 * gap starts below the whole subtree, not just below the sibling's own row.
 */
function collectSubtreeRowIds(
    rootRowId: string,
    rowMetadataById: ReadonlyMap<string, SessionListTreeRowMetadata>,
): Set<string> {
    const subtree = new Set<string>([rootRowId]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const metadata of rowMetadataById.values()) {
            if (!metadata.parentRowId || subtree.has(metadata.rowId)) continue;
            if (!subtree.has(metadata.parentRowId)) continue;
            subtree.add(metadata.rowId);
            changed = true;
        }
    }
    return subtree;
}

/**
 * The bottom content-Y of a row's visible subtree, using LIVE registry geometry.
 * Returns `null` when no row of the subtree is currently measured.
 */
function resolveSubtreeBottom(
    anchorRowId: string,
    rowsById: ReadonlyMap<string, TreeContentRow>,
    rowMetadataById: ReadonlyMap<string, SessionListTreeRowMetadata>,
): number | null {
    const subtreeIds = collectSubtreeRowIds(anchorRowId, rowMetadataById);
    let bottom: number | null = null;
    for (const rowId of subtreeIds) {
        const row = rowsById.get(rowId);
        if (!row) continue;
        const rowBottom = row.bounds.y + row.bounds.height;
        bottom = bottom === null ? rowBottom : Math.max(bottom, rowBottom);
    }
    return bottom;
}

function buildRootEdgeZone(
    zone: SessionListDragTopologyDropZone,
    anchor: TreeContentRow,
): TreeContentDropZone {
    const height = clampBandHeight(anchor.bounds.height);
    const y = zone.role === 'root-before-first'
        ? anchor.bounds.y - height
        : anchor.bounds.y + anchor.bounds.height;
    return {
        containerId: zone.containerId,
        rootId: zone.rootId,
        parentId: zone.parentRowId,
        depth: zone.depth,
        role: zone.role,
        bounds: {
            x: anchor.bounds.x,
            y,
            width: anchor.bounds.width,
            height,
        },
    };
}

function buildSiblingBeforeZone(
    zone: SessionListDragTopologyDropZone,
    target: TreeContentRow,
    subtreeBottom: number,
): TreeContentDropZone | null {
    const gapHeight = target.bounds.y - subtreeBottom;
    if (gapHeight <= 0) return null;
    return {
        containerId: zone.containerId,
        rootId: zone.rootId,
        parentId: zone.parentRowId,
        depth: zone.depth,
        role: 'sibling-before',
        targetId: zone.targetRowId,
        bounds: {
            x: target.bounds.x,
            y: subtreeBottom,
            width: target.bounds.width,
            height: gapHeight,
        },
    };
}

export type ResolveImplicitDropZoneBoundsParams = Readonly<{
    /** Structural drop zones from the frozen snapshot topology. */
    topologyDropZones: ReadonlyArray<SessionListDragTopologyDropZone>;
    /** Live content-coordinate rows from the geometry registry. */
    rows: ReadonlyArray<TreeContentRow>;
    /** Frozen per-row metadata (parent links) for subtree collection. */
    rowMetadataById: ReadonlyMap<string, SessionListTreeRowMetadata>;
}>;

/**
 * Resolves content-coordinate `TreeContentDropZone`s for every structural zone
 * whose anchor/target rows are currently measured in the live registry.
 *
 * Zones whose anchor row has not mounted yet (e.g. just autoscrolled into view)
 * are skipped — the resolver simply finds no zone there until it measures,
 * exactly as a row hit would behave for an unmeasured row.
 */
export function resolveImplicitDropZoneBounds(
    params: ResolveImplicitDropZoneBoundsParams,
): TreeContentDropZone[] {
    const rowsById = new Map(params.rows.map((row) => [row.id, row]));
    const resolved: TreeContentDropZone[] = [];

    for (const zone of params.topologyDropZones) {
        if (zone.role === 'root-before-first' || zone.role === 'root-after-last') {
            const anchor = zone.anchorRowId ? rowsById.get(zone.anchorRowId) ?? null : null;
            if (!anchor) continue;
            resolved.push(buildRootEdgeZone(zone, anchor));
            continue;
        }

        if (zone.role === 'sibling-before') {
            const target = zone.targetRowId ? rowsById.get(zone.targetRowId) ?? null : null;
            if (!target || !zone.anchorRowId) continue;
            const subtreeBottom = resolveSubtreeBottom(
                zone.anchorRowId,
                rowsById,
                params.rowMetadataById,
            );
            if (subtreeBottom === null) continue;
            const siblingZone = buildSiblingBeforeZone(zone, target, subtreeBottom);
            if (siblingZone) resolved.push(siblingZone);
        }
    }

    return resolved;
}
