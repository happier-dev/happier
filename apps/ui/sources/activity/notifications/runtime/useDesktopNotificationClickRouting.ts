import { router } from 'expo-router';
import * as React from 'react';

import { navigateToSessionRoute } from '@/hooks/session/navigateToSessionRoute';
import { isTauriDesktop, listenTauriEvent } from '@/utils/platform/tauri';

export const DESKTOP_NOTIFICATION_CLICKED_EVENT = 'desktop-notification-clicked';

type DesktopNotificationClickedPayload = Readonly<{ sessionId?: string | null }>;

/** Opens the session a clicked desktop toast was about (the shell has already focused the window). */
export function useDesktopNotificationClickRouting(): void {
    React.useEffect(() => {
        if (!isTauriDesktop()) return;

        let disposed = false;
        let unlisten: (() => void) | null = null;
        void listenTauriEvent<DesktopNotificationClickedPayload>(
            DESKTOP_NOTIFICATION_CLICKED_EVENT,
            (payload) => {
                const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
                if (!sessionId) return;
                navigateToSessionRoute({ router, sessionId });
            },
        ).then((dispose) => {
            if (disposed) dispose();
            else unlisten = dispose;
        }).catch(() => undefined);

        return () => {
            disposed = true;
            unlisten?.();
        };
    }, []);
}
