import type { TreeInstruction } from '@/components/ui/treeDragDrop';
import type { SessionFoldersV1 } from '@/sync/domains/session/folders';

import { applyFolderAssignmentChange } from './applyFolderAssignmentChange';
import { applyFolderTreeMove } from './applyFolderTreeMove';
import { applyGroupOrderUpdate } from './applyGroupOrderUpdate';
import type {
    SessionListTreeContainerMetadata,
    SessionListTreeDragSource,
    SessionListTreeDropResult,
    SessionListTreeModel,
    SessionListTreeRowMetadata,
} from '../drop-resolution/sessionListTreeTypes';

type SessionListGroupOrderV1 = Readonly<Record<string, ReadonlyArray<string> | undefined>>;

type SetSessionFolderAssignment = (assignment: Readonly<{
    serverId: string;
    sessionId: string;
    folderId: string | null;
}>) => Promise<void>;

export type ApplySessionListTreeDropOperationContext = Readonly<{
    sessionFoldersV1: SessionFoldersV1;
    sessionListGroupOrderV1: SessionListGroupOrderV1;
    now: () => number;
    setSessionFoldersV1: (next: SessionFoldersV1) => void;
    setSessionListGroupOrderV1: (next: Record<string, string[]>) => void;
    setSessionFolderAssignment: SetSessionFolderAssignment;
}>;

export type ApplySessionListTreeDropOperationResult = Readonly<{
    ok: boolean;
    reason?: string;
}>;

type Destination = Readonly<{
    container: SessionListTreeContainerMetadata;
    beforeRowId: string | null;
    afterRowId: string | null;
    target: SessionListTreeRowMetadata | null;
}>;

function resolveDestination(params: Readonly<{
    tree: SessionListTreeModel;
    instruction: TreeInstruction;
}>): Destination | null {
    const { instruction, tree } = params;
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

async function applySessionDrop(params: Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
    destination: Destination;
    context: ApplySessionListTreeDropOperationContext;
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

    return applyGroupOrderUpdate({
        tree: params.tree,
        currentMap: context.sessionListGroupOrderV1,
        movedRowId: source.metadata.rowId,
        containerId: destination.container.containerId,
        beforeRowId: destination.beforeRowId,
        afterRowId: destination.afterRowId,
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
        setSessionListGroupOrderV1: context.setSessionListGroupOrderV1,
    });

    return shouldMoveFolderTree || orderUpdated;
}

export async function applySessionListTreeDropOperation(params: Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
    result: SessionListTreeDropResult;
    context: ApplySessionListTreeDropOperationContext;
}>): Promise<ApplySessionListTreeDropOperationResult> {
    const destination = resolveDestination({
        tree: params.tree,
        instruction: params.result.instruction,
    });
    if (!destination) {
        return {
            ok: false,
            reason: params.result.instruction.kind,
        };
    }

    if (params.source.metadata.kind === 'session') {
        return {
            ok: await applySessionDrop({
                tree: params.tree,
                source: params.source,
                destination,
                context: params.context,
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

    return { ok: false, reason: 'unsupported-source' };
}
