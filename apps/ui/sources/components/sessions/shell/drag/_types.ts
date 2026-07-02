/**
 * Session-list drag contract types.
 *
 * Phase 0.5 interface freeze for the session-list drag geometry & performance
 * unification (`.project/plans/session-list-drag-geometry-performance-unification.md`,
 * sections 3.2, 3.3, 3.4, 3.5). These are the contracts the drag snapshot,
 * resolver, overlay, and commit modules import. Pure type file: no behaviour.
 *
 * `../dev` port note (Lane G):
 * - `../dev` resolves folder-sort behaviour at COMMIT time via
 *   `SessionListGroupOrderChildKind` (`applyGroupOrderUpdate.ts`), not in
 *   `resolveSessionListInstruction`. There is no `SessionListFolderSortMode`
 *   type here and the snapshot carries NO `folderSortMode`: the commit reads the
 *   live `sessionListFolderSortModeV1` instead.
 * - `../dev`'s `TreeInstruction` has no `move-to-root.placement`. Root placement
 *   is derived from the visual `edge`, so `SessionListDragIntent` carries no
 *   `rootPlacement` field.
 *
 * Core separation enforced by these types:
 * - `SessionListDragSnapshot` freezes TREE TOPOLOGY ONLY at drag start. It
 *   carries NO pixel geometry. Pixel geometry is owned by the LIVE generic
 *   content-coordinate registry (`treeDragDrop/registry`, section 3.1) and is
 *   queried at resolve time, never frozen.
 * - `SessionListDragIntent` is the serializable, stable-id final intent that
 *   survives from the visual phase to the commit phase.
 * - The overlay shared-values shape is numeric only; the indicator never drives
 *   per-row React state.
 */

import type { TreeContainerDropZoneRole, TreeInstruction, TreeRowKind } from '@/components/ui/treeDragDrop';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import type {
    SessionListTreeContainerMetadata,
    SessionListTreeDragSource,
    SessionListTreeRowMetadata,
} from '../drop-resolution/sessionListTreeTypes';

// ---------------------------------------------------------------------------
// Frozen tree topology (no pixel geometry)
// ---------------------------------------------------------------------------

/**
 * A single tree row in the frozen topology — its structural identity only.
 *
 * Deliberately omits `bounds`: pixel geometry is NOT frozen. Hit-testing reads
 * live content-coordinate geometry from the registry and uses this row's `id`
 * to look up the resolved instruction in the frozen topology.
 */
export type SessionListDragTopologyRow = Readonly<{
    rowId: string;
    parentRowId: string | null;
    containerId: string;
    depth: number;
    kind: TreeRowKind;
}>;

/**
 * A container drop zone in the frozen topology — structural identity only.
 *
 * Deliberately omits `bounds`. Implicit drop-zone *bounds* are resolved live in
 * `resolveSessionListDragPointer` from registered row geometry; this descriptor
 * only carries the structural facts the resolver needs to (a) derive those
 * bounds and (b) resolve the instruction once a zone is hit:
 *
 * - `root-before-first` / `root-after-last`: a band above the container's first
 *   row / below its last row — `anchorRowId` is that first/last child row.
 * - `sibling-before`: the gap before `targetRowId` — `anchorRowId` is the
 *   immediately-preceding sibling whose visible subtree bottom bounds the gap.
 */
export type SessionListDragTopologyDropZone = Readonly<{
    containerId: string;
    rootId: string;
    parentRowId: string | null;
    depth: number;
    role: TreeContainerDropZoneRole;
    /** The reorder target row (`sibling-before`). Omitted for root zones. */
    targetRowId?: string;
    /**
     * The row whose live geometry anchors this zone's bounds:
     * - `root-before-first`: the container's first child row;
     * - `root-after-last`: the container's last child row;
     * - `sibling-before`: the preceding sibling row.
     * Omitted only when the container has no measurable child rows.
     */
    anchorRowId?: string;
}>;

/**
 * The frozen tree topology captured at drag start.
 *
 * Rows, drop zones, parent/child links, per-row and per-container metadata, and
 * the source row's session-list metadata — all WITHOUT pixel bounds. This is
 * the structural half of `SessionListDragSnapshot`.
 */
export type SessionListDragTopology = Readonly<{
    rows: ReadonlyArray<SessionListDragTopologyRow>;
    dropZones: ReadonlyArray<SessionListDragTopologyDropZone>;
    rowMetadataById: ReadonlyMap<string, SessionListTreeRowMetadata>;
    containerMetadataById: ReadonlyMap<string, SessionListTreeContainerMetadata>;
}>;

// ---------------------------------------------------------------------------
// Frozen drag snapshot
// ---------------------------------------------------------------------------

/**
 * Identity of the dragged row at drag start.
 *
 * `sourceRowId` is the stable tree row id; `sessionDragKey` is the row's drag
 * key as understood by `useSessionInlineDrag` (`sessionKey`).
 */
export type SessionListDragSnapshotSource = Readonly<{
    sourceRowId: string;
    sessionDragKey: string;
    kind: TreeRowKind;
    /** Generic tree drag source (excluded descendants etc.) for the resolver. */
    treeSource: SessionListTreeDragSource;
}>;

/**
 * The frozen snapshot built once at drag start.
 *
 * Freezes tree TOPOLOGY and the frozen visible list ORDER only. It carries NO
 * pixel geometry: every row/header has a stable content-Y because the drag
 * surface is frozen, and that geometry is owned by the live registry. The
 * snapshot is held in a ref; React only flips `snapshotId` on drag start/end.
 *
 * Background store/sync updates during a drag must NOT mutate this snapshot.
 */
export type SessionListDragSnapshot = Readonly<{
    /** Stable id; the only value that becomes minimal React state on start/end. */
    snapshotId: string;
    /** Monotonic signature for diagnostics/tests (e.g. source id + item count). */
    signature: string;
    /** Frozen session-list index used to build the topology, for diagnostics. */
    frozenItems: ReadonlyArray<SessionListIndexItem>;
    /** Frozen visible render items shown while dragging (frozen order). */
    frozenViewItems: ReadonlyArray<SessionListIndexItem>;
    /** Frozen tree topology for drop resolution — no pixel geometry. */
    topology: SessionListDragTopology;
    /** Identity of the dragged row. */
    source: SessionListDragSnapshotSource;
    /** Whether session folders are enabled, captured at drag start. */
    foldersFeatureEnabled: boolean;
}>;

/**
 * Input to `buildSessionListDragSnapshot`.
 *
 * Pure inputs read once at drag start. No measured geometry is passed in: the
 * snapshot must not bake pixel bounds.
 */
export type SessionListDragSnapshotInput = Readonly<{
    /** Latest session-list index at drag start. */
    items: ReadonlyArray<SessionListIndexItem>;
    /** Latest visible render items at drag start (frozen order to display). */
    viewItems: ReadonlyArray<SessionListIndexItem>;
    /** Drag key of the row being dragged (`useSessionInlineDrag` sessionKey). */
    sessionDragKey: string;
    foldersFeatureEnabled: boolean;
}>;

// ---------------------------------------------------------------------------
// Frozen-list projection
// ---------------------------------------------------------------------------

/**
 * Input to the frozen-list projection (`useFrozenSessionListItemsDuringDrag`).
 *
 * Chooses which list projection `SessionsList` renders. It only selects; it
 * never blocks background store updates.
 */
export type FrozenSessionListProjectionInput = Readonly<{
    /** The active drag snapshot, or `null` when no drag is active. */
    activeSnapshot: SessionListDragSnapshot | null;
    /** The latest live visible render items (used when no drag is active). */
    liveViewItems: ReadonlyArray<SessionListIndexItem>;
}>;

/**
 * Output of the frozen-list projection.
 *
 * `frozen` is `true` while a drag holds the surface; `viewItems` is then the
 * snapshot's frozen order. After drop/cancel, `frozen` is `false` and
 * `viewItems` is the latest live list.
 */
export type FrozenSessionListProjectionResult = Readonly<{
    frozen: boolean;
    viewItems: ReadonlyArray<SessionListIndexItem>;
    /** Snapshot id while frozen, else `null` — drives list `extraData`/keys. */
    snapshotId: string | null;
}>;

// ---------------------------------------------------------------------------
// Final intent + commit result
// ---------------------------------------------------------------------------

/**
 * The serializable, stable-id final drag intent.
 *
 * Built from the last `TreeDropResult` at drop time and the object that
 * survives from the visual phase into the commit phase. It carries stable ids
 * only — no pixel geometry and no frozen order arrays.
 *
 * `../dev` derives root placement from the visual `edge` and carries no
 * `rootPlacement` field (its `TreeInstruction` has no `move-to-root.placement`).
 */
export type SessionListDragIntent = Readonly<{
    /** Stable tree row id of the dragged source. */
    sourceRowId: string;
    /** Structural kind of the dragged source. */
    sourceKind: TreeRowKind;
    /** The resolved tree instruction kind. */
    instructionKind: TreeInstruction['kind'];
    /** Resolved target row id, when the instruction has one. */
    targetRowId: string | null;
    /** Resolved container id the move lands in, when applicable. */
    containerId: string | null;
    /** Resolved parent row id the source becomes a child of, when applicable. */
    parentRowId: string | null;
    /** Resolved tree depth of the instruction, when applicable. */
    depth: number | null;
    /** Resolved edge for line visuals / root placement derivation. */
    edge: 'top' | 'bottom' | null;
    /** Snapshot signature, for diagnostics only — never used for commit logic. */
    sourceSnapshotSignature: string;
}>;

/**
 * Reason a drag commit was a no-op.
 *
 * Stable reason codes (not user-facing copy) for the mid-drag mutation policy
 * (plan section 1.5). The commit rebases the intent onto latest live state and
 * no-ops when the move is no longer valid.
 */
export type SessionListDragCommitNoOpReason =
    | 'blocked-intent'
    | 'source-missing'
    | 'target-missing'
    | 'container-missing'
    | 'scope-mismatch'
    | 'descendant-cycle'
    | 'date-ordering-mode'
    | 'no-change';

/**
 * Result of committing a `SessionListDragIntent` against latest live state.
 *
 * `ok: true` means the move was applied (or safely degraded). `ok: false`
 * carries a stable `reason`. Shape is aligned with the existing
 * `ApplySessionListTreeDropOperationResult` (`{ ok, reason? }`).
 */
export type SessionListDragCommitResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; reason: SessionListDragCommitNoOpReason }>;
