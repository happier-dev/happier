import * as React from 'react';
import { Platform, Pressable, type StyleProp, type ViewStyle } from 'react-native';
import {
    startDesktopWindowDragging,
    toggleDesktopWindowMaximize,
} from '@/utils/platform/desktopWindowBridge';
import { fireAndForget } from '@/utils/system/fireAndForget';

type DesktopWindowDragRegionProps = Readonly<{
    testID: string;
    style?: StyleProp<ViewStyle>;
}>;

export type DesktopWindowPointerLikeEvent = Readonly<{
    button?: number;
    buttons?: number;
    clientX?: number;
    clientY?: number;
    detail?: number;
    target?: unknown;
    preventDefault?: () => void;
    nativeEvent?: Readonly<{
        button?: number;
        buttons?: number;
        clientX?: number;
        clientY?: number;
        detail?: number;
        target?: unknown;
    }>;
}>;

type ClosestCapableTarget = Readonly<{
    closest?: (selector: string) => unknown;
}>;

export type DesktopWindowDragMouseProps = Readonly<{
    onMouseDown?: (event: DesktopWindowPointerLikeEvent) => void;
    onPointerDown?: (event: DesktopWindowPointerLikeEvent) => void;
    'data-tauri-drag-region'?: true;
}>;

export type DesktopWindowTitlebarMouseAction = 'drag' | 'toggleMaximize' | 'none';

const NON_DRAGGABLE_TARGET_SELECTOR = [
    'button',
    'a',
    'input',
    'textarea',
    'select',
    '[role="button"]',
    '[contenteditable="true"]',
    '[data-desktop-window-no-drag="true"]',
].join(',');

function resolvePrimaryButtonState(event: DesktopWindowPointerLikeEvent): number | undefined {
    return event.buttons ?? event.nativeEvent?.buttons;
}

function resolveMouseButton(event: DesktopWindowPointerLikeEvent): number | undefined {
    return event.button ?? event.nativeEvent?.button;
}

function resolveMouseTarget(event: DesktopWindowPointerLikeEvent): unknown {
    return event.target ?? event.nativeEvent?.target;
}

function resolveMouseDetail(event: DesktopWindowPointerLikeEvent): number | undefined {
    return event.detail ?? event.nativeEvent?.detail;
}

function isNonDraggableTarget(target: unknown): boolean {
    const candidate = target as ClosestCapableTarget | null | undefined;
    if (!candidate || typeof candidate.closest !== 'function') {
        return false;
    }

    return candidate.closest(NON_DRAGGABLE_TARGET_SELECTOR) != null;
}

function isPrimaryTitlebarMouseEvent(event: DesktopWindowPointerLikeEvent): boolean {
    const buttons = resolvePrimaryButtonState(event);
    if (typeof buttons === 'number') {
        return buttons === 1;
    }

    const button = resolveMouseButton(event);
    return button == null || button === 0;
}

export function resolveDesktopWindowTitlebarMouseAction(
    event: DesktopWindowPointerLikeEvent,
): DesktopWindowTitlebarMouseAction {
    if (!isPrimaryTitlebarMouseEvent(event) || isNonDraggableTarget(resolveMouseTarget(event))) {
        return 'none';
    }

    return resolveMouseDetail(event) === 2 ? 'toggleMaximize' : 'drag';
}

export function shouldStartDesktopWindowDraggingFromMouseEvent(event: DesktopWindowPointerLikeEvent): boolean {
    return resolveDesktopWindowTitlebarMouseAction(event) === 'drag';
}

export function handleDesktopWindowTitlebarMouseAction(
    event: DesktopWindowPointerLikeEvent,
    tag: string,
): DesktopWindowTitlebarMouseAction {
    const action = resolveDesktopWindowTitlebarMouseAction(event);
    if (action === 'none') {
        return action;
    }

    event.preventDefault?.();
    if (action === 'toggleMaximize') {
        fireAndForget(toggleDesktopWindowMaximize(), { tag });
        return action;
    }

    fireAndForget(startDesktopWindowDragging(), { tag });
    return action;
}

export function useDesktopWindowDragMouseProps(): DesktopWindowDragMouseProps {
    const handledPointerDownRef = React.useRef(false);

    return React.useMemo(() => {
        if (Platform.OS !== 'web') {
            return {};
        }

        const handleTitlebarMouseEvent = (event: DesktopWindowPointerLikeEvent, tag: string) => {
            return handleDesktopWindowTitlebarMouseAction(event, tag) !== 'none';
        };

        return {
            'data-tauri-drag-region': true,
            onPointerDown: (event: DesktopWindowPointerLikeEvent) => {
                handledPointerDownRef.current = handleTitlebarMouseEvent(
                    event,
                    'DesktopWindowDragRegion.pointerDown',
                );
            },
            onMouseDown: (event: DesktopWindowPointerLikeEvent) => {
                if (handledPointerDownRef.current) {
                    handledPointerDownRef.current = false;
                    return;
                }
                handleTitlebarMouseEvent(event, 'DesktopWindowDragRegion.mouseDown');
            },
        };
    }, []);
}

export const DesktopWindowDragRegion = React.memo((props: DesktopWindowDragRegionProps) => {
    const handlePressIn = React.useCallback(() => {
        fireAndForget(startDesktopWindowDragging(), { tag: 'DesktopWindowDragRegion.startDragging' });
    }, []);

    return (
        <Pressable
            testID={props.testID}
            accessible={false}
            style={props.style}
            onPressIn={handlePressIn}
        />
    );
});
