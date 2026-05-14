import React from 'react';
import { View, Platform } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import { SessionItem } from './SessionItem';
import { sessionListStyles } from './sessionListStyles';
import { useSessionInlineDrag, type SessionInlineDragEndContext } from './useSessionInlineDrag';

export type SessionListRowProps = Readonly<
    Omit<React.ComponentProps<typeof SessionItem>, 'onTogglePinned' | 'onSetTags' | 'onNativeContextMenuOpenChange'> & {
        sessionKey: string | null;
        groupKey: string;
        rowHeight: number;
        reorderEnabled: boolean;
        onDragStart: (sessionKey: string) => void;
        onDragEnd: (
            sessionKey: string,
            groupKey: string,
            positionDelta: number,
            context?: SessionInlineDragEndContext,
        ) => void | Promise<void>;
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
        isDragActive: boolean;
        isBeingDragged: boolean;
        dataIndex: number;
        totalItemCount: number;
        dropIndicatorIdx: SharedValue<number>;
        dropIndicatorEdge: SharedValue<number>;
    }
>;

export const SessionListRow = React.memo(function SessionListRow(props: SessionListRowProps) {
    const {
        sessionKey,
        groupKey,
        rowHeight,
        reorderEnabled,
        onDragStart,
        onDragEnd,
        onDragUpdate,
        onTogglePinnedSessionKey,
        onSetTagsSessionKey,
        onNativeContextMenuOpenChangeSessionKey,
        isDragActive,
        isBeingDragged,
        dataIndex,
        totalItemCount,
        dropIndicatorIdx,
        dropIndicatorEdge,
        ...itemProps
    } = props;

    const styles = sessionListStyles;
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

    const handleInlineDragEnd = React.useCallback((nextSessionKey: string, nextGroupKey: string, delta: number, context?: SessionInlineDragEndContext) => {
        const cellWrapper = getCellWrapper();
        if (cellWrapper) {
            cellWrapper.style.zIndex = '';
            cellWrapper.style.overflow = '';
        }
        void onDragEnd(nextSessionKey, nextGroupKey, delta, context);
    }, [getCellWrapper, onDragEnd]);

    const isWeb = Platform.OS === 'web';
    const isIos = Platform.OS === 'ios';
    const rowReorderEnabled = reorderEnabled && Platform.OS !== 'android';
    const { gesture, animatedStyle } = useSessionInlineDrag({
        enabled: rowReorderEnabled,
        sessionKey,
        groupKey,
        rowHeight,
        onDragStart: handleInlineDragStart,
        onDragEnd: handleInlineDragEnd,
        onDragUpdate,
        dataIndex,
        totalItemCount,
        dropIndicatorIdx,
        dropIndicatorEdge,
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

    const indicatorAnimatedStyle = useAnimatedStyle(() => {
        const isTarget = dropIndicatorIdx.value === dataIndex;
        const atBottom = dropIndicatorEdge.value === 1;
        return {
            opacity: isTarget ? 1 : 0,
            top: atBottom ? undefined : 0,
            bottom: atBottom ? 0 : undefined,
        };
    });
    const reorderGesture = rowReorderEnabled ? gesture : undefined;

    const sessionItem = (
        <SessionItem
            {...itemProps}
            onTogglePinned={onTogglePinnedSessionKey ? handleTogglePinned : null}
            onSetTags={onSetTagsSessionKey && sessionKey ? handleSetTags : null}
            onNativeContextMenuOpenChange={onNativeContextMenuOpenChangeSessionKey && sessionKey ? handleNativeContextMenuOpenChange : undefined}
            reorderHandleGesture={isIos ? undefined : reorderGesture}
            isBeingDragged={isBeingDragged}
        />
    );

    return (
        <Animated.View ref={wrapperRef} style={animatedStyle} pointerEvents={rowPointerEvents}>
            <Animated.View style={[styles.dropIndicator, indicatorAnimatedStyle]} pointerEvents="none" />
            {isIos && reorderGesture ? (
                <GestureDetector gesture={reorderGesture}>
                    {sessionItem}
                </GestureDetector>
            ) : sessionItem}
        </Animated.View>
    );
});
