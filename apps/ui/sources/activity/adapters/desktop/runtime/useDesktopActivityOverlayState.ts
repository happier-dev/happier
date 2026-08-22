import * as React from 'react';

import { isDesktopHost } from '@/utils/platform/desktopHost';

import { DESKTOP_ACTIVITY_OVERLAY_STATE_RECONCILE_INTERVAL_MS } from '../desktopActivityOverlayTiming';
import {
    getDesktopActivityOverlayWindowState,
    listenDesktopActivityOverlayWindowState,
    type DesktopActivityOverlayWindowStatePayload,
} from './desktopActivityOverlayBridge';
import { isDesktopActivityOverlayWindowContext } from './isDesktopActivityOverlayWindowContext';

function createDesktopActivityOverlayStateSignature(payload: DesktopActivityOverlayWindowStatePayload): string {
    return JSON.stringify(payload);
}

export function useDesktopActivityOverlayState(): DesktopActivityOverlayWindowStatePayload | null {
    const [state, setState] = React.useState<DesktopActivityOverlayWindowStatePayload | null>(null);

    React.useEffect(() => {
        if (!isDesktopHost() || !isDesktopActivityOverlayWindowContext()) {
            return () => {};
        }

        let disposed = false;
        let unlisten: (() => void) | null = null;
        let reconcileInFlight = false;
        const stateSignatureRef = { current: null as string | null };
        const applyState = (payload: DesktopActivityOverlayWindowStatePayload) => {
            if (disposed) return;
            const nextSignature = createDesktopActivityOverlayStateSignature(payload);
            if (stateSignatureRef.current === nextSignature) {
                return;
            }
            stateSignatureRef.current = nextSignature;
            setState(payload);
        };

        const reconcileState = () => {
            if (reconcileInFlight) {
                return;
            }
            reconcileInFlight = true;
            void getDesktopActivityOverlayWindowState().then((payload) => {
                if (payload) {
                    applyState(payload);
                }
            }).catch(() => {}).finally(() => {
                reconcileInFlight = false;
            });
        };

        reconcileState();

        const reconcileInterval = setInterval(
            reconcileState,
            DESKTOP_ACTIVITY_OVERLAY_STATE_RECONCILE_INTERVAL_MS,
        );

        void listenDesktopActivityOverlayWindowState((payload) => {
            if (payload) {
                applyState(payload);
            }
        }).then((dispose) => {
            if (disposed) {
                dispose();
                return;
            }
            unlisten = dispose;
        }).catch(() => {});

        return () => {
            disposed = true;
            clearInterval(reconcileInterval);
            unlisten?.();
        };
    }, []);

    return state;
}
