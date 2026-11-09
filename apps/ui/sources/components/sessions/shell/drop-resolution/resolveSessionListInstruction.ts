import { resolveTreeInstruction, type TreeDropResult, type WindowPointer } from '@/components/ui/treeDragDrop';
import { resolveSessionListItemOrganizationEligibility } from '@/sync/domains/sessionList/sessionListIndex';
import { SESSION_FOLDER_MAX_DEPTH } from '@/sync/domains/session/folders/constants';
import { isSessionListSessionSiblingReorder } from '@/sync/domains/session/listing/sessionListLayout';
import { canMoveSessionListSourceToContainer, resolveSessionListDestinationFolderId } from './sessionListDestinationScope';

import type {
    SessionListInstructionBlockReason,
    SessionListTreeDragSource,
    SessionListTreeDropResult,
    SessionListTreeModel,
    SessionListTreeRowMetadata,
} from './sessionListTreeTypes';

function blocked(reason: SessionListInstructionBlockReason): SessionListTreeDropResult {
    return {
        instruction: { kind: 'blocked', reason: 'workspace-scope-mismatch' },
        visual: { kind: 'none' },
        sessionListBlockReason: reason,
    };
}

function resolveEligibilityBlock(params: Readonly<{
    source: SessionListTreeDragSource;
    foldersFeatureEnabled: boolean;
}>): SessionListInstructionBlockReason | null {
    if (params.source.metadata.kind === 'workspace-root') return null;

    const eligibility = resolveSessionListItemOrganizationEligibility(params.source.metadata.item, {
        foldersFeatureEnabled: params.foldersFeatureEnabled,
    });
    if (eligibility.reason === 'eligible') return null;
    if (eligibility.reason === 'feature-disabled') return 'feature-disabled';
    if (eligibility.reason === 'scope-unavailable') return 'scope-unavailable';
    return 'unsupported-item';
}

function isSameContainerSessionReorder(params: Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
    result: TreeDropResult;
}>): boolean {
    if (params.source.metadata.kind !== 'session') return false;
    if (
        params.result.instruction.kind !== 'reorder-before'
        && params.result.instruction.kind !== 'reorder-after'
    ) {
        return false;
    }
    const target = params.tree.rowMetadataById.get(params.result.instruction.targetId);
    return target?.kind === 'session'
        && target.containerId === params.source.metadata.containerId;
}

function isSessionSiblingReorder(params: Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
    result: TreeDropResult;
}>): boolean {
    if (params.source.metadata.kind !== 'session') return false;
    const instruction = params.result.instruction;
    if (instruction.kind === 'blocked' || instruction.kind === 'idle') return false;
    const destination = params.tree.containerMetadataById.get(instruction.containerId);
    if (!destination) return false;
    return isSessionListSessionSiblingReorder({
        sourceFolderId: params.source.metadata.folderId,
        destinationFolderId: resolveSessionListDestinationFolderId(params.source.metadata, destination),
    });
}

/**
 * The Session row a drop puts the source Session under (R-03 `manager`), when the resolved
 * instruction nests into a Session row rather than a folder.
 */
export function resolveSessionListLeadTarget(
    tree: SessionListTreeModel,
    result: TreeDropResult,
): SessionListTreeRowMetadata | null {
    if (result.instruction.kind !== 'nest-into') return null;
    const target = tree.rowMetadataById.get(result.instruction.targetId);
    return target?.kind === 'session' ? target : null;
}

export function resolveSessionListInstruction(params: Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
    pointer: WindowPointer | null;
    foldersFeatureEnabled: boolean;
    canReorderSessionSiblings?: boolean;
    maxDepth?: number;
    /**
     * Whether the dragged Session may be put under the target Session (the `manager` tree).
     * Omitted, a Session row is never a drop target — as before the tree existed.
     */
    canPutSessionUnder?: (sessionId: string, managerSessionId: string) => boolean;
}>): SessionListTreeDropResult {
    const resolved: TreeDropResult = resolveTreeInstruction({
        rows: params.tree.rows,
        dropZones: params.tree.dropZones,
        source: params.source,
        pointer: params.pointer,
        rules: {
            maxDepth: params.maxDepth ?? SESSION_FOLDER_MAX_DEPTH,
            canMoveToRoot: (_source, zone) => {
                if (params.source.metadata.kind === 'workspace-root') {
                    return params.tree.containerMetadataById.get(zone.containerId)?.kind === 'workspace-order'
                        && zone.containerId === params.source.metadata.containerId;
                }
                const container = params.tree.containerMetadataById.get(zone.containerId);
                return Boolean(container && canMoveSessionListSourceToContainer(params.source.metadata, container));
            },
            canNestInto: (_source, targetId) => {
                if (params.source.metadata.kind === 'workspace-root') return false;
                const target = params.tree.rowMetadataById.get(targetId);
                if (!target) return false;
                if (target.kind === 'session') return false;
                const container = target.childContainerId ? params.tree.containerMetadataById.get(target.childContainerId) : null;
                return Boolean(container && canMoveSessionListSourceToContainer(params.source.metadata, container));
            },
            canAdoptLeaf: (_source, target) => {
                const canPutSessionUnder = params.canPutSessionUnder;
                const dragged = params.source.metadata;
                if (!canPutSessionUnder || dragged.kind !== 'session' || !dragged.sessionId) return false;
                const lead = params.tree.rowMetadataById.get(target.id);
                if (lead?.kind !== 'session' || !lead.sessionId) return false;
                if (!dragged.serverId || lead.serverId !== dragged.serverId) return false;
                return canPutSessionUnder(dragged.sessionId, lead.sessionId);
            },
            canReorderAround: (_source, target) => {
                const targetMetadata = params.tree.rowMetadataById.get(target.id);
                if (!targetMetadata) return false;
                if (params.source.metadata.kind === 'workspace-root') {
                    return targetMetadata.kind === 'workspace-root'
                        && targetMetadata.containerId === params.source.metadata.containerId;
                }
                if (targetMetadata.kind === 'workspace-root') return false;
                const container = params.tree.containerMetadataById.get(targetMetadata.containerId);
                return Boolean(container && canMoveSessionListSourceToContainer(params.source.metadata, container));
            },
        },
    });

    // Putting a Session under a lead is not folder organization: folder and ordering gates do not
    // apply to it, and the adopt rule above already decided it.
    if (resolveSessionListLeadTarget(params.tree, resolved)) return resolved;

    const eligibilityBlock = resolveEligibilityBlock({
        source: params.source,
        foldersFeatureEnabled: params.foldersFeatureEnabled,
    });
    const isSiblingReorder = isSessionSiblingReorder({
        tree: params.tree,
        source: params.source,
        result: resolved,
    });
    if (isSiblingReorder && params.canReorderSessionSiblings === false) {
        return blocked('ordering-mode');
    }
    if (
        eligibilityBlock
        && !isSameContainerSessionReorder({
            tree: params.tree,
            source: params.source,
            result: resolved,
        })
    ) {
        return blocked(eligibilityBlock);
    }

    return resolved;
}
