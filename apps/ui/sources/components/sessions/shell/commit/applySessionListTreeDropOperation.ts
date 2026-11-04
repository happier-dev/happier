import {
    isSessionListSessionSiblingReorder,
    resolveSessionListSessionRowDragPolicy,
} from '@/sync/domains/session/listing/sessionListLayout';

import { applyFolderAssignmentChange } from './applyFolderAssignmentChange';
import { applyGroupOrderUpdate } from './applyGroupOrderUpdate';
import { applyWorkspaceOrderUpdate } from './applyWorkspaceOrderUpdate';
import type {
    SessionListTreeContainerMetadata,
    SessionListTreeDragSource,
    SessionListTreeDropResult,
    SessionListTreeModel,
    SessionListTreeRowMetadata,
} from '../drop-resolution/sessionListTreeTypes';
import { canMoveSessionListSourceToContainer, resolveSessionListDestinationFolderId } from '../drop-resolution/sessionListDestinationScope';
import type { SessionSection } from '@/sync/domains/session/organization/sections';

type SessionListGroupOrderV1 = Readonly<Record<string, ReadonlyArray<string> | undefined>>;
type SessionWorkspaceOrderV1 = Readonly<Record<string, ReadonlyArray<string> | undefined>>;

type SessionListTreeDropOperationKind =
    | 'sessionSiblingReorder'
    | 'sessionContainerContainmentMove'
    | 'folderSiblingReorder'
    | 'workspaceStructuralReorder'
    | 'invalid'
    | 'noop';

type SetSessionFolderAssignment = (assignment: Readonly<{
    serverId: string;
    sessionId: string;
    folderId: string | null;
}>) => Promise<void>;

export type ApplySessionListTreeDropOperationContext = Readonly<{
    sessionSections?: readonly SessionSection[];
    sessionListGroupOrderV1: SessionListGroupOrderV1;
    sessionWorkspaceOrderV1?: SessionWorkspaceOrderV1;
    sessionListLayoutV1?: 'projects' | 'recent_activity';
    manualSessionOrderingEnabled?: boolean;
    isFolderOrganizationEnabled?: (serverId: string | null) => boolean;
    setSessionListGroupOrderV1: (next: Record<string, string[]>) => Promise<void>;
    setSessionWorkspaceOrderV1?: (next: Record<string, string[]>) => Promise<void>;
    setSessionFolderAssignment?: SetSessionFolderAssignment;
    reorderSessionSection?: (input: Readonly<{ serverId: string; sectionId: string; beforeSectionId: string | null }>) => Promise<void>;
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

function canReorderSessionSourceSiblings(params: Readonly<{
    source: SessionListTreeDragSource;
    context: ApplySessionListTreeDropOperationContext;
}>): boolean {
    const item = params.source.metadata.item;
    if (item.type !== 'session') return false;
    return resolveSessionListSessionRowDragPolicy({
        manualSessionOrderingEnabled: params.context.manualSessionOrderingEnabled !== false,
        folderContainmentEnabled: false,
        item,
        layoutV1: params.context.sessionListLayoutV1 ?? 'projects',
    }).canReorderSiblings;
}

function classifyDropOperation(params: Readonly<{
    source: SessionListTreeDragSource;
    destination: Destination | null;
}>): SessionListTreeDropOperationKind {
    const { source, destination } = params;
    if (!destination) return 'invalid';

    if (source.metadata.kind === 'session') {
        return isSessionListSessionSiblingReorder({
            sourceFolderId: source.metadata.folderId,
            destinationFolderId: resolveSessionListDestinationFolderId(source.metadata, destination.container),
        })
            ? 'sessionSiblingReorder'
            : 'sessionContainerContainmentMove';
    }

    if (source.metadata.kind === 'folder') return destination.container.destinationKind === 'section-order' ? 'folderSiblingReorder' : 'invalid';

    if (source.metadata.kind === 'workspace-root') return 'workspaceStructuralReorder';
    return 'invalid';
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

    const destinationFolderId = resolveSessionListDestinationFolderId(source.metadata, destination.container);
    const assignmentChanged = (source.metadata.folderId ?? null) !== destinationFolderId;
    if (assignmentChanged) {
        if (!context.setSessionFolderAssignment) return false;
        await applyFolderAssignmentChange({
            serverId,
            sessionId,
            folderId: destinationFolderId,
            setSessionFolderAssignment: context.setSessionFolderAssignment,
        });
    }

    if (!params.writeGroupOrder) return true;

    const orderChanged = await applyGroupOrderUpdate({
        tree: params.tree,
        currentMap: context.sessionListGroupOrderV1,
        movedRowId: source.metadata.rowId,
        containerId: destination.container.containerId,
        beforeRowId: destination.beforeRowId,
        afterRowId: destination.afterRowId,
        setSessionListGroupOrderV1: context.setSessionListGroupOrderV1,
    });
    return assignmentChanged || orderChanged;
}

function resolveFolderSiblingTargetId(target: SessionListTreeRowMetadata | null): string | null {
    return target?.kind === 'folder' ? target.folderId : null;
}

/** Canonical definitions include filtered-out Sections; geometry is only an internal fallback. */
export function readSessionListSectionOrderIds(params: Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
    context?: Pick<ApplySessionListTreeDropOperationContext, 'sessionSections'>;
}>): string[] {
    if (params.context?.sessionSections) return params.context.sessionSections
        .filter(section => section.address.serverId === params.source.metadata.serverId)
        .map(section => section.address.sectionId);
    return [...params.tree.rowMetadataById.values()].filter(row => row.kind === 'folder'
        && row.serverId === params.source.metadata.serverId && row.containerId === params.source.metadata.containerId)
        .sort((left, right) => left.itemIndex - right.itemIndex).flatMap(row => row.folderId ? [row.folderId] : []);
}

/** Convert either edge to the existing reorder Action's single before-section operand. */
export function resolveSessionListSectionBeforeId(params: Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
    destination: SessionListTreeDropDestination;
    context?: Pick<ApplySessionListTreeDropOperationContext, 'sessionSections'>;
}>): string | null {
    const { source, destination } = params;
    if (destination.beforeRowId) return resolveFolderSiblingTargetId(destination.target);
    if (!destination.afterRowId) return null;
    const siblings = readSessionListSectionOrderIds(params).filter(sectionId => sectionId !== source.metadata.folderId);
    const targetId = resolveFolderSiblingTargetId(destination.target);
    const index = targetId ? siblings.indexOf(targetId) : -1;
    return index < 0 ? null : siblings[index + 1] ?? null;
}

async function applyFolderDrop(params: Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
    destination: Destination;
    context: ApplySessionListTreeDropOperationContext;
}>): Promise<boolean> {
    const { source, destination, context } = params;
    const folderId = source.metadata.folderId;
    const serverId = source.metadata.serverId;
    if (!folderId || !serverId) return false;

    if (destination.container.destinationKind === 'section-order') {
        if (!context.reorderSessionSection) return false;
        await context.reorderSessionSection({ serverId, sectionId: folderId,
            beforeSectionId: resolveSessionListSectionBeforeId(params) });
        return true;
    }

    return false;
}

async function applyWorkspaceDrop(params: Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
    destination: Destination;
    context: ApplySessionListTreeDropOperationContext;
}>): Promise<boolean> {
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
    if (!canMoveSessionListSourceToContainer(params.source.metadata, destination.container)) {
        return { ok: false, reason: 'scope-mismatch' };
    }

    const operationKind = classifyDropOperation({
        source: params.source,
        destination,
    });
    const requiresFolderOrganization = operationKind === 'sessionContainerContainmentMove'
        || operationKind === 'folderSiblingReorder';
    if (
        requiresFolderOrganization
        && params.context.isFolderOrganizationEnabled?.(params.source.metadata.serverId) === false
    ) {
        return { ok: false, reason: 'feature-disabled' };
    }

    if (params.source.metadata.kind === 'session') {
        const canReorderSiblings = canReorderSessionSourceSiblings({
            source: params.source,
            context: params.context,
        });
        if (operationKind === 'sessionSiblingReorder' && !canReorderSiblings) {
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
                writeGroupOrder: canReorderSiblings,
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
            ok: await applyWorkspaceDrop({
                tree: params.tree,
                source: params.source,
                destination,
                context: params.context,
            }),
        };
    }

    return { ok: false, reason: 'unsupported-source' };
}
