import * as React from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { desktopHostKind, getDesktopHostWindowLabel, invokeDesktopHost } from '@/utils/platform/desktopHost';

type MeasuredNode = Readonly<{ offsetWidth: number; offsetHeight: number }>;

/**
 * A mounted shell or recovery screen, rather than HTML load or native geometry, makes main usable.
 * Main boots hidden, and WebKit throttles rendering updates (ResizeObserver, so onLayout) and
 * timers in a hidden window: the shell's size is read when it is committed (`ref`), and `onLayout`
 * still reports content that had no size at commit.
 */
export function useDesktopMainWindowContentReady() {
    const acknowledged = React.useRef(false);
    const acknowledge = React.useCallback((width: number, height: number) => {
        if (acknowledged.current || width <= 0 || height <= 0
            || desktopHostKind() !== 'tauri' || getDesktopHostWindowLabel() !== 'main') return;
        acknowledged.current = true;
        void invokeDesktopHost('desktop_main_window_content_rendered').catch((error: unknown) => {
            acknowledged.current = false;
            console.warn('Could not reveal rendered main window:', error);
        });
    }, []);
    const ref = React.useCallback((node: unknown) => {
        const measured = node as Partial<MeasuredNode> | null;
        if (typeof measured?.offsetWidth === 'number' && typeof measured.offsetHeight === 'number') {
            acknowledge(measured.offsetWidth, measured.offsetHeight);
        }
    }, [acknowledge]);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        acknowledge(event.nativeEvent.layout.width, event.nativeEvent.layout.height);
    }, [acknowledge]);
    return React.useMemo(() => ({ ref, onLayout }), [onLayout, ref]);
}
