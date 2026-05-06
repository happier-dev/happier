import * as React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import {
    handleDesktopWindowTitlebarMouseAction,
    type DesktopWindowPointerLikeEvent,
} from './DesktopWindowDragRegion';
import { DESKTOP_MAIN_CONTENT_DRAG_HEIGHT_PX } from '@/components/navigation/shell/desktopChrome/desktopChromeMetrics';

type DesktopMainContentDragSurfaceProps = Readonly<{
    children: React.ReactNode;
    enabled: boolean;
    leftOffsetPx: number;
    heightPx?: number;
    style?: StyleProp<ViewStyle>;
}>;

function resolveClientX(event: DesktopWindowPointerLikeEvent): number | undefined {
    return event.clientX ?? event.nativeEvent?.clientX;
}

function resolveClientY(event: DesktopWindowPointerLikeEvent): number | undefined {
    return event.clientY ?? event.nativeEvent?.clientY;
}

function isInsideMainContentTitlebarStrip(
    event: DesktopWindowPointerLikeEvent,
    leftOffsetPx: number,
    heightPx: number,
): boolean {
    const clientX = resolveClientX(event);
    const clientY = resolveClientY(event);

    if (typeof clientX !== 'number' || typeof clientY !== 'number') {
        return false;
    }

    return clientX >= leftOffsetPx && clientY >= 0 && clientY <= heightPx;
}

function resolveDesktopMainContentDragDocument(): Pick<Document, 'addEventListener' | 'removeEventListener'> | null {
    const candidate = (globalThis as typeof globalThis & { document?: Document }).document;
    if (!candidate || typeof candidate.addEventListener !== 'function' || typeof candidate.removeEventListener !== 'function') {
        return null;
    }
    return candidate;
}

export const DesktopMainContentDragSurface = React.memo((props: DesktopMainContentDragSurfaceProps) => {
    const heightPx = props.heightPx ?? DESKTOP_MAIN_CONTENT_DRAG_HEIGHT_PX;

    const startDraggingFromEvent = React.useCallback((event: DesktopWindowPointerLikeEvent) => {
        if (!props.enabled || Platform.OS !== 'web') {
            return false;
        }
        if (!isInsideMainContentTitlebarStrip(event, props.leftOffsetPx, heightPx)) {
            return false;
        }
        return handleDesktopWindowTitlebarMouseAction(
            event,
            'DesktopMainContentDragSurface.mouseDown',
        ) !== 'none';
    }, [heightPx, props.enabled, props.leftOffsetPx]);

    React.useEffect(() => {
        if (!props.enabled || Platform.OS !== 'web') {
            return undefined;
        }

        const ownerDocument = resolveDesktopMainContentDragDocument();
        if (!ownerDocument) {
            return undefined;
        }

        const handleMouseDown = (event: MouseEvent) => {
            startDraggingFromEvent(event);
        };

        ownerDocument.addEventListener('mousedown', handleMouseDown, true);
        return () => {
            ownerDocument.removeEventListener('mousedown', handleMouseDown, true);
        };
    }, [props.enabled, startDraggingFromEvent]);

    return (
        <View
            testID="desktop-main-content-drag-surface"
            style={props.style}
        >
            {props.children}
        </View>
    );
});
