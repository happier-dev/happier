import * as React from 'react';
import { Platform } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';

import type { SessionListViewItem } from '@/sync/domains/state/storage';

import type { SessionListRowViewModel } from './sessionListRowViewModels';
import { SessionListRow } from './sessionListRow';

type SessionListSessionItemProps = Readonly<{
    item: Extract<SessionListViewItem, { type: 'session' }>;
    rowViewModel: SessionListRowViewModel | null | undefined;
    rowHeight: number;
    canReorderSessions: boolean;
    onDragStart: (sessionKey: string) => void;
    onDragEnd: (sessionKey: string, groupKey: string, positionDelta: number) => void;
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
}>;

export const SessionListSessionItem = React.memo((props: SessionListSessionItemProps) => {
    const { rowViewModel } = props;
    if (!rowViewModel) {
        return null;
    }

    const sessionKey = rowViewModel.sessionKey;
    const isNative = Platform.OS === 'ios' || Platform.OS === 'android';
    const nativeContextMenuOpen = isNative && sessionKey != null && props.nativeContextMenuSessionKey === sessionKey;

    return (
        <SessionListRow
            sessionKey={sessionKey}
            groupKey={rowViewModel.groupKey}
            rowHeight={props.rowHeight}
            reorderEnabled={props.canReorderSessions}
            onDragStart={props.onDragStart}
            onDragEnd={props.onDragEnd}
            onTogglePinnedSessionKey={sessionKey ? props.onTogglePinnedSessionKey : null}
            onSetTagsSessionKey={sessionKey ? props.onSetTagsSessionKey : null}
            onNativeContextMenuOpenChangeSessionKey={isNative && sessionKey ? props.onNativeContextMenuOpenChangeSessionKey : null}
            isDragActive={props.draggingSessionKey != null}
            isBeingDragged={sessionKey != null && sessionKey === props.draggingSessionKey}
            dataIndex={props.dataIndex}
            totalItemCount={props.totalItemCount}
            dropIndicatorIdx={props.dropIndicatorIdx}
            dropIndicatorEdge={props.dropIndicatorEdge}
            session={props.item.session}
            subtitleOverride={rowViewModel.subtitleOverride}
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
            secondaryLineMode={rowViewModel.secondaryLineMode}
            compact={props.compact}
            compactMinimal={props.compactMinimal}
            {...(isNative && sessionKey != null
                ? {
                    nativeInlineDragEnabled: props.canReorderSessions,
                    nativeContextMenuOpen,
                }
                : null)}
        />
    );
});
