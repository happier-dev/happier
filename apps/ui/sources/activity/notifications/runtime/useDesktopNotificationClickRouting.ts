import { router } from 'expo-router';
import * as React from 'react';

import { navigateToSessionRoute } from '@/hooks/session/navigateToSessionRoute';
import { invokeTauri, isTauriDesktop, listenTauriEvent } from '@/utils/platform/tauri';

export const DESKTOP_NOTIFICATION_CLICKED_EVENT = 'desktop-notification-clicked';

type DesktopNotificationClickedPayload = Readonly<{ sessionId?: string | null }>;

const TAKE_PENDING_COMMAND = 'desktop_take_pending_notification_session';

/** Opens the session a clicked desktop toast was about (the shell has already focused the window). */
export function useDesktopNotificationClickRouting(): void {
    React.useEffect(() => {
        if (!isTauriDesktop()) return;

        let disposed = false;
        let unlisten: (() => void) | null = null;
        const open = (sessionId: string) => navigateToSessionRoute({ router, sessionId });
        // Takes (and so clears) the click the shell remembered; used on start-up and after each
        // event so the same click is never opened twice.
        const takePending = async (): Promise<string> => {
            try {
                const pending = await invokeTauri<string | null>(TAKE_PENDING_COMMAND);
                return typeof pending === 'string' ? pending.trim() : '';
            } catch {
                return '';
            }
        };
        void listenTauriEvent<DesktopNotificationClickedPayload>(
            DESKTOP_NOTIFICATION_CLICKED_EVENT,
            (payload) => {
                const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
                if (!sessionId) return;
                open(sessionId);
                void takePending();
            },
        ).then((dispose) => {
            if (disposed) dispose();
            else unlisten = dispose;
        }).catch(() => undefined);

        // A click that recreated the window fired before this listener existed.
        void takePending().then((sessionId) => {
            if (!disposed && sessionId) open(sessionId);
        });

        return () => {
            disposed = true;
            unlisten?.();
        };
    }, []);
}
