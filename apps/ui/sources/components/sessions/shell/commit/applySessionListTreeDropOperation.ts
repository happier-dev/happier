import type { TreeInstruction } from '@/components/ui/treeDragDrop';
import type { SessionFoldersV1 } from '@/sync/domains/session/folders';
import {
    normalizeSessionListOrderingModeV1,
    resolveEffectiveSessionListOrderingModeForGroup,
    type SessionListOrderingModeV1,
    type SessionListOrderingSectionMode,
} from '@/sync/domains/session/listing/sessionListOrderingRules';

import { applyFolderAssignmentChange } from './applyFolderAssignmentChange';
import { applyFolderTreeMove } from './applyFolderTreeMove';
import { applyGroupOrderUpdate } from './applyGroupOrderUpdate';
import { applyWorkspaceOrderUpdate } from './applyWorkspaceOrderUpdate';
import {
    classifySessionListTreeDropOperation,
    type SessionListTreeDropOperationKind,
} from './sessionListTreeDropOperationClassification';
import type {
    SessionListFolderSortMode,
    SessionListTreeContainerMetadata,
    SessionListTreeDragSource,
    SessionListTreeDropResult,
    SessionListTreeModel,
    SessionListTreeRowMetadata,
} from '../drop-resolution/sessionListTreeTypes';
import { DEFAULT_SESSION_LIST_FOLDER_SORT_MODE } from '../drop-resolution/sessionListTreeTypes';
import { resolveSessionListFolderSortModeDropResult } from '../drop-resolution/resolveSessionListFolderSortModeDrop';
import { canMoveSessionListSourceToContainer, canReorderSessionListSourceAroundTarget } from '../drop-resolution/sessionListDestinationScope';

type SessionListGroupOrderV1 = Readonly<Record<string, ReadonlyArray<string> | undefined>>;
type SessionWorkspaceOrderV1 = Readonly<Record<string, ReadonlyArray<string> | undefined>>;

type SetSessionFolderAssignment = (assignment: Readonly<{
    serverId: string;
    sessionId: string;
    folderId: string | null;
}>) => Promise<void>;

export type ApplySessionListTreeDropOperationContext = Readonly<{
    sessionFoldersV1: SessionFoldersV1;
    sessionListGroupOrderV1: SessionListGroupOrderV1;
    sessionWorkspaceOrderV1?: SessionWorkspaceOrderV1;
    now: () => number;
    folderSortMode?: SessionListFolderSortMode;
    sessionListOrderingModeV1?: SessionListOrderingModeV1;
    sessionListSectionModeV1?: SessionListOrderingSectionMode;
    setSessionFoldersV1: (next: SessionFoldersV1) => void;
    setSessionListGroupOrderV1: (next: Record<string, string[]>) => void;
    setSessionWorkspaceOrderV1?: (next: Record<string, string[]>) => void;
    setSessionFolderAssignment: SetSessionFolderAssignment;
}>;

export type ApplySessionListTreeDropOperationResult = Readonly<{
    ok: boolean;
    operationKind?: SessionListTreeDropOperationKind;
    reason?: string;
}>;

export type SessionListTreeDropDestination = Readonly<{
    container: SessionListTreeContainerMetadata;
    beforeRowId: string | null;
    afterRowId: string | null;
    target: SessionListTreeRowMetadata | null;
}>;

function findContainerEdgeChildRowId(params: Readonly<{
    tree: SessionListTreeModel;
    containerId: string;
    source: SessionListTreeDragSource;
    edge: 'first' | 'last';
}>): string | null {
    const children = Array.from(params.tree.rowMetadataById.values())
        .filter((metadata) => metadata.containerId === params.containerId
            && metadata.kind !== 'workspace-root'
            && metadata.rowId !== params.source.id
            && canReorderSessionListSourceAroundTarget(params.source.metadata, metadata))
        .sort((left, right) => left.itemIndex - right.itemIndex);
    const child = params.edge === 'first' ? children[0] : children[children.length - 1];
    return child?.rowId ?? null;
}

/**
 * Resolves the destination container and before/after edge for a fully-resolved
 * latest-tree instruction. Exported so the commit-intent rebase
 * (`drag/commitSessionListDragIntent.ts`) can probe whether a rebased intent is
 * a genuine no-op without duplicating this edge-resolution logic.
 */
export function resolveSessionListTreeDropDestination(params: Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
    instruction: TreeInstruction;
}>): SessionListTreeDropDestination | null {
    const { instruction, tree } = params;
    if (instruction.kind === 'blocked' || instruction.kind === 'idle') return null;

    const container = tree.containerMetadataById.get(instruction.containerId);
    if (!container || !canMoveSessionListSourceToContainer(params.source.metadata, container)) return null;

    if (instruction.kind === 'reorder-before' || instruction.kind === 'reorder-after') {
        const target = tree.rowMetadataById.get(instruction.targetId);
        if (!target || target.containerId !== container.containerId
            || !canReorderSessionListSourceAroundTarget(params.source.metadata, target)) return null;
    }

    if (instruction.kind === 'reorder-before') {
        return {
            container,
            beforeRowId: instruction.targetId,
            afterRowId: null,
            target: tree.rowMetadataById.get(instruction.targetId) ?? null,
        };
    }
    if (instruction.kind === 'reorder-after') {
        return {
            container,
            beforeRowId: null,
            afterRowId: instruction.targetId,
            target: tree.rowMetadataById.get(instruction.targetId) ?? null,
        };
    }

    if (instruction.kind === 'move-to-root' && instruction.placement === 'before-first') {
        const beforeRowId = findContainerEdgeChildRowId({
            tree,
            containerId: instruction.containerId,
            source: params.source,
            edge: 'first',
        });
        return {
            container,
            beforeRowId,
            afterRowId: null,
            target: beforeRowId ? tree.rowMetadataById.get(beforeRowId) ?? null : null,
        };
    }

    if (instruction.kind === 'move-to-root' && instruction.placement === 'after-last') {
        const afterRowId = findContainerEdgeChildRowId({
            tree,
            containerId: instruction.containerId,
            source: params.source,
            edge: 'last',
        });
        return {
            container,
            beforeRowId: null,
            afterRowId,
            target: afterRowId ? tree.rowMetadataById.get(afterRowId) ?? null : null,
        };
    }

    return {
        container,
        beforeRowId: null,
        afterRowId: null,
        target: null,
    };
}

function resolveCurrentParentFolderId(params: Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
}>): string | null {
    return params.tree.containerMetadataById.get(params.source.metadata.containerId)?.folderId ?? null;
}

function normalizeSessionListSectionMode(value: SessionListOrderingSectionMode | undefined): SessionListOrderingSectionMode {
    return value === 'single' ? 'single' : 'activity';
}

function resolveEffectiveOrderingModeForSessionSource(params: Readonly<{
    source: SessionListTreeDragSource;
    context: ApplySessionListTreeDropOperationContext;
}>): SessionListOrderingModeV1 {
    const item = params.source.metadata.item;
    const sectionMode = normalizeSessionListSectionMode(params.context.sessionListSectionModeV1);
    return resolveEffectiveSessionListOrderingModeForGroup({
        section: sectionMode === 'single'
            ? 'sessions'
            : item.type === 'session'
                ? item.section
                : null,
        sectionMode,
        groupKind: item.type === 'session' ? item.groupKind : null,
        userOrderingMode: normalizeSessionListOrderingModeV1(params.context.sessionListOrderingModeV1),
    });
}

function isDateOrderingMode(context: ApplySessionListTreeDropOperationContext): boolean {
    return normalizeSessionListOrderingModeV1(context.sessionListOrderingModeV1) !== 'custom';
}

function isStructuralFolderOrderKey(key: string): boolean {
    return key.startsWith('folder:');
}

async function applySessionDrop(params: Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
    destination: SessionListTreeDropDestination;
    context: ApplySessionListTreeDropOperationContext;
    writeGroupOrder: boolean;
}>): Promise<boolean> {
    const { source, destination, context } = params;
    const serverId = source.metadata.serverId;
    const sessionId = source.metadata.sessionId;
    if (!serverId || !sessionId) return false;

    let changed = false;
    const destinationFolderId = destination.container.folderId;
    if ((source.metadata.folderId ?? null) !== destinationFolderId) {
        await applyFolderAssignmentChange({
            serverId,
            sessionId,
            folderId: destinationFolderId,
            setSessionFolderAssignment: context.setSessionFolderAssignment,
        });
        changed = true;
    }

    if (!params.writeGroupOrder) return changed;

    return applyGroupOrderUpdate({
        tree: params.tree,
        currentMap: context.sessionListGroupOrderV1,
        movedRowId: source.metadata.rowId,
        containerId: destination.container.containerId,
        beforeRowId: destination.beforeRowId,
        afterRowId: destination.afterRowId,
        setSessionListGroupOrderV1: context.setSessionListGroupOrderV1,
    }) || changed;
}

function resolveFolderSiblingTargetId(target: SessionListTreeRowMetadata | null): string | null {
    return target?.kind === 'folder' ? target.folderId : null;
}

async function applyFolderDrop(params: Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
    destination: SessionListTreeDropDestination;
    context: ApplySessionListTreeDropOperationContext;
}>): Promise<boolean> {
    const { source, destination, context } = params;
    const folderId = source.metadata.folderId;
    if (!folderId) return false;

    const currentParentFolderId = resolveCurrentParentFolderId({
        tree: params.tree,
        source,
    });
    const destinationParentFolderId = destination.container.folderId;
    const beforeFolderId = destination.beforeRowId
        ? resolveFolderSiblingTargetId(destination.target)
        : null;
    const afterFolderId = destination.afterRowId
        ? resolveFolderSiblingTargetId(destination.target)
        : null;
    const shouldMoveFolderTree = currentParentFolderId !== destinationParentFolderId
        || Boolean(beforeFolderId)
        || Boolean(afterFolderId);

    if (shouldMoveFolderTree) {
        applyFolderTreeMove({
            current: context.sessionFoldersV1,
            folderId,
            parentId: destinationParentFolderId,
            beforeFolderId,
            afterFolderId,
            now: context.now(),
            setSessionFoldersV1: context.setSessionFoldersV1,
        });
    }

    const orderUpdated = applyGroupOrderUpdate({
        tree: params.tree,
        currentMap: context.sessionListGroupOrderV1,
        movedRowId: source.metadata.rowId,
        containerId: destination.container.containerId,
        beforeRowId: destination.beforeRowId,
        afterRowId: destination.afterRowId,
        orderKeyFilter: isDateOrderingMode(context) ? isStructuralFolderOrderKey : undefined,
        setSessionListGroupOrderV1: context.setSessionListGroupOrderV1,
    });

    return shouldMoveFolderTree || orderUpdated;
}

function applyWorkspaceDrop(params: Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
    destination: SessionListTreeDropDestination;
    context: ApplySessionListTreeDropOperationContext;
}>): boolean {
    const setSessionWorkspaceOrderV1 = params.context.setSessionWorkspaceOrderV1;
    if (!setSessionWorkspaceOrderV1) return false;
    return applyWorkspaceOrderUpdate({
        tree: params.tree,
        currentMap: params.context.sessionWorkspaceOrderV1 ?? {},
        movedRowId: params.source.metadata.rowId,
        containerId: params.destination.container.containerId,
        beforeRowId: params.destination.beforeRowId,
        afterRowId: params.destination.afterRowId,
        setSessionWorkspaceOrderV1,
    });
}

export async function applySessionListTreeDropOperation(params: Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
    result: SessionListTreeDropResult;
    context: ApplySessionListTreeDropOperationContext;
}>): Promise<ApplySessionListTreeDropOperationResult> {
    if (!resolveSessionListTreeDropDestination({ tree: params.tree, source: params.source, instruction: params.result.instruction })) {
        return { ok: false, operationKind: 'invalid', reason: params.result.instruction.kind };
    }
    const result = resolveSessionListFolderSortModeDropResult({
        tree: params.tree,
        source: params.source,
        result: params.result,
        folderSortMode: params.context.folderSortMode ?? DEFAULT_SESSION_LIST_FOLDER_SORT_MODE,
    });
    const destination = resolveSessionListTreeDropDestination({
        tree: params.tree,
        source: params.source,
        instruction: result.instruction,
    });
    if (!destination) {
        return {
            ok: false,
            operationKind: 'invalid',
            reason: result.instruction.kind,
        };
    }

    const currentParentFolderId = params.source.metadata.kind === 'folder'
        ? resolveCurrentParentFolderId({ tree: params.tree, source: params.source })
        : null;
    const operationKind = classifySessionListTreeDropOperation({
        source: params.source,
        destination,
        currentParentFolderId,
    });

    if (params.source.metadata.kind === 'session') {
        const effectiveOrderingMode = resolveEffectiveOrderingModeForSessionSource({
            source: params.source,
            context: params.context,
        });
        if (operationKind === 'sessionSiblingReorder' && effectiveOrderingMode !== 'custom') {
            return {
                ok: false,
                operationKind,
                reason: 'date-ordering-mode',
            };
        }
        return {
            ok: await applySessionDrop({
                tree: params.tree,
                source: params.source,
                destination,
                context: params.context,
                writeGroupOrder: effectiveOrderingMode === 'custom',
            }),
            operationKind,
        };
    }

    if (params.source.metadata.kind === 'folder') {
        return {
            ok: await applyFolderDrop({
                tree: params.tree,
                source: params.source,
                destination,
                context: params.context,
            }),
            operationKind,
        };
    }

    if (params.source.metadata.kind === 'workspace-root') {
        return {
            ok: applyWorkspaceDrop({
                tree: params.tree,
                source: params.source,
                destination,
                context: params.context,
            }),
            operationKind,
        };
    }

    return { ok: false, operationKind: 'invalid', reason: 'unsupported-source' };
}
