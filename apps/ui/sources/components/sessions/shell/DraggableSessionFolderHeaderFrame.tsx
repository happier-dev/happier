import React from 'react';
import { Platform, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { GestureDetector } from 'react-native-gesture-handler';

import { type UseSessionInlineDragResult } from './useSessionInlineDrag';

import type { TreeDropOverlaySharedValues } from '@/components/ui/treeDragDrop';
import {
    useSessionInlineDrag,
    type UseSessionInlineDragCancelEvent,
    type UseSessionInlineDragParams,
    type UseSessionInlineDragResolveDropResultEvent,
    type UseSessionInlineDragResolvedDrop,
} from './useSessionInlineDrag';
import {
    type RegisterSessionListTreeRowBounds,
    type UnregisterSessionListTreeRowBounds,
} from './SessionListHeaderFrame';

/**
 * Draggable wrapper for a project/folder header row.
 *
 * Phase 3 of the session-list drag geometry & performance unification: the
 * header no longer renders a row-local drop indicator and no longer receives an
 * `activeDropVisual`. The single list-level `SessionListDropOverlay` owns the
 * line/outline. The header still registers its content bounds on layout for
 * the live geometry registry.
 */
export const DraggableSessionFolderHeaderFrame = React.memo(function DraggableSessionFolderHeaderFrame(props: Readonly<{
    children: (dragHandleGesture: UseSessionInlineDragResult['gesture']) => React.ReactNode;
    folderId?: string;
    dragKey?: string;
    groupKey: string;
    treeRowId: string;
    dataIndex: number;
    /** Numeric shared values for the single list-level drop overlay. */
    overlayShared: TreeDropOverlaySharedValues;
    onDragStart: (sessionKey: string) => void;
    resolveDropResult: (event: UseSessionInlineDragResolveDropResultEvent) => UseSessionInlineDragResolvedDrop;
    onDropResult: UseSessionInlineDragParams['onDropResult'];
    onDragCancel: (event: UseSessionInlineDragCancelEvent) => void;
    onRegisterTreeRowBounds: RegisterSessionListTreeRowBounds;
    onUnregisterTreeRowBounds: UnregisterSessionListTreeRowBounds;
}>) {
    const dragKey = props.dragKey ?? `folder:${props.folderId ?? ''}`;
    const wrapperRef = React.useRef<View>(null);
    React.useEffect(() => {
        return () => {
            props.onUnregisterTreeRowBounds(props.treeRowId);
        };
    }, [props.onUnregisterTreeRowBounds, props.treeRowId]);
    const { gesture, animatedStyle } = useSessionInlineDrag({
        sessionKey: dragKey,
        groupKey: props.groupKey,
        onDragStart: props.onDragStart,
        onDropResult: props.onDropResult,
        onDragCancel: props.onDragCancel,
        resolveDropResult: props.resolveDropResult,
        dataIndex: props.dataIndex,
        overlayShared: props.overlayShared,
        // Native retains whole-header hold-to-drag. Web attaches only to the
        // grip so pointer capture cannot swallow clicks on header buttons.
        activateAfterLongPressMs: Platform.OS === 'web' ? undefined : 350,
    });

    const content = (
        <Animated.View
            ref={wrapperRef}
            collapsable={false}
            testID={props.folderId ? `session-folder-drag-row-${props.folderId}` : undefined}
            style={animatedStyle}
            onLayout={() => props.onRegisterTreeRowBounds(props.treeRowId, wrapperRef.current)}
        >
            {props.children(Platform.OS === 'web' ? gesture : undefined)}
        </Animated.View>
    );

    return Platform.OS !== 'web' && gesture
        ? <GestureDetector gesture={gesture}>{content}</GestureDetector>
        : content;
});
