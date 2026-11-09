import { useDesktopWindowChromePolicy } from '@/hooks/ui/useDesktopWindowChromePolicy';
import { desktopWindowChromeUsesAppDragRegions } from '@/utils/platform/desktopWindowBridge';
import * as React from 'react';
import { desktopHostKind } from '@/utils/platform/desktopHost';
import { Platform } from 'react-native';
import {
    startDesktopWindowDragging,
    toggleDesktopWindowMaximize,
} from '@/utils/platform/desktopWindowBridge';
import { fireAndForget } from '@/utils/system/fireAndForget';

export type DesktopWindowPointerLikeEvent = Readonly<{
    button?: number;
    buttons?: number;
    detail?: number;
    clientX?: number;
    clientY?: number;
    target?: unknown;
    currentTarget?: unknown;
    preventDefault?: () => void;
    defaultPrevented?: boolean;
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
    dataSet?: Readonly<{ desktopWindowDragRegion: 'true' }>;
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
    // Tabs in the title strip (the workspace bar) activate, reorder and open their menu; the gaps
    // between them stay part of the drag region.
    '[role="tab"]',
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

function isNonDraggableTarget(target: unknown, dragRegion: unknown): boolean {
    const candidate = target as ClosestCapableTarget | null | undefined;
    if (!candidate || typeof candidate.closest !== 'function') {
        return false;
    }

    const control = candidate.closest(NON_DRAGGABLE_TARGET_SELECTOR);
    // A keyboard-focusable drag surface is chrome; controls nested inside it remain interactive.
    return control != null && control !== dragRegion;
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
    if (event.defaultPrevented || !isPrimaryTitlebarMouseEvent(event) || isNonDraggableTarget(resolveMouseTarget(event), event.currentTarget)) {
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

/** Tauri exposes an explicit drag command; Electron delegates non-client hit testing to Chromium. */
export function useDesktopWindowDragMode(enabled = true): 'none' | 'command' | 'css' {
    const policy = useDesktopWindowChromePolicy();
    const active = enabled && Platform.OS === 'web' && desktopWindowChromeUsesAppDragRegions(policy);
    const mode = !active ? 'none' : desktopHostKind() === 'electron' ? 'css' : 'command';
    React.useEffect(() => {
        if (mode !== 'css' || typeof document === 'undefined') return;
        if (document.getElementById('happier-electron-window-drag-regions')) return;
        // One stylesheet lives with this webview. The native policy removes the region markers
        // when it uses the conventional frame. Interactive exclusions share the pointer owner.
        const style = document.createElement('style');
        style.id = 'happier-electron-window-drag-regions';
        style.textContent = `[data-desktop-window-drag-region="true"] { -webkit-app-region: drag; }
            :is(${NON_DRAGGABLE_TARGET_SELECTOR}), :is(${NON_DRAGGABLE_TARGET_SELECTOR}) * { -webkit-app-region: no-drag; }`;
        document.head.appendChild(style);
    }, [mode]);
    return mode;
}

export function useDesktopWindowDragMouseProps(enabled = true): DesktopWindowDragMouseProps {
    const mode = useDesktopWindowDragMode(enabled);
    return React.useMemo(() => {
        if (mode === 'none') return {};
        if (mode === 'css') return { dataSet: { desktopWindowDragRegion: 'true' } };
        // Mouse down carries click count; starting a Tauri drag on pointer down can consume it.
        return {
            onMouseDown: (event: DesktopWindowPointerLikeEvent) => {
                handleDesktopWindowTitlebarMouseAction(event, 'DesktopWindowDragRegion.mouseDown');
            },
        };
    }, [mode]);
}
