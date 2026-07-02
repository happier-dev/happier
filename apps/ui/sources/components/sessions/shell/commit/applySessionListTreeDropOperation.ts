import type { SessionFoldersV1 } from '@/sync/domains/session/folders';
import {
    normalizeSessionListOrderingModeV1,
    normalizeSessionListFolderSortModeV1,
    resolveEffectiveSessionListFolderSortMode,
    resolveEffectiveSessionListOrderingModeForGroup,
    type SessionListOrderingModeV1,
    type SessionListOrderingSectionMode,
} from '@/sync/domains/session/listing/sessionListOrderingRules';

import { applyFolderAssignmentChange } from './applyFolderAssignmentChange';
import { applyFolderTreeMove } from './applyFolderTreeMove';
import { applyGroupOrderUpdate, type SessionListGroupOrderChildKind } from './applyGroupOrderUpdate';
import { applyWorkspaceOrderUpdate } from './applyWorkspaceOrderUpdate';
import type {
    SessionListTreeContainerMetadata,
    SessionListTreeDragSource,
    SessionListTreeDropResult,
    SessionListTreeModel,
    SessionListTreeRowMetadata,
} from '../drop-resolution/sessionListTreeTypes';

type SessionListGroupOrderV1 = Readonly<Record<string, ReadonlyArray<string> | undefined>>;
type SessionWorkspaceOrderV1 = Readonly<Record<string, ReadonlyArray<string> | undefined>>;
type SessionListFolderSortModeV1 = 'foldersFirst' | 'mixed';

type SessionListTreeDropOperationKind =
    | 'sessionSiblingReorder'
    | 'sessionContainerContainmentMove'
    | 'folderSiblingReorder'
    | 'folderNestingMove'
    | 'workspaceStructuralReorder'
    | 'invalid'
    | 'noop';

type SetSessionFolderAssignment = (assignment: Readonly<{
    serverId: string;
    sessionId: string;
    folderId: string | null;
}>) => Promise<void>;

export type ApplySessionListTreeDropOperationContext = Readonly<{
    sessionFoldersV1: SessionFoldersV1;
    sessionListGroupOrderV1: SessionListGroupOrderV1;
    sessionWorkspaceOrderV1?: SessionWorkspaceOrderV1;
    sessionListFolderSortModeV1?: SessionListFolderSortModeV1;
    sessionListOrderingModeV1?: SessionListOrderingModeV1;
    sessionListSectionModeV1?: SessionListOrderingSectionMode;
    now: () => number;
    setSessionFoldersV1: (next: SessionFoldersV1) => void;
    setSessionListGroupOrderV1: (next: Record<string, string[]>) => void;
    setSessionWorkspaceOrderV1?: (next: Record<string, string[]>) => void;
    setSessionFolderAssignment: SetSessionFolderAssignment;
}>;

export type ApplySessionListTreeDropOperationResult = Readonly<{
    ok: boolean;
    reason?: string;
}>;

/**
 * The destination container plus the before/after edge a fully-resolved
 * latest-tree drop result lands on. Exported as `SessionListTreeDropDestination`
 * so the commit-intent rebase (`drag/commitSessionListDragIntent.ts`) can probe
 * whether a rebased intent is a genuine no-op without duplicating the
 * edge-resolution logic.
 */
export type SessionListTreeDropDestination = Readonly<{
    container: SessionListTreeContainerMetadata;
    beforeRowId: string | null;
    afterRowId: string | null;
    target: SessionListTreeRowMetadata | null;
}>;

type Destination = SessionListTreeDropDestination;

function findContainerEdgeChildRowId(params: Readonly<{
    tree: SessionListTreeModel;
    containerId: string;
    sourceRowId: string;
    edge: 'top' | 'bottom';
}>): string | null {
    const container = params.tree.containerMetadataById.get(params.containerId);
    const rows = Array.from(params.tree.rowMetadataById.values())
        .filter((metadata) => metadata.containerId === params.containerId
            && metadata.rowId !== params.sourceRowId
            && (container?.kind === 'workspace-order'
                ? metadata.kind === 'workspace-root'
                : metadata.kind !== 'workspace-root'))
        .sort((left, right) => left.itemIndex - right.itemIndex);
    const row = params.edge === 'top' ? rows[0] : rows[rows.length - 1];
    return row?.rowId ?? null;
}

/**
 * Resolves the destination container and before/after edge for a fully-resolved
 * latest-tree drop result. Exported so `commitSessionListDragIntent` can probe a
 * rebased intent's no-op status without duplicating this logic.
 *
 * `move-to-root` placement is derived from `result.visual.edge` (`../dev` has no
 * `move-to-root.placement` field); callers committing a rebased move-to-root
 * pass a synthetic `result` carrying the line visual + edge.
 */
export function resolveSessionListTreeDropDestination(params: Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
    result: SessionListTreeDropResult;
}>): SessionListTreeDropDestination | null {
    return resolveDestination(params);
}

function resolveDestination(params: Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
    result: SessionListTreeDropResult;
}>): Destination | null {
    const { result, tree } = params;
    const { instruction } = result;
    if (instruction.kind === 'blocked' || instruction.kind === 'idle') return null;

    const container = tree.containerMetadataById.get(instruction.containerId);
    if (!container) return null;

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
    if (instruction.kind === 'move-to-root' && result.visual.kind === 'line') {
        const edgeRowId = findContainerEdgeChildRowId({
            tree,
            containerId: instruction.containerId,
            sourceRowId: params.source.metadata.rowId,
            edge: result.visual.edge,
        });
        return {
            container,
            beforeRowId: result.visual.edge === 'top' ? edgeRowId : null,
            afterRowId: result.visual.edge === 'bottom' ? edgeRowId : null,
            target: edgeRowId ? tree.rowMetadataById.get(edgeRowId) ?? null : null,
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

function classifyDropOperation(params: Readonly<{
    source: SessionListTreeDragSource;
    destination: Destination | null;
    currentParentFolderId?: string | null;
}>): SessionListTreeDropOperationKind {
    const { source, destination } = params;
    if (!destination) return 'invalid';

    if (source.metadata.kind === 'session') {
        return (source.metadata.folderId ?? null) === destination.container.folderId
            ? 'sessionSiblingReorder'
            : 'sessionContainerContainmentMove';
    }

    if (source.metadata.kind === 'folder') {
        const currentParentFolderId = params.currentParentFolderId ?? null;
        const destinationParentFolderId = destination.container.folderId;
        if (currentParentFolderId !== destinationParentFolderId) return 'folderNestingMove';
        if (destination.beforeRowId || destination.afterRowId) return 'folderSiblingReorder';
        return 'noop';
    }

    if (source.metadata.kind === 'workspace-root') return 'workspaceStructuralReorder';
    return 'invalid';
}

function resolveGroupOrderChildKind(
    sourceKind: 'session' | 'folder',
    folderSortMode: SessionListFolderSortModeV1 | undefined,
): SessionListGroupOrderChildKind {
    if (folderSortMode === 'mixed') return 'mixed';
    return sourceKind === 'session' ? 'sessionsOnly' : 'foldersOnly';
}

function resolveEffectiveFolderSortModeForDropContext(
    context: ApplySessionListTreeDropOperationContext,
): SessionListFolderSortModeV1 {
    return resolveEffectiveSessionListFolderSortMode({
        orderingMode: normalizeSessionListOrderingModeV1(context.sessionListOrderingModeV1),
        folderSortMode: normalizeSessionListFolderSortModeV1(context.sessionListFolderSortModeV1),
    });
}

async function applySessionDrop(params: Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
    destination: Destination;
    context: ApplySessionListTreeDropOperationContext;
    writeGroupOrder: boolean;
}>): Promise<boolean> {
    const { source, destination, context } = params;
    const serverId = source.metadata.serverId;
    const sessionId = source.metadata.sessionId;
    if (!serverId || !sessionId) return false;

    const destinationFolderId = destination.container.folderId;
    if ((source.metadata.folderId ?? null) !== destinationFolderId) {
        await applyFolderAssignmentChange({
            serverId,
            sessionId,
            folderId: destinationFolderId,
            setSessionFolderAssignment: context.setSessionFolderAssignment,
        });
    }

    if (!params.writeGroupOrder) return true;

    return applyGroupOrderUpdate({
        tree: params.tree,
        currentMap: context.sessionListGroupOrderV1,
        movedRowId: source.metadata.rowId,
        containerId: destination.container.containerId,
        beforeRowId: destination.beforeRowId,
        afterRowId: destination.afterRowId,
        childKind: resolveGroupOrderChildKind('session', resolveEffectiveFolderSortModeForDropContext(context)),
        setSessionListGroupOrderV1: context.setSessionListGroupOrderV1,
    });
}

function resolveFolderSiblingTargetId(target: SessionListTreeRowMetadata | null): string | null {
    return target?.kind === 'folder' ? target.folderId : null;
}

async function applyFolderDrop(params: Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
    destination: Destination;
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
        childKind: resolveGroupOrderChildKind('folder', resolveEffectiveFolderSortModeForDropContext(context)),
        setSessionListGroupOrderV1: context.setSessionListGroupOrderV1,
    });

    return shouldMoveFolderTree || orderUpdated;
}

function applyWorkspaceDrop(params: Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
    destination: Destination;
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
    const destination = resolveDestination({
        tree: params.tree,
        source: params.source,
        result: params.result,
    });
    if (!destination) {
        return {
            ok: false,
            reason: params.result.instruction.kind,
        };
    }

    const currentParentFolderId = params.source.metadata.kind === 'folder'
        ? resolveCurrentParentFolderId({ tree: params.tree, source: params.source })
        : null;
    const operationKind = classifyDropOperation({
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
        };
    }

    return { ok: false, reason: 'unsupported-source' };
}
