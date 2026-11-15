import * as React from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { desktopHostKind, getDesktopHostWindowLabel, invokeDesktopHost } from '@/utils/platform/desktopHost';

/** A mounted shell or recovery screen, rather than HTML load or native geometry, makes main usable. */
export function useDesktopMainWindowContentReady() {
    const acknowledged = React.useRef(false);
    return React.useCallback((event: LayoutChangeEvent) => {
        if (acknowledged.current || event.nativeEvent.layout.width <= 0 || event.nativeEvent.layout.height <= 0
            || desktopHostKind() !== 'tauri' || getDesktopHostWindowLabel() !== 'main') return;
        acknowledged.current = true;
        void invokeDesktopHost('desktop_main_window_content_rendered').catch((error: unknown) => {
            acknowledged.current = false;
            console.warn('Could not reveal rendered main window:', error);
        });
    }, []);
}
