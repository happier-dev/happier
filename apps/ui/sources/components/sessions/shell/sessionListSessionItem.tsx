import { Platform } from 'react-native';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { TreeDropOverlaySharedValues } from '@/components/ui/treeDragDrop';

import type { SessionListRowViewModel } from './sessionListRowViewModels';
import { SessionListRow, type SessionListRowProps } from './sessionListRow';
import type {
    UseSessionInlineDragCancelEvent,
    UseSessionInlineDragDropResultEvent,
    UseSessionInlineDragResolvedDrop,
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
    dragEnabled: boolean;
    treeRowId: string;
    onDragStart: (sessionKey: string) => void;
    resolveDropResult: (event: UseSessionInlineDragResolveDropResultEvent) => UseSessionInlineDragResolvedDrop;
    onDropResult: (event: UseSessionInlineDragDropResultEvent) => void | Promise<void>;
    onDragUpdate?: (event: UseSessionInlineDragDropResultEvent) => void;
    onDragCancel?: (event: UseSessionInlineDragCancelEvent) => void;
    onTogglePinnedSessionKey: ((sessionKey: string) => void) | null;
    onSetTagsSessionKey: ((sessionKey: string, newTags: string[]) => void) | null;
    onNativeContextMenuOpenChangeSessionKey: ((sessionKey: string, next: boolean) => void) | null;
    draggingSessionKey: string | null;
    nativeContextMenuSessionKey: string | null;
    dataIndex: number;
    overlayShared: TreeDropOverlaySharedValues;
    onRegisterTreeRowBounds: RegisterSessionListTreeRowBounds;
    onUnregisterTreeRowBounds: UnregisterSessionListTreeRowBounds;
    currentUserId: string | null;
    allKnownTags: string[];
    tagsEnabled: boolean;
    compact: boolean;
    compactMinimal: boolean;
    rowAttentionAnimationEnabled: boolean;
    folderMoveTargets: readonly SessionFolderMoveTarget[];
    onMoveToSessionFolder?: (folderId: string | null) => void | Promise<void>;
    onMoveToFolder?: () => void;
    onMoveToWorkspaceRoot?: () => void;
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    measurementTarget?: SessionListRowProps['measurementTarget'];
}>;

function applySessionListItemAttentionFlags(
    session: SessionListRenderableSession,
    item: Extract<SessionListIndexItem, { type: 'session' }>,
): SessionListRenderableSession {
    switch (item.attentionPlacementReason) {
        case 'action_required':
            if (session.hasPendingUserActionRequests === true) return session;
            return {
                ...session,
                hasPendingUserActionRequests: true,
            };
        case 'permission_required':
            if (session.hasPendingPermissionRequests === true) return session;
            return {
                ...session,
                hasPendingPermissionRequests: true,
            };
        default:
            return session;
    }
}

export function SessionListSessionItem(props: SessionListSessionItemProps) {
    const { rowViewModel } = props;
    if (!rowViewModel) {
        return null;
    }

    const rowSession = rowViewModel.session;
    if (!rowSession) {
        return null;
    }
    const session = applySessionListItemAttentionFlags(rowSession, props.item);

    const sessionKey = rowViewModel.sessionKey;
    const isIos = Platform.OS === 'ios';
    const nativeContextMenuOpen = isIos && sessionKey != null && props.nativeContextMenuSessionKey === sessionKey;

    return (
        <SessionListRow
            sessionKey={sessionKey}
            treeRowId={props.treeRowId}
            groupKey={rowViewModel.groupKey}
            reorderEnabled={props.dragEnabled}
            onDragStart={props.onDragStart}
            resolveDropResult={props.resolveDropResult}
            onDropResult={props.onDropResult}
            onDragUpdate={props.onDragUpdate}
            onDragCancel={props.onDragCancel}
            onTogglePinnedSessionKey={sessionKey ? props.onTogglePinnedSessionKey : null}
            onSetTagsSessionKey={sessionKey ? props.onSetTagsSessionKey : null}
            onNativeContextMenuOpenChangeSessionKey={isIos && sessionKey ? props.onNativeContextMenuOpenChangeSessionKey : null}
            isDragActive={props.draggingSessionKey != null}
            isBeingDragged={sessionKey != null && sessionKey === props.draggingSessionKey}
            dataIndex={props.dataIndex}
            overlayShared={props.overlayShared}
            onRegisterTreeRowBounds={props.onRegisterTreeRowBounds}
            onUnregisterTreeRowBounds={props.onUnregisterTreeRowBounds}
            measurementTarget={props.measurementTarget}
            rowViewModel={rowViewModel}
            session={session}
            selectionKey={sessionKey}
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
            rowAttentionAnimationEnabled={props.rowAttentionAnimationEnabled}
            folderMoveTargets={props.folderMoveTargets}
            onMoveToSessionFolder={props.onMoveToSessionFolder}
            onMoveToFolder={props.onMoveToFolder}
            onMoveToWorkspaceRoot={props.onMoveToWorkspaceRoot}
            onMoveUp={props.onMoveUp}
            onMoveDown={props.onMoveDown}
            {...(isIos && sessionKey != null
                ? {
                    nativeInlineDragEnabled: isIos && props.dragEnabled,
                    nativeContextMenuOpen,
                }
                : null)}
        />
    );
}
