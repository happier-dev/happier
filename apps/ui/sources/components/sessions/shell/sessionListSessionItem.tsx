import * as React from 'react';
import { Platform } from 'react-native';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { buildSessionListIndexNodeId } from '@/sync/domains/sessionList/sessionListIndexIdentity';
import type { TreeDropOverlaySharedValues } from '@/components/ui/treeDragDrop';

import type { SessionListRowViewModel } from './sessionListRowViewModels';
import { SessionListRow, type SessionListRowProps } from './sessionListRow';
import type {
    UseSessionInlineDragStart,
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
import { SessionListAttentionInteractionContext } from './useSessionListAttentionInteraction';

type SessionListSessionItemProps = Readonly<{
    item: Extract<SessionListIndexItem, { type: 'session' }>;
    rowViewModel: SessionListRowViewModel | null | undefined;
    rowHeight: number;
    dragEnabled: boolean;
    treeRowId: string;
    onDragStart: UseSessionInlineDragStart;
    resolveDropResult: (event: UseSessionInlineDragResolveDropResultEvent) => UseSessionInlineDragResolvedDrop;
    onDropResult: (event: UseSessionInlineDragDropResultEvent) => void | Promise<void>;
    onDragUpdate?: (event: UseSessionInlineDragDropResultEvent) => void;
    onDragCancel?: (event: UseSessionInlineDragCancelEvent) => void;
    onTogglePinnedSessionKey: ((sessionKey: string) => void) | null;
    onSetTagsSessionKey: ((sessionKey: string, newTags: string[]) => void) | null;
    onNativeContextMenuOpenChangeSessionKey: ((sessionKey: string, next: boolean) => void) | null;
    draggingSessionKey: string | null;
    draggingTreeRowId?: string | null;
    nativeContextMenuSessionKey: string | null;
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
    sectionMove?: SessionItemProps['sectionMove'];
    spaceMembership?: SessionItemProps['spaceMembership'];
    onMoveToWorkspaceRoot?: () => void;
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    onDeleteDraft?: () => void | Promise<void>;
    draftPreview?: SessionItemProps['draftPreview'];
    onSetReportsCollapsed?: SessionItemProps['onSetReportsCollapsed'];
    measurementTarget?: SessionListRowProps['measurementTarget'];
}>;

export function SessionListSessionItem(props: SessionListSessionItemProps) {
    const { rowViewModel } = props;
    const organize = useSessionListOrganizeMode();
    const attentionInteraction = React.useContext(SessionListAttentionInteractionContext);
    if (!rowViewModel) {
        return null;
    }

    const rowSession = rowViewModel.session;
    if (!rowSession) {
        return null;
    }
    const session = rowSession;

    const sessionKey = rowViewModel.sessionKey;
    const isNativeMobile = Platform.OS === 'ios' || Platform.OS === 'android';
    const nativeContextMenuOpen = isNativeMobile && sessionKey != null && props.nativeContextMenuSessionKey === props.treeRowId;

    return (
        <SessionListRow
            onOpened={attentionInteraction?.releaseKeyboard}
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
            onNativeContextMenuOpenChangeSessionKey={isNativeMobile && sessionKey ? props.onNativeContextMenuOpenChangeSessionKey : null}
            isDragActive={props.draggingSessionKey != null}
            isBeingDragged={props.draggingTreeRowId != null
                ? props.treeRowId === props.draggingTreeRowId
                : sessionKey != null && sessionKey === props.draggingSessionKey}
            overlayShared={props.overlayShared}
            onRegisterTreeRowBounds={props.onRegisterTreeRowBounds}
            onUnregisterTreeRowBounds={props.onUnregisterTreeRowBounds}
            measurementTarget={props.measurementTarget}
            rowViewModel={rowViewModel}
            agentSwitchingEnabled={props.agentSwitchingEnabled}
            session={session}
            selectionKey={sessionKey}
            occurrenceId={buildSessionListIndexNodeId(props.item)}
            inAttentionShelf={props.item.occurrenceRole === 'needsYou'}
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
            variant={props.item.variant}
            reportsDepth={props.item.reportsDepth}
            reportsDisclosure={props.item.reportsParent ? (props.item.reportsCollapsed ? 'collapsed' : 'expanded') : undefined}
            onSetReportsCollapsed={props.item.reportsParent ? props.onSetReportsCollapsed : undefined}
            secondaryLineMode={rowViewModel.secondaryLineMode}
            compact={props.compact}
            compactMinimal={props.compactMinimal}
            rowAttentionAnimationEnabled={props.rowAttentionAnimationEnabled}
            forkActionContext={props.forkActionContext}
            onMoveToFolder={props.onMoveToFolder}
            sectionMove={props.sectionMove}
            spaceMembership={props.spaceMembership}
            onMoveToWorkspaceRoot={props.onMoveToWorkspaceRoot}
            onMoveUp={props.onMoveUp}
            onMoveDown={props.onMoveDown}
            onDeleteDraft={props.onDeleteDraft}
            draftPreview={props.draftPreview}
            {...(isNativeMobile && sessionKey != null ? { nativeContextMenuOpen } : null)}
        />
    );
}
