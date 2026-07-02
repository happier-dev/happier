/**
 * Builds the FROZEN drag snapshot once at drag start.
 *
 * Phase 2 of the session-list drag geometry & performance unification
 * (`.project/plans/session-list-drag-geometry-performance-unification.md`,
 * sections 3.2, 3.3). The snapshot freezes TREE TOPOLOGY and the visible render
 * ORDER only. It carries NO pixel geometry: every row/header has a stable
 * content-Y because the drag surface is frozen, and that geometry is owned by
 * the live content-coordinate registry (`treeDragDrop/registry`, section 3.1),
 * queried at resolve time and never frozen here.
 *
 * The topology is derived from `buildSessionListTreeRows`'s structural metadata
 * (`rowMetadataById`/`containerMetadataById`), NOT from its measured `rows`,
 * because those only exist when pixel bounds are supplied. Drop-resolution reads
 * row geometry live and uses these structural facts once a row id is hit.
 *
 * `../dev` note: the snapshot carries no `folderSortMode` — `../dev` resolves
 * folder-sort behaviour at commit time via `SessionListGroupOrderChildKind`,
 * reading the live `sessionListFolderSortModeV1`.
 */

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { TreeContainerDropZoneRole } from '@/components/ui/treeDragDrop';

import type {
    SessionListDragSnapshot,
    SessionListDragSnapshotInput,
    SessionListDragSnapshotSource,
    SessionListDragTopology,
    SessionListDragTopologyDropZone,
    SessionListDragTopologyRow,
} from './_types';
import { buildSessionListDragSource } from '../drop-resolution/buildSessionListDragSource';
import { buildSessionListTreeRows } from '../drop-resolution/buildSessionListTreeRows';
import type {
    SessionListTreeContainerMetadata,
    SessionListTreeModel,
    SessionListTreeRowMetadata,
} from '../drop-resolution/sessionListTreeTypes';
import { treeRowId } from '../drop-resolution/treeRowId';

let snapshotSequence = 0;

/**
 * Maps a `useSessionInlineDrag` drag key to its stable tree row id. Folder and
 * workspace-root keys are already row ids; a `server:session` key is expanded to
 * a `session:` row id.
 */
function resolveSourceRowIdFromDragKey(sessionKey: string): string {
    if (sessionKey.startsWith('folder:')) return sessionKey;
    if (sessionKey.startsWith('workspace-root:')) return sessionKey;
    const separatorIndex = sessionKey.indexOf(':');
    if (separatorIndex <= 0) return `session:${sessionKey}`;
    const serverId = sessionKey.slice(0, separatorIndex);
    const sessionId = sessionKey.slice(separatorIndex + 1);
    return treeRowId.session(serverId, sessionId);
}

/**
 * Derives the structural topology rows from the tree's row metadata. Sorted by
 * `itemIndex` so the frozen rows mirror the visible order.
 */
function buildTopologyRows(rowMetadataById: ReadonlyMap<string, SessionListTreeRowMetadata>): SessionListDragTopologyRow[] {
    return Array.from(rowMetadataById.values())
        .sort((left, right) => left.itemIndex - right.itemIndex)
        .map((metadata) => ({
            rowId: metadata.rowId,
            parentRowId: metadata.parentRowId,
            containerId: metadata.containerId,
            depth: metadata.folderDepth,
            kind: metadata.kind === 'session' ? 'leaf' : 'container',
        }));
}

/**
 * The visible child rows of a container, in render order.
 *
 * Mirrors the membership rule of the original `appendImplicitRootDropZones`
 * (`buildSessionListTreeRows`): a `workspace-order` container owns its
 * `workspace-root` rows; every other container owns its non-`workspace-root`
 * children. Sorted by `itemIndex` so `[0]` is the first row and `[len-1]` the
 * last.
 */
function orderedContainerChildren(
    container: SessionListTreeContainerMetadata,
    rowMetadataById: ReadonlyMap<string, SessionListTreeRowMetadata>,
): SessionListTreeRowMetadata[] {
    return Array.from(rowMetadataById.values())
        .filter((metadata) => metadata.containerId === container.containerId
            && (container.kind === 'workspace-order'
                ? metadata.kind === 'workspace-root'
                : metadata.kind !== 'workspace-root'))
        .sort((left, right) => left.itemIndex - right.itemIndex);
}

/**
 * Derives the structural container drop zones from the tree's container/row
 * metadata. Bounds are resolved live from registered row geometry in
 * `resolveSessionListDragPointer`; this only carries the structural facts the
 * resolver needs to derive those bounds and resolve the instruction.
 *
 * Each container with at least one measurable child row yields:
 * - a `root-before-first` zone anchored to the container's first child row;
 * - a `root-after-last` zone anchored to the container's last child row.
 *
 * Non-`workspace-order` containers additionally yield a `sibling-before` zone
 * for every adjacent child pair, anchored to the preceding sibling and
 * targeting the lower sibling — re-expressing the original
 * `appendImplicitRootDropZones` gap logic without baked-in pixel bounds.
 */
function buildTopologyDropZones(
    containerMetadataById: ReadonlyMap<string, SessionListTreeContainerMetadata>,
    rowMetadataById: ReadonlyMap<string, SessionListTreeRowMetadata>,
): SessionListDragTopologyDropZone[] {
    const dropZones: SessionListDragTopologyDropZone[] = [];
    for (const container of containerMetadataById.values()) {
        const children = orderedContainerChildren(container, rowMetadataById);
        const first = children[0] ?? null;
        const last = children[children.length - 1] ?? null;
        if (!first || !last) continue;

        const rootRole: ReadonlyArray<readonly [TreeContainerDropZoneRole, SessionListTreeRowMetadata]> = [
            ['root-before-first', first],
            ['root-after-last', last],
        ];
        for (const [role, anchor] of rootRole) {
            dropZones.push({
                containerId: container.containerId,
                rootId: container.rootId,
                parentRowId: container.parentRowId,
                depth: container.depth,
                role,
                anchorRowId: anchor.rowId,
            });
        }

        if (container.kind === 'workspace-order') continue;

        for (let index = 0; index < children.length - 1; index += 1) {
            const preceding = children[index];
            const next = children[index + 1];
            dropZones.push({
                containerId: container.containerId,
                rootId: container.rootId,
                parentRowId: container.parentRowId,
                depth: container.depth,
                role: 'sibling-before',
                targetRowId: next.rowId,
                anchorRowId: preceding.rowId,
            });
        }
    }
    return dropZones;
}

function buildTopology(tree: SessionListTreeModel): SessionListDragTopology {
    return {
        rows: buildTopologyRows(tree.rowMetadataById),
        dropZones: buildTopologyDropZones(tree.containerMetadataById, tree.rowMetadataById),
        rowMetadataById: tree.rowMetadataById,
        containerMetadataById: tree.containerMetadataById,
    };
}

function buildSignature(params: Readonly<{
    sourceRowId: string;
    items: ReadonlyArray<SessionListIndexItem>;
}>): string {
    return [params.sourceRowId, params.items.length].join('');
}

export function buildSessionListDragSnapshot(input: SessionListDragSnapshotInput): SessionListDragSnapshot {
    const tree = buildSessionListTreeRows({ items: input.items });
    const sourceRowId = resolveSourceRowIdFromDragKey(input.sessionDragKey);
    const treeSource = buildSessionListDragSource({ tree, sourceRowId });

    const source: SessionListDragSnapshotSource = {
        sourceRowId,
        sessionDragKey: input.sessionDragKey,
        kind: treeSource.kind,
        treeSource,
    };

    snapshotSequence += 1;

    return {
        snapshotId: `session-drag-${snapshotSequence}`,
        signature: buildSignature({
            sourceRowId,
            items: input.items,
        }),
        frozenItems: input.items,
        frozenViewItems: input.viewItems,
        topology: buildTopology(tree),
        source,
        foldersFeatureEnabled: input.foldersFeatureEnabled,
    };
}
