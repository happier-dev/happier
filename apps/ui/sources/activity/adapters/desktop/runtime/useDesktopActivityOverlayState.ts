import * as React from 'react';

import { isTauriDesktop } from '@/utils/platform/tauri';

import {
    getDesktopActivityOverlayWindowState,
    listenDesktopActivityOverlayWindowState,
    type DesktopActivityOverlayWindowStatePayload,
} from './desktopActivityOverlayBridge';
import { isDesktopActivityOverlayWindowContext } from './isDesktopActivityOverlayWindowContext';

export function useDesktopActivityOverlayState(): DesktopActivityOverlayWindowStatePayload | null {
    const [state, setState] = React.useState<DesktopActivityOverlayWindowStatePayload | null>(null);

    React.useEffect(() => {
        if (!isTauriDesktop() || !isDesktopActivityOverlayWindowContext()) {
            return () => {};
        }

        let disposed = false;
        let unlisten: (() => void) | null = null;
        const applyState = (payload: DesktopActivityOverlayWindowStatePayload) => {
            if (disposed) return;
            setState(payload);
        };

        void getDesktopActivityOverlayWindowState().then((payload) => {
            if (payload) {
                applyState(payload);
            }
        }).catch(() => {});

        void listenDesktopActivityOverlayWindowState((payload) => {
            applyState(payload);
        }).then((dispose) => {
            unlisten = dispose;
        }).catch(() => {});

        return () => {
            disposed = true;
            unlisten?.();
        };
    }, []);

    return state;
}
