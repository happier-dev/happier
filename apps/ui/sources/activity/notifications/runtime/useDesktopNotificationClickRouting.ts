import * as React from 'react';

import { invokeTauri, isTauriDesktop, listenTauriEvent } from '@/utils/platform/tauri';
import { navigateToLocalNotificationSession } from './navigateToLocalNotificationSession';

export const DESKTOP_NOTIFICATION_CLICKED_EVENT = 'desktop-notification-clicked';

/** The native pending slot owns click data; events only wake its consumer. */
export function useDesktopNotificationClickRouting(): void {
    React.useEffect(() => {
        if (!isTauriDesktop()) return;

        let disposed = false;
        let unlisten: (() => void) | null = null;
        const takePending = async (): Promise<void> => {
            if (disposed) return;
            try {
                const data = await invokeTauri<unknown>('desktop_take_pending_notification_data');
                if (!disposed && data) {
                    await navigateToLocalNotificationSession(data, () => disposed);
                }
            } catch {
                console.warn('[notifications] Desktop notification click unavailable');
            }
        };
        void listenTauriEvent<unknown>(DESKTOP_NOTIFICATION_CLICKED_EVENT, () => { void takePending(); })
            .then((dispose) => {
                if (disposed) {
                    dispose();
                    return;
                }
                unlisten = dispose;
                // Register first, then consume: clicks during registration remain in the shell.
                // Startup and live wakes both take the same slot, so a click opens only once.
                void takePending();
            })
            .catch(() => { console.warn('[notifications] Desktop notification click listener unavailable'); });

        return () => {
            disposed = true;
            unlisten?.();
        };
    }, []);
}
