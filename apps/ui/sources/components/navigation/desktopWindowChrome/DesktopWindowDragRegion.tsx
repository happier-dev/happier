import * as React from 'react';
import { Platform, Pressable, type StyleProp, type ViewStyle } from 'react-native';
import { startDesktopWindowDragging } from '@/utils/platform/desktopWindowBridge';
import { fireAndForget } from '@/utils/system/fireAndForget';

type DesktopWindowDragRegionProps = Readonly<{
    testID: string;
    style?: StyleProp<ViewStyle>;
}>;

export type DesktopWindowPointerLikeEvent = Readonly<{
    button?: number;
    buttons?: number;
    detail?: number;
    clientX?: number;
    clientY?: number;
    target?: unknown;
    currentTarget?: unknown;
    preventDefault?: () => void;
    nativeEvent?: Readonly<{
        button?: number;
        buttons?: number;
        detail?: number;
        clientX?: number;
        clientY?: number;
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

function isNonDraggableTarget(target: unknown): boolean {
    const candidate = target as ClosestCapableTarget | null | undefined;
    if (!candidate || typeof candidate.closest !== 'function') {
        return false;
    }

    return candidate.closest(NON_DRAGGABLE_TARGET_SELECTOR) != null;
}

export function shouldStartDesktopWindowDraggingFromMouseEvent(event: DesktopWindowPointerLikeEvent): boolean {
    const buttons = resolvePrimaryButtonState(event);
    if (typeof buttons === 'number') {
        return buttons === 1 && !isNonDraggableTarget(resolveMouseTarget(event));
    }

    const button = resolveMouseButton(event);
    return (button == null || button === 0) && !isNonDraggableTarget(resolveMouseTarget(event));
}

export function useDesktopWindowDragMouseProps(): DesktopWindowDragMouseProps {
    const handledPointerDownRef = React.useRef(false);

    return React.useMemo(() => {
        if (Platform.OS !== 'web') {
            return {};
        }

        const startDraggingFromEvent = (event: DesktopWindowPointerLikeEvent, tag: string) => {
            if (!shouldStartDesktopWindowDraggingFromMouseEvent(event)) {
                return false;
            }
            event.preventDefault?.();
            fireAndForget(startDesktopWindowDragging(), { tag });
            return true;
        };

        return {
            'data-tauri-drag-region': true,
            onPointerDown: (event: DesktopWindowPointerLikeEvent) => {
                handledPointerDownRef.current = startDraggingFromEvent(
                    event,
                    'DesktopWindowDragRegion.pointerDown',
                );
            },
            onMouseDown: (event: DesktopWindowPointerLikeEvent) => {
                if (handledPointerDownRef.current) {
                    handledPointerDownRef.current = false;
                    return;
                }
                startDraggingFromEvent(event, 'DesktopWindowDragRegion.mouseDown');
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
