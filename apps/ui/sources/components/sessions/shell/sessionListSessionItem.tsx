import { Platform } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { useSessionListRenderableWithServerScope } from '@/sync/domains/state/storage';

import type { SessionListRowViewModel } from './sessionListRowViewModels';
import { SessionListRow } from './sessionListRow';
import type { SessionInlineDragEndContext } from './useSessionInlineDrag';
import type { SessionFolderMoveTarget } from '@/sync/domains/session/folders';

type SessionListSessionItemProps = Readonly<{
    item: Extract<SessionListIndexItem, { type: 'session' }>;
    rowViewModel: SessionListRowViewModel | null | undefined;
    rowHeight: number;
    canReorderSessions: boolean;
    onDragStart: (sessionKey: string) => void;
    onDragEnd: (sessionKey: string, groupKey: string, positionDelta: number, context?: SessionInlineDragEndContext) => void | Promise<void>;
    onDragUpdate?: (event: Readonly<{
        sessionKey: string;
        groupKey: string;
        positionDelta: number;
        dataIndex: number;
        absoluteX: number;
        absoluteY: number;
    }>) => void;
    onTogglePinnedSessionKey: ((sessionKey: string) => void) | null;
    onSetTagsSessionKey: ((sessionKey: string, newTags: string[]) => void) | null;
    onNativeContextMenuOpenChangeSessionKey: ((sessionKey: string, next: boolean) => void) | null;
    draggingSessionKey: string | null;
    nativeContextMenuSessionKey: string | null;
    totalItemCount: number;
    dataIndex: number;
    dropIndicatorIdx: SharedValue<number>;
    dropIndicatorEdge: SharedValue<number>;
    currentUserId: string | null;
    allKnownTags: string[];
    tagsEnabled: boolean;
    compact: boolean;
    compactMinimal: boolean;
    folderMoveTargets: readonly SessionFolderMoveTarget[];
    onMoveToSessionFolder: ((sessionId: string, serverId: string, folderId: string | null) => void | Promise<void>) | null;
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
    const isNative = isIos || Platform.OS === 'android';
    const nativeContextMenuOpen = isNative && sessionKey != null && props.nativeContextMenuSessionKey === sessionKey;

    return (
        <SessionListRow
            sessionKey={sessionKey}
            groupKey={rowViewModel.groupKey}
            rowHeight={props.rowHeight}
            reorderEnabled={props.canReorderSessions}
            onDragStart={props.onDragStart}
            onDragEnd={props.onDragEnd}
            onDragUpdate={props.onDragUpdate}
            onTogglePinnedSessionKey={sessionKey ? props.onTogglePinnedSessionKey : null}
            onSetTagsSessionKey={sessionKey ? props.onSetTagsSessionKey : null}
            onNativeContextMenuOpenChangeSessionKey={isNative && sessionKey ? props.onNativeContextMenuOpenChangeSessionKey : null}
            isDragActive={props.draggingSessionKey != null}
            isBeingDragged={sessionKey != null && sessionKey === props.draggingSessionKey}
            dataIndex={props.dataIndex}
            totalItemCount={props.totalItemCount}
            dropIndicatorIdx={props.dropIndicatorIdx}
            dropIndicatorEdge={props.dropIndicatorEdge}
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
            {...(isNative && sessionKey != null
                ? {
                    nativeInlineDragEnabled: isIos && props.canReorderSessions,
                    nativeContextMenuOpen,
                }
                : null)}
        />
    );
}
