import type {
    TreeContainerDropZone,
    TreeDragSource,
    TreeDropResult,
    TreeRow,
    WindowBounds,
} from '@/components/ui/treeDragDrop';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionFolderWorkspaceRefV1 } from '@/sync/domains/session/folders';

export type SessionListTreeRowKind = 'workspace-root' | 'folder' | 'session';

export type SessionListInstructionBlockReason =
    | 'feature-disabled'
    | 'scope-unavailable'
    | 'unsupported-item';

export type SessionListTreeDropResult = TreeDropResult & Readonly<{
    sessionListBlockReason?: SessionListInstructionBlockReason;
}>;

export type SessionListTreeRowMetadata = Readonly<{
    rowId: string;
    item: SessionListIndexItem;
    itemIndex: number;
    kind: SessionListTreeRowKind;
    rootId: string;
    containerId: string;
    containerGroupKey: string;
    parentRowId: string | null;
    orderKey: string | null;
    serverId: string | null;
    sessionId: string | null;
    folderId: string | null;
    folderDepth: number;
    workspace: SessionFolderWorkspaceRefV1 | null;
    childContainerId: string | null;
    childGroupKey: string | null;
    storageKind: 'persisted' | 'direct' | null;
}>;

export type SessionListTreeContainerMetadata = Readonly<{
    containerId: string;
    kind: 'workspace-order' | 'children';
    rootId: string;
    groupKey: string;
    parentRowId: string | null;
    folderId: string | null;
    depth: number;
    workspace: SessionFolderWorkspaceRefV1 | null;
}>;

export type SessionListTreeModel = Readonly<{
    items: ReadonlyArray<SessionListIndexItem>;
    rows: ReadonlyArray<TreeRow>;
    dropZones: ReadonlyArray<TreeContainerDropZone>;
    rowMetadataById: ReadonlyMap<string, SessionListTreeRowMetadata>;
    containerMetadataById: ReadonlyMap<string, SessionListTreeContainerMetadata>;
}>;

export type SessionListTreeDragSource = TreeDragSource & Readonly<{
    metadata: SessionListTreeRowMetadata;
}>;

export type SessionListTreeDropZoneBounds = Readonly<{
    containerId: string;
    role: TreeContainerDropZone['role'];
    bounds: WindowBounds;
}>;
