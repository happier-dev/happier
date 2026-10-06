import React from 'react';
import { View, Platform, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
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
import { isTouchPrimaryPointer } from '@/components/ui/interactiveTargetSize';
import { isSecondaryEntityRowControl } from '@/components/ui/treeDragDrop/useEntityDragDomBinding';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import { EntityDropSettledFeedback, type EntityDropSettledMatch } from '@/components/ui/treeDragDrop/ui/EntityDropSettledFeedback';
import type { EntityDragItemV1 } from '@happier-dev/protocol/plugins/ui';
import { SESSION_LIST_SHEET_INSET_PX } from './sessionListStyles';
import { SESSION_LIST_ROW_CORNER_RADIUS } from './resolveSessionListDensityViewState';
import { useSessionListStagedMoveKeyHandler } from './keyboardMove/SessionListStagedMoveDock';
import { getSessionName } from '@/utils/sessions/sessionUtils';
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
        organizeMode: boolean;
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
        measurementTarget?: Readonly<{
            ref: React.Ref<View>;
            onLayout: NonNullable<ViewProps['onLayout']>;
            style?: StyleProp<ViewStyle>;
        }>;
    }
>;

export const SessionListRow = React.memo(function SessionListRow(props: SessionListRowProps) {
    const {
        sessionKey,
        treeRowId,
        groupKey,
        reorderEnabled,
        organizeMode,
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
        measurementTarget,
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

    // E1/K1: the whole desktop row is the one source; a phone row lifts only through its Organize grip.
    const touchPrimary = isTouchPrimaryPointer();
    const inlineDragEnabled = reorderEnabled && (!touchPrimary || organizeMode);

    const { gesture, animatedStyle } = useSessionInlineDrag({
        enabled: inlineDragEnabled,
        sessionKey,
        groupKey,
        onDragStart: handleInlineDragStart,
        onDropResult: handleInlineDropResult,
        onDragUpdate,
        onDragCancel,
        resolveDropResult,
        dataIndex,
        overlayShared,
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

    // KS: on the web a focused row owns its staged keyboard move. Capture runs before the row's own
    // press handling, so Space/Enter pick up instead of opening while a move is possible.
    const stagedMoveKeyHandler = useSessionListStagedMoveKeyHandler();
    const itemSessionRef = React.useRef(itemProps.session);
    itemSessionRef.current = itemProps.session;
    const itemServerId = itemProps.serverId ?? null;
    const handleStagedMoveKeyDownCapture = React.useCallback((event: React.KeyboardEvent<HTMLElement>) => {
        if (!stagedMoveKeyHandler || !sessionKey || !reorderEnabled || !event.key) return;
        if (event.defaultPrevented || isSecondaryEntityRowControl(event.nativeEvent, event.currentTarget)) return;
        if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
        const label = getSessionName(itemSessionRef.current, itemServerId);
        if (!stagedMoveKeyHandler({ sessionKey, label, key: event.key, repeat: event.repeat })) return;
        event.preventDefault?.();
        event.stopPropagation?.();
    }, [itemServerId, reorderEnabled, sessionKey, stagedMoveKeyHandler]);
    const webKeyProps = Platform.OS === 'web' && stagedMoveKeyHandler && reorderEnabled
        ? ({ onKeyDownCapture: handleStagedMoveKeyDownCapture } as Record<string, unknown>)
        : null;

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
            dragGripGesture={touchPrimary ? reorderGesture : undefined}
            dragEnabled={reorderEnabled}
            organizeMode={organizeMode}
            isBeingDragged={isBeingDragged}
        />
    );

    const handleWrapperRef = React.useCallback((node: View | null) => {
        wrapperRef.current = node;
        const measurementRef = measurementTarget?.ref;
        if (typeof measurementRef === 'function') {
            measurementRef(node);
        } else if (measurementRef) {
            measurementRef.current = node;
        }
    }, [measurementTarget?.ref]);

    const handleRowLayout = React.useCallback((event: Parameters<NonNullable<ViewProps['onLayout']>>[0]) => {
        onRegisterTreeRowBounds(treeRowId, wrapperRef.current);
        measurementTarget?.onLayout(event);
    }, [measurementTarget, onRegisterTreeRowBounds, treeRowId]);

    const rowNode = inlineDragEnabled ? (
        <Animated.View
            ref={handleWrapperRef}
            collapsable={false}
            style={[animatedStyle, measurementTarget?.style]}
            pointerEvents={rowPointerEvents}
            onLayout={handleRowLayout}
            {...webKeyProps}
        >
            {sessionItem}
        </Animated.View>
    ) : (
        <View
            ref={handleWrapperRef}
            collapsable={false}
            style={measurementTarget?.style}
            pointerEvents={rowPointerEvents}
            onLayout={handleRowLayout}
            {...webKeyProps}
        >
            {sessionItem}
        </View>
    );

    const row = !touchPrimary && reorderGesture ? (
        <GestureDetector gesture={reorderGesture}>
            {rowNode}
        </GestureDetector>
    ) : rowNode;

    // Lab ST4: a move its owner refused late (or could not confirm) stays under this row in words.
    return (
        <SessionListRowSettledFeedback sessionId={itemProps.session.id} serverId={itemServerId} testID={`session-list-row:${treeRowId}`}>
            {row}
        </SessionListRowSettledFeedback>
    );
});

const ROW_FLASH_STYLE = { left: SESSION_LIST_SHEET_INSET_PX, right: SESSION_LIST_SHEET_INSET_PX, borderRadius: SESSION_LIST_ROW_CORNER_RADIUS } as const;
const ROW_LINE_STYLE = { paddingHorizontal: SESSION_LIST_SHEET_INSET_PX } as const;

function SessionListRowSettledFeedback(props: React.PropsWithChildren<Readonly<{ sessionId: string; serverId: string | null; testID: string }>>) {
    const runtime = useEntityDragDropRuntime();
    const { sessionId, serverId } = props;
    const match = React.useMemo<EntityDropSettledMatch>(() => ({
        item: (item: EntityDragItemV1) => item.kind === 'session' && item.address.sessionId === sessionId
            && (serverId === null || item.address.serverId === serverId),
    }), [serverId, sessionId]);
    return (
        <EntityDropSettledFeedback runtime={runtime} match={match} flashStyle={ROW_FLASH_STYLE} lineStyle={ROW_LINE_STYLE} testID={props.testID}>
            {props.children}
        </EntityDropSettledFeedback>
    );
}
