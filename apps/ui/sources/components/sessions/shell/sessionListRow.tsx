import React from 'react';
import { View, Platform } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';

import { SessionItem, type SessionItemProps } from './SessionItem';
import {
    useSessionInlineDrag,
    type UseSessionInlineDragCancelEvent,
    type UseSessionInlineDragDropResultEvent,
    type UseSessionInlineDragResolvedDrop,
    type UseSessionInlineDragResolveDropResultEvent,
} from './useSessionInlineDrag';
import type { TreeDropOverlaySharedValues } from '@/components/ui/treeDragDrop';
import type {
    RegisterSessionListTreeRowBounds,
    UnregisterSessionListTreeRowBounds,
} from './SessionListHeaderFrame';

export type SessionListRowProps = Readonly<
    Omit<SessionItemProps, 'onTogglePinned' | 'onSetTags' | 'onNativeContextMenuOpenChange'> & {
        sessionKey: string | null;
        treeRowId: string;
        groupKey: string;
        reorderEnabled: boolean;
        onDragStart: (sessionKey: string) => void;
        resolveDropResult: (event: UseSessionInlineDragResolveDropResultEvent) => UseSessionInlineDragResolvedDrop;
        onDropResult: (event: UseSessionInlineDragDropResultEvent) => void | Promise<void>;
        onDragUpdate?: (event: UseSessionInlineDragDropResultEvent) => void;
        onDragCancel?: (event: UseSessionInlineDragCancelEvent) => void;
        onTogglePinnedSessionKey: ((sessionKey: string) => void) | null;
        onSetTagsSessionKey: ((sessionKey: string, newTags: string[]) => void) | null;
        onNativeContextMenuOpenChangeSessionKey: ((sessionKey: string, next: boolean) => void) | null;
        isDragActive: boolean;
        isBeingDragged: boolean;
        dataIndex: number;
        overlayShared: TreeDropOverlaySharedValues;
        onRegisterTreeRowBounds: RegisterSessionListTreeRowBounds;
        onUnregisterTreeRowBounds: UnregisterSessionListTreeRowBounds;
    }
>;

export const SessionListRow = React.memo(function SessionListRow(props: SessionListRowProps) {
    const {
        sessionKey,
        treeRowId,
        groupKey,
        reorderEnabled,
        onDragStart,
        onDropResult,
        onDragUpdate,
        onDragCancel,
        resolveDropResult,
        onTogglePinnedSessionKey,
        onSetTagsSessionKey,
        onNativeContextMenuOpenChangeSessionKey,
        isDragActive,
        isBeingDragged,
        dataIndex,
        overlayShared,
        onRegisterTreeRowBounds,
        onUnregisterTreeRowBounds,
        ...itemProps
    } = props;

    const wrapperRef = React.useRef<View>(null);

    const getCellWrapper = React.useCallback((): HTMLElement | null => {
        if (Platform.OS !== 'web') return null;
        const element = wrapperRef.current as any;
        if (!element || typeof element !== 'object' || !('parentElement' in element)) return null;
        return element.parentElement as HTMLElement | null;
    }, []);

    const handleNativeContextMenuOpenChange = React.useCallback((next: boolean) => {
        if (!sessionKey || !onNativeContextMenuOpenChangeSessionKey) return;
        onNativeContextMenuOpenChangeSessionKey(sessionKey, next);
    }, [onNativeContextMenuOpenChangeSessionKey, sessionKey]);

    const handleTogglePinned = React.useCallback(() => {
        if (!sessionKey || !onTogglePinnedSessionKey) return;
        onTogglePinnedSessionKey(sessionKey);
    }, [onTogglePinnedSessionKey, sessionKey]);

    const handleSetTags = React.useCallback((newTags: string[]) => {
        if (!sessionKey || !onSetTagsSessionKey) return;
        onSetTagsSessionKey(sessionKey, newTags);
    }, [onSetTagsSessionKey, sessionKey]);

    const handleInlineDragStart = React.useCallback((nextSessionKey: string) => {
        handleNativeContextMenuOpenChange(false);
        const cellWrapper = getCellWrapper();
        if (cellWrapper) {
            cellWrapper.style.zIndex = '9999';
            cellWrapper.style.overflow = 'visible';
        }
        onDragStart(nextSessionKey);
    }, [getCellWrapper, handleNativeContextMenuOpenChange, onDragStart]);

    const handleInlineDropResult = React.useCallback((event: UseSessionInlineDragDropResultEvent) => {
        const cellWrapper = getCellWrapper();
        if (cellWrapper) {
            cellWrapper.style.zIndex = '';
            cellWrapper.style.overflow = '';
        }
        void onDropResult(event);
    }, [getCellWrapper, onDropResult]);

    const isWeb = Platform.OS === 'web';
    const isIos = Platform.OS === 'ios';
    const inlineDragEnabled = reorderEnabled && (isWeb || isIos);
    const handleInlineLongPressActivated = React.useCallback(() => {
        if (isWeb || isDragActive) return;
        handleNativeContextMenuOpenChange(true);
    }, [handleNativeContextMenuOpenChange, isDragActive, isWeb]);

    const { gesture, animatedStyle } = useSessionInlineDrag({
        enabled: inlineDragEnabled,
        sessionKey,
        groupKey,
        onDragStart: handleInlineDragStart,
        onDropResult: handleInlineDropResult,
        onDragUpdate,
        onDragCancel,
        resolveDropResult,
        onLongPressActivated: isIos ? handleInlineLongPressActivated : undefined,
        dataIndex,
        overlayShared,
        activateAfterLongPressMs: isWeb ? undefined : 350,
    });

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const cellWrapper = getCellWrapper();
        if (!cellWrapper) return;
        if (isBeingDragged) {
            cellWrapper.style.zIndex = '9999';
            cellWrapper.style.overflow = 'visible';
        } else {
            cellWrapper.style.zIndex = '';
            cellWrapper.style.overflow = '';
        }
    }, [getCellWrapper, isBeingDragged]);

    const rowPointerEvents = Platform.OS === 'web' && isDragActive && !isBeingDragged
        ? 'none' as const
        : 'auto' as const;

    React.useEffect(() => {
        return () => {
            onUnregisterTreeRowBounds(treeRowId);
        };
    }, [onUnregisterTreeRowBounds, treeRowId]);

    const reorderGesture = inlineDragEnabled ? gesture : undefined;

    const sessionItem = (
        <SessionItem
            {...itemProps}
            onTogglePinned={onTogglePinnedSessionKey ? handleTogglePinned : null}
            onSetTags={onSetTagsSessionKey && sessionKey ? handleSetTags : null}
            onNativeContextMenuOpenChange={onNativeContextMenuOpenChangeSessionKey && sessionKey ? handleNativeContextMenuOpenChange : undefined}
            reorderHandleGesture={isWeb ? reorderGesture : undefined}
            isBeingDragged={isBeingDragged}
        />
    );

    const handleRowLayout = React.useCallback(() => {
        onRegisterTreeRowBounds(treeRowId, wrapperRef.current);
    }, [onRegisterTreeRowBounds, treeRowId]);

    const rowNode = inlineDragEnabled ? (
        <Animated.View
            ref={wrapperRef}
            collapsable={false}
            style={animatedStyle}
            pointerEvents={rowPointerEvents}
            onLayout={handleRowLayout}
        >
            {sessionItem}
        </Animated.View>
    ) : (
        <View
            ref={wrapperRef}
            collapsable={false}
            pointerEvents={rowPointerEvents}
            onLayout={handleRowLayout}
        >
            {sessionItem}
        </View>
    );

    if (isIos && reorderGesture) {
        return (
            <GestureDetector gesture={reorderGesture}>
                {rowNode}
            </GestureDetector>
        );
    }

    return rowNode;
});
