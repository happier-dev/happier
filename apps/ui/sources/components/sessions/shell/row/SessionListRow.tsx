import React from 'react';
import { Platform, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { GestureDetector } from 'react-native-gesture-handler';

import type { TreeDropOverlaySharedValues } from '@/components/ui/treeDragDrop';
import { SessionItem, type SessionItemProps } from '../SessionItem';
import {
    useSessionInlineDrag,
    type UseSessionInlineDragCancelEvent,
    type UseSessionInlineDragDropResultEvent,
    type UseSessionInlineDragResolveDropResultEvent,
    type UseSessionInlineDragResolvedDrop,
    type UseSessionInlineDragParams,
} from '../useSessionInlineDrag';
import type {
    RegisterSessionListTreeRowBounds,
    UnregisterSessionListTreeRowBounds,
} from '../SessionListHeaderFrame';

/**
 * A single draggable session row.
 *
 * Phase 3 of the session-list drag geometry & performance unification: this row
 * no longer renders a row-local drop indicator and no longer receives any
 * `activeDropVisual`/`activeDropTargetId` prop. The single list-level
 * `SessionListDropOverlay` owns the indicator, so a pointer move never
 * reconciles this row. The row still registers its content bounds on layout so
 * the live geometry registry can hit-test the pointer against it.
 */
export type SessionListRowProps = Readonly<
    Omit<SessionItemProps, 'reorderHandleGesture' | 'isBeingDragged'> & {
        sessionKey: string | null;
        treeRowId: string;
        groupKey: string;
        onDragStart: (sessionKey: string) => void;
        resolveDropResult: (event: UseSessionInlineDragResolveDropResultEvent) => UseSessionInlineDragResolvedDrop;
        onDropResult: UseSessionInlineDragParams['onDropResult'];
        onDragCancel: (event: UseSessionInlineDragCancelEvent) => void;
        isDragActive: boolean;
        isBeingDragged: boolean;
        dragEnabled?: boolean;
        dataIndex: number;
        /** Numeric shared values for the single list-level drop overlay. */
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
        onDragStart,
        onDropResult,
        onDragCancel,
        resolveDropResult,
        isDragActive,
        isBeingDragged,
        dragEnabled = true,
        dataIndex,
        overlayShared,
        onRegisterTreeRowBounds,
        onUnregisterTreeRowBounds,
        ...itemProps
    } = props;

    const wrapperRef = React.useRef<View>(null);

    const getCellWrapper = React.useCallback((): HTMLElement | null => {
        if (Platform.OS !== 'web') return null;
        const el = wrapperRef.current as any;
        if (!el || typeof el !== 'object' || !('parentElement' in el)) return null;
        return el.parentElement as HTMLElement | null;
    }, []);

    const handleDragStart = React.useCallback((sk: string) => {
        if (typeof itemProps.onNativeContextMenuOpenChange === 'function') {
            itemProps.onNativeContextMenuOpenChange(false);
        }
        const cellWrapper = getCellWrapper();
        if (cellWrapper) {
            cellWrapper.style.zIndex = '9999';
            cellWrapper.style.overflow = 'visible';
        }
        onDragStart(sk);
    }, [getCellWrapper, itemProps.onNativeContextMenuOpenChange, onDragStart]);

    const handleDropResult = React.useCallback((event: UseSessionInlineDragDropResultEvent) => {
        const cellWrapper = getCellWrapper();
        if (cellWrapper) {
            cellWrapper.style.zIndex = '';
            cellWrapper.style.overflow = '';
        }
        return onDropResult(event);
    }, [getCellWrapper, onDropResult]);

    const handleDragCancel = React.useCallback((event: UseSessionInlineDragCancelEvent) => {
        const cellWrapper = getCellWrapper();
        if (cellWrapper) {
            cellWrapper.style.zIndex = '';
            cellWrapper.style.overflow = '';
        }
        onDragCancel(event);
    }, [getCellWrapper, onDragCancel]);

    const isWeb = Platform.OS === 'web';
    const isIos = Platform.OS === 'ios';
    const inlineDragEnabled = isWeb || isIos;
    const rowDragEnabled = inlineDragEnabled && dragEnabled;
    const onNativeContextMenuOpenChange = itemProps.onNativeContextMenuOpenChange;
    const handleLongPressActivated = React.useCallback(() => {
        if (!isIos || typeof onNativeContextMenuOpenChange !== 'function' || isDragActive) return;
        onNativeContextMenuOpenChange(true);
    }, [isDragActive, isIos, onNativeContextMenuOpenChange]);

    const { gesture, animatedStyle } = useSessionInlineDrag({
        enabled: rowDragEnabled,
        sessionKey,
        groupKey,
        onDragStart: handleDragStart,
        onDropResult: handleDropResult,
        onDragCancel: handleDragCancel,
        resolveDropResult,
        dataIndex,
        overlayShared,
        activateAfterLongPressMs: isIos ? 350 : undefined,
        onLongPressActivated: isIos && typeof onNativeContextMenuOpenChange === 'function'
            ? () => handleLongPressActivated()
            : undefined,
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
    }, [isBeingDragged, getCellWrapper]);

    React.useEffect(() => {
        return () => {
            onUnregisterTreeRowBounds(treeRowId);
        };
    }, [onUnregisterTreeRowBounds, treeRowId]);

    const rowPointerEvents = Platform.OS === 'web' && isDragActive && !isBeingDragged
        ? 'none' as const
        : 'auto' as const;

    const sessionItem = (
        <SessionItem
            {...itemProps}
            selectionKey={sessionKey}
            reorderHandleGesture={isWeb && rowDragEnabled ? gesture : undefined}
            isBeingDragged={isBeingDragged}
        />
    );

    const handleRowLayout = React.useCallback(() => {
        onRegisterTreeRowBounds(treeRowId, wrapperRef.current);
    }, [onRegisterTreeRowBounds, treeRowId]);

    const rowNode = rowDragEnabled ? (
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

    if (isIos && rowDragEnabled && gesture) {
        return (
            <GestureDetector gesture={gesture}>
                {rowNode}
            </GestureDetector>
        );
    }

    return rowNode;
});
