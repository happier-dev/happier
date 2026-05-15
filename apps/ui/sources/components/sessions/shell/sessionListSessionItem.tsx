import { Platform } from 'react-native';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { useSessionListRenderableWithServerScope } from '@/sync/domains/state/storage';
import type { TreeDropResult, TreeInstructionVisual } from '@/components/ui/treeDragDrop';

import type { SessionListRowViewModel } from './sessionListRowViewModels';
import { SessionListRow } from './sessionListRow';
import type {
    SessionInlineDragVisualSharedValues,
    UseSessionInlineDragDropResultEvent,
    UseSessionInlineDragResolveDropResultEvent,
} from './useSessionInlineDrag';
import type { SessionFolderMoveTarget } from '@/sync/domains/session/folders';
import type {
    RegisterSessionListTreeRowBounds,
    UnregisterSessionListTreeRowBounds,
} from './SessionListHeaderFrame';

type SessionListSessionItemProps = Readonly<{
    item: Extract<SessionListIndexItem, { type: 'session' }>;
    rowViewModel: SessionListRowViewModel | null | undefined;
    rowHeight: number;
    canReorderSessions: boolean;
    treeRowId: string;
    onDragStart: (sessionKey: string) => void;
    resolveDropResult: (event: UseSessionInlineDragResolveDropResultEvent) => TreeDropResult;
    onDropResult: (event: UseSessionInlineDragDropResultEvent) => void | Promise<void>;
    onDragUpdate?: (event: UseSessionInlineDragDropResultEvent) => void;
    onTogglePinnedSessionKey: ((sessionKey: string) => void) | null;
    onSetTagsSessionKey: ((sessionKey: string, newTags: string[]) => void) | null;
    onNativeContextMenuOpenChangeSessionKey: ((sessionKey: string, next: boolean) => void) | null;
    draggingSessionKey: string | null;
    nativeContextMenuSessionKey: string | null;
    dataIndex: number;
    dropVisual: SessionInlineDragVisualSharedValues;
    activeDropVisual: TreeInstructionVisual;
    onRegisterTreeRowBounds: RegisterSessionListTreeRowBounds;
    onUnregisterTreeRowBounds: UnregisterSessionListTreeRowBounds;
    currentUserId: string | null;
    allKnownTags: string[];
    tagsEnabled: boolean;
    compact: boolean;
    compactMinimal: boolean;
    folderMoveTargets: readonly SessionFolderMoveTarget[];
    onMoveToSessionFolder: ((sessionId: string, serverId: string, folderId: string | null) => void | Promise<void>) | null;
    onMoveToFolder?: () => void;
    onMoveToWorkspaceRoot?: () => void;
    onMoveUp?: () => void;
    onMoveDown?: () => void;
}>;

export function SessionListSessionItem(props: SessionListSessionItemProps) {
    const { rowViewModel } = props;
    if (!rowViewModel) {
        return null;
    }

    const session = useSessionListRenderableWithServerScope(props.item.serverId ?? null, props.item.sessionId);
    if (!session) {
        return null;
    }

    const sessionKey = rowViewModel.sessionKey;
    const isIos = Platform.OS === 'ios';
    const nativeContextMenuOpen = isIos && sessionKey != null && props.nativeContextMenuSessionKey === sessionKey;

    return (
        <SessionListRow
            sessionKey={sessionKey}
            treeRowId={props.treeRowId}
            groupKey={rowViewModel.groupKey}
            reorderEnabled={props.canReorderSessions}
            onDragStart={props.onDragStart}
            resolveDropResult={props.resolveDropResult}
            onDropResult={props.onDropResult}
            onDragUpdate={props.onDragUpdate}
            onTogglePinnedSessionKey={sessionKey ? props.onTogglePinnedSessionKey : null}
            onSetTagsSessionKey={sessionKey ? props.onSetTagsSessionKey : null}
            onNativeContextMenuOpenChangeSessionKey={isIos && sessionKey ? props.onNativeContextMenuOpenChangeSessionKey : null}
            isDragActive={props.draggingSessionKey != null}
            isBeingDragged={sessionKey != null && sessionKey === props.draggingSessionKey}
            dataIndex={props.dataIndex}
            dropVisual={props.dropVisual}
            activeDropVisual={props.activeDropVisual}
            onRegisterTreeRowBounds={props.onRegisterTreeRowBounds}
            onUnregisterTreeRowBounds={props.onUnregisterTreeRowBounds}
            session={session}
            subtitleOverride={rowViewModel.subtitleOverride}
            subtitleEllipsizeMode={rowViewModel.subtitleEllipsizeMode}
            serverId={props.item.serverId}
            serverName={props.item.serverName}
            currentUserId={props.currentUserId}
            showServerBadge={rowViewModel.showServerBadge}
            pinned={rowViewModel.pinned}
            tags={rowViewModel.tags}
            allKnownTags={props.allKnownTags}
            tagsEnabled={props.tagsEnabled}
            selected={rowViewModel.selected}
            isFirst={rowViewModel.isFirst}
            isLast={rowViewModel.isLast}
            isSingle={rowViewModel.isSingle}
            variant={props.item.variant}
            folderDepth={props.item.folderDepth}
            secondaryLineMode={rowViewModel.secondaryLineMode}
            compact={props.compact}
            compactMinimal={props.compactMinimal}
            folderMoveTargets={props.folderMoveTargets}
            onMoveToSessionFolder={props.onMoveToSessionFolder && props.item.serverId
                ? (folderId) => props.onMoveToSessionFolder?.(props.item.sessionId, props.item.serverId!, folderId)
                : undefined}
            onMoveToFolder={props.onMoveToFolder}
            onMoveToWorkspaceRoot={props.onMoveToWorkspaceRoot}
            onMoveUp={props.onMoveUp}
            onMoveDown={props.onMoveDown}
            {...(isIos && sessionKey != null
                ? {
                    nativeInlineDragEnabled: isIos && props.canReorderSessions,
                    nativeContextMenuOpen,
                }
                : null)}
        />
    );
}
