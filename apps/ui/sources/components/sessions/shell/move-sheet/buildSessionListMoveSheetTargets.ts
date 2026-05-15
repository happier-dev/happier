import type { BlockedReason, TreeDropResult } from '@/components/ui/treeDragDrop';
import { SESSION_FOLDER_MAX_DEPTH } from '@/sync/domains/session/folders/constants';

import type { SessionListTreeDragSource, SessionListTreeModel, SessionListTreeRowMetadata } from '../drop-resolution/sessionListTreeTypes';

export type SessionListMoveSheetTargetKind = 'root' | 'folder';

export type SessionListMoveSheetTarget = Readonly<{
    id: string;
    kind: SessionListMoveSheetTargetKind;
    label: string;
    disabled: boolean;
    disabledReason?: BlockedReason;
    result: TreeDropResult;
}>;

export type BuildSessionListMoveSheetTargetsParams = Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
    maxDepth?: number;
}>;

function compareByItemIndex(left: SessionListTreeRowMetadata, right: SessionListTreeRowMetadata): number {
    return left.itemIndex - right.itemIndex;
}

function readRowTitle(metadata: SessionListTreeRowMetadata): string {
    if (metadata.item.type === 'header') return String(metadata.item.title ?? metadata.folderId ?? '');
    return String(metadata.item.sessionId ?? metadata.sessionId ?? '');
}

function readSourceSubtreeDepthSpan(params: Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
}>): number {
    if (params.source.metadata.kind !== 'folder') return 0;
    const sourceDepth = params.source.metadata.folderDepth;
    let maxSpan = 0;
    for (const rowId of params.source.excludedDescendantIds) {
        const metadata = params.tree.rowMetadataById.get(rowId);
        if (!metadata || metadata.kind !== 'folder') continue;
        maxSpan = Math.max(maxSpan, metadata.folderDepth - sourceDepth);
    }
    return maxSpan;
}

function buildDisabledTarget(params: Readonly<{
    id: string;
    kind: SessionListMoveSheetTargetKind;
    label: string;
    reason: BlockedReason;
}>): SessionListMoveSheetTarget {
    return {
        id: params.id,
        kind: params.kind,
        label: params.label,
        disabled: true,
        disabledReason: params.reason,
        result: {
            instruction: { kind: 'blocked', reason: params.reason },
            visual: { kind: 'none' },
        },
    };
}

export function buildSessionListMoveSheetTargets(params: BuildSessionListMoveSheetTargetsParams): SessionListMoveSheetTarget[] {
    const maxDepth = params.maxDepth ?? SESSION_FOLDER_MAX_DEPTH;
    const source = params.source;
    const sourceRootId = source.metadata.rootId;
    const sourceSubtreeDepthSpan = readSourceSubtreeDepthSpan(params);
    const targets: SessionListMoveSheetTarget[] = [];

    const rootContainer = params.tree.containerMetadataById.get(sourceRootId);
    if (rootContainer) {
        const isSameContainer = source.metadata.containerId === rootContainer.containerId;
        targets.push(isSameContainer
            ? buildDisabledTarget({
                id: `root:${rootContainer.containerId}`,
                kind: 'root',
                label: rootContainer.groupKey,
                reason: 'same-position',
            })
            : {
                id: `root:${rootContainer.containerId}`,
                kind: 'root',
                label: rootContainer.groupKey,
                disabled: false,
                result: {
                    instruction: {
                        kind: 'move-to-root',
                        containerId: rootContainer.containerId,
                        rootId: rootContainer.rootId,
                        depth: rootContainer.depth,
                    },
                    visual: { kind: 'outline', targetId: rootContainer.containerId },
                },
            });
    }

    const folders = [...params.tree.rowMetadataById.values()]
        .filter((metadata) => metadata.kind === 'folder' && metadata.rootId === sourceRootId)
        .sort(compareByItemIndex);

    for (const folder of folders) {
        const label = readRowTitle(folder);
        const targetId = `folder:${folder.folderId ?? folder.rowId}`;
        const destinationDepth = folder.folderDepth + 1;
        const destinationExceedsDepth = destinationDepth + sourceSubtreeDepthSpan > maxDepth;
        if (source.excludedDescendantIds.has(folder.rowId)) {
            targets.push(buildDisabledTarget({
                id: targetId,
                kind: 'folder',
                label,
                reason: 'descendant-cycle',
            }));
            continue;
        }
        if (source.metadata.containerId === folder.rowId) {
            targets.push(buildDisabledTarget({
                id: targetId,
                kind: 'folder',
                label,
                reason: 'same-position',
            }));
            continue;
        }
        if (destinationExceedsDepth) {
            targets.push(buildDisabledTarget({
                id: targetId,
                kind: 'folder',
                label,
                reason: 'max-depth-exceeded',
            }));
            continue;
        }

        targets.push({
            id: targetId,
            kind: 'folder',
            label,
            disabled: false,
            result: {
                instruction: {
                    kind: 'nest-into',
                    targetId: folder.rowId,
                    containerId: folder.childContainerId ?? folder.rowId,
                    parentId: folder.rowId,
                    depth: destinationDepth,
                },
                visual: { kind: 'outline', targetId: folder.rowId },
            },
        });
    }

    return targets;
}
