import { Platform } from 'react-native';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { TreeDropOverlaySharedValues } from '@/components/ui/treeDragDrop';

import type { SessionListRowViewModel } from './sessionListRowViewModels';
import { SessionListRow, type SessionListRowProps } from './sessionListRow';
import type {
    UseSessionInlineDragCancelEvent,
    UseSessionInlineDragDropResultEvent,
    UseSessionInlineDragResolvedDrop,
    UseSessionInlineDragResolveDropResultEvent,
} from './useSessionInlineDrag';
import type {
    RegisterSessionListTreeRowBounds,
    UnregisterSessionListTreeRowBounds,
} from './SessionListHeaderFrame';
import type { SessionItemProps } from './SessionItem';
import { useSessionListOrganizeMode } from './organize/SessionListOrganizeMode';

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
    agentSwitchingEnabled?: boolean;
    forkActionContext?: SessionItemProps['forkActionContext'];
    onMoveToFolder?: () => void;
    onMoveToWorkspaceRoot?: () => void;
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    onDeleteDraft?: () => void | Promise<void>;
    onSetReportsCollapsed?: SessionItemProps['onSetReportsCollapsed'];
    measurementTarget?: SessionListRowProps['measurementTarget'];
}>;

export function SessionListSessionItem(props: SessionListSessionItemProps) {
    const { rowViewModel } = props;
    const organize = useSessionListOrganizeMode();
    if (!rowViewModel) {
        return null;
    }

    const rowSession = rowViewModel.session;
    if (!rowSession) {
        return null;
    }
    const session = rowSession;

    const sessionKey = rowViewModel.sessionKey;
    const isIos = Platform.OS === 'ios';
    const nativeContextMenuOpen = isIos && sessionKey != null && props.nativeContextMenuSessionKey === sessionKey;

    return (
        <SessionListRow
            sessionKey={sessionKey}
            treeRowId={props.treeRowId}
            groupKey={rowViewModel.groupKey}
            reorderEnabled={props.dragEnabled}
            organizeMode={organize.active}
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
            agentSwitchingEnabled={props.agentSwitchingEnabled}
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
            reportsDepth={props.item.reportsDepth}
            reportsDisclosure={props.item.reportsParent ? (props.item.reportsCollapsed ? 'collapsed' : 'expanded') : undefined}
            onSetReportsCollapsed={props.item.reportsParent ? props.onSetReportsCollapsed : undefined}
            secondaryLineMode={rowViewModel.secondaryLineMode}
            compact={props.compact}
            compactMinimal={props.compactMinimal}
            rowAttentionAnimationEnabled={props.rowAttentionAnimationEnabled}
            forkActionContext={props.forkActionContext}
            onMoveToFolder={props.onMoveToFolder}
            onMoveToWorkspaceRoot={props.onMoveToWorkspaceRoot}
            onMoveUp={props.onMoveUp}
            onMoveDown={props.onMoveDown}
            onDeleteDraft={props.onDeleteDraft}
            {...(isIos && sessionKey != null ? { nativeContextMenuOpen } : null)}
        />
    );
}
