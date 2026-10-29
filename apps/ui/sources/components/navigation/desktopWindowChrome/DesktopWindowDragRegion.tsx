import * as React from 'react';
import { Platform } from 'react-native';
import {
    desktopWindowChromeUsesAppDragRegions,
    startDesktopWindowDragging,
    toggleDesktopWindowMaximize,
} from '@/utils/platform/desktopWindowBridge';
import { useDesktopWindowChromePolicy } from '@/hooks/ui/useDesktopWindowChromePolicy';
import { fireAndForget } from '@/utils/system/fireAndForget';

export type DesktopWindowPointerLikeEvent = Readonly<{
    button?: number;
    buttons?: number;
    clientX?: number;
    clientY?: number;
    detail?: number;
    target?: unknown;
    defaultPrevented?: boolean;
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
}>;

export type DesktopWindowTitlebarMouseAction = 'drag' | 'toggleMaximize' | 'none';

const NON_DRAGGABLE_TARGET_SELECTOR = [
    'button',
    'a',
    'input',
    'textarea',
    'select',
    '[role="button"]',
    // React Native Web Pressable hosts can be focusable divs without a button role.
    '[tabindex]:not([tabindex="-1"])',
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
    if (event.defaultPrevented || !isPrimaryTitlebarMouseEvent(event) || isNonDraggableTarget(resolveMouseTarget(event))) {
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

export function useDesktopWindowDragMouseProps(enabled = true): DesktopWindowDragMouseProps {
    const policy = useDesktopWindowChromePolicy();
    const appDragRegions = desktopWindowChromeUsesAppDragRegions(policy);
    return React.useMemo(() => {
        if (!appDragRegions || Platform.OS !== 'web' || !enabled) {
            return {};
        }
        // Mouse down carries the click count. Starting native drag on pointer down
        // can consume that event before a double click reaches the titlebar owner.
        return {
            onMouseDown: (event: DesktopWindowPointerLikeEvent) => {
                handleDesktopWindowTitlebarMouseAction(event, 'DesktopWindowDragRegion.mouseDown');
            },
        };
    }, [appDragRegions, enabled]);
}
