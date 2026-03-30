import * as React from 'react';

import { Platform } from 'react-native';

import { storage, useLocalSettings } from '@/sync/domains/state/storage';
import { getActiveViewingSessionId } from '@/sync/domains/session/activeViewingSession';
import { getActiveServerUrl } from '@/sync/domains/server/serverProfiles';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { buildActivityLocalNotificationContent } from '../buildActivityLocalNotificationContent';
import { sendExpoLocalNotification } from '../channels/sendExpoLocalNotification';
import { sendTauriLocalNotification } from '../channels/sendTauriLocalNotification';
import { subscribeActivityLocalNotifications, type ActivityLocalNotificationEvent } from './activityLocalNotificationBus';

function shouldNotifyForEvent(
    localSettings: Readonly<Record<string, unknown>>,
    event: ActivityLocalNotificationEvent,
): boolean {
    if (localSettings.localNotificationsEnabled === false) {
        return false;
    }

    if (event.kind === 'ready') {
        return localSettings.localNotificationsShowReady !== false;
    }

    if (event.requestKind === 'permission') {
        return localSettings.localNotificationsShowPendingPermissionRequests !== false;
    }

    return localSettings.localNotificationsShowPendingUserActionRequests !== false;
}

export function ActivityLocalNotificationRuntime(): React.ReactElement | null {
    const localSettings = useLocalSettings();

    React.useEffect(() => {
        return subscribeActivityLocalNotifications((event) => {
            if (!shouldNotifyForEvent(localSettings, event)) {
                return;
            }

            if (getActiveViewingSessionId() === event.sessionId) {
                return;
            }

            const session = storage.getState().sessions[event.sessionId];
            const notification = buildActivityLocalNotificationContent({
                event,
                session,
                serverUrl: getActiveServerUrl(),
                includeReadyMessageText: localSettings.localNotificationsShowReadyMessageText !== false,
            });

            if (isTauriDesktop()) {
                fireAndForget(sendTauriLocalNotification({
                    title: notification.title,
                    body: notification.body,
                }), { tag: 'ActivityLocalNotificationRuntime.sendTauriLocalNotification' });
                return;
            }

            if (Platform.OS === 'web') return;

            fireAndForget(sendExpoLocalNotification({
                title: notification.title,
                body: notification.body,
                data: notification.data,
                categoryIdentifier: notification.expo.categoryIdentifier,
            }), { tag: 'ActivityLocalNotificationRuntime.sendExpoLocalNotification' });
        });
    }, [localSettings]);

    return null;
}
