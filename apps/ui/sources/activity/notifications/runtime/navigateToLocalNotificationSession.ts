import { router } from 'expo-router';

import { getCurrentAuth } from '@/auth/context/AuthContext';
import { navigateToSessionRoute } from '@/hooks/session/navigateToSessionRoute';
import { parseNotificationTap } from '../notificationRouting';
import { navigateWithNotificationAccount } from './navigateWithNotificationAccount';
import { findSavedNotificationServerProfile } from './resolveNotificationPermissionTarget';

/** Browser and desktop local clicks share mobile notification parsing and Account admission. */
export async function navigateToLocalNotificationSession(data: unknown, isDisposed: () => boolean): Promise<void> {
    const parsed = parseNotificationTap({
        response: { actionIdentifier: 'default', notification: { request: { content: { data } } } },
        defaultActionIdentifier: 'default',
    });
    if (!parsed?.routeSessionId || !parsed.route || isDisposed()) return;
    const sessionId = parsed.routeSessionId;
    const saved = parsed.serverUrl ? findSavedNotificationServerProfile(parsed.serverUrl) : null;
    const refreshAuth = getCurrentAuth()?.refreshFromActiveServer ?? null;
    await navigateWithNotificationAccount({
        target: { serverUrl: parsed.serverUrl, route: parsed.route, accountId: parsed.accountId },
        refreshAuth,
        isDisposed,
        navigate: () => navigateToSessionRoute({ router, sessionId, serverId: saved?.id, refreshAuth }),
    });
}
