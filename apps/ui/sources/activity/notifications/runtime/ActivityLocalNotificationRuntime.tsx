import * as React from 'react';

import { Platform } from 'react-native';
import { router } from 'expo-router';

import { navigateToSessionRoute } from '@/hooks/session/navigateToSessionRoute';
import { storage, useLocalSetting } from '@/sync/domains/state/storage';
import { getActiveViewingSessionId } from '@/sync/domains/session/activeViewingSession';
import { getActiveServerUrl } from '@/sync/domains/server/serverProfiles';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { isHostActivelyViewed } from '@/utils/runtime/isRuntimeActive';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { buildActivityLocalNotificationContent } from '../buildActivityLocalNotificationContent';
import { sendExpoLocalNotification } from '../channels/sendExpoLocalNotification';
import { sendTauriLocalNotification } from '../channels/sendTauriLocalNotification';
import { sendWebLocalNotification } from '../channels/sendWebLocalNotification';
import { subscribeActivityLocalNotifications, type ActivityLocalNotificationEvent } from './activityLocalNotificationBus';
import { usePresentedAgentRequestSettlement } from './usePresentedAgentRequestSettlement';

type ActivityLocalNotificationSettings = Readonly<{
    localNotificationsEnabled: boolean;
    localNotificationsShowReady: boolean;
    localNotificationsShowReadyMessageText: boolean;
    localNotificationsShowRequestMessageText: boolean;
    localNotificationsShowPendingPermissionRequests: boolean;
    localNotificationsShowPendingUserActionRequests: boolean;
}>;

function useActivityLocalNotificationSettings(): ActivityLocalNotificationSettings {
    const localNotificationsEnabled = useLocalSetting('localNotificationsEnabled');
    const localNotificationsShowReady = useLocalSetting('localNotificationsShowReady');
    const localNotificationsShowReadyMessageText = useLocalSetting('localNotificationsShowReadyMessageText');
    const localNotificationsShowRequestMessageText = useLocalSetting('localNotificationsShowRequestMessageText');
    const localNotificationsShowPendingPermissionRequests = useLocalSetting('localNotificationsShowPendingPermissionRequests');
    const localNotificationsShowPendingUserActionRequests = useLocalSetting('localNotificationsShowPendingUserActionRequests');

    return React.useMemo(
        () => ({
            localNotificationsEnabled,
            localNotificationsShowReady,
            localNotificationsShowReadyMessageText,
            localNotificationsShowRequestMessageText,
            localNotificationsShowPendingPermissionRequests,
            localNotificationsShowPendingUserActionRequests,
        }),
        [
            localNotificationsEnabled,
            localNotificationsShowPendingPermissionRequests,
            localNotificationsShowPendingUserActionRequests,
            localNotificationsShowReady,
            localNotificationsShowReadyMessageText,
            localNotificationsShowRequestMessageText,
        ],
    );
}

function shouldNotifyForEvent(
    localSettings: ActivityLocalNotificationSettings,
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

function shouldSuppressSameSessionNotification(event: ActivityLocalNotificationEvent): boolean {
    if (getActiveViewingSessionId() !== event.sessionId) {
        return false;
    }

    // A browser tab or the desktop app can keep a session open while the person works elsewhere.
    if (Platform.OS === 'web') {
        return isHostActivelyViewed();
    }

    return true;
}

/**
 * Every open tab delivers the same event, and the browser replaces a notification with the same
 * tag, so an event-scoped tag shows one notification per event without merging distinct events.
 */
function resolveWebNotificationTag(event: ActivityLocalNotificationEvent): string | undefined {
    if (event.kind === 'agent-request') {
        return `happier:${event.sessionId}:request:${event.occurrenceId ?? event.requestId}`;
    }

    const lastMessageId = event.messages?.at(-1)?.id;
    return lastMessageId ? `happier:${event.sessionId}:ready:${lastMessageId}` : undefined;
}

export function ActivityLocalNotificationRuntime(): React.ReactElement | null {
    const localSettings = useActivityLocalNotificationSettings();
    const reconcilePresentedRequests = usePresentedAgentRequestSettlement();

    React.useEffect(() => {
        return subscribeActivityLocalNotifications((event) => {
            if (!shouldNotifyForEvent(localSettings, event)) {
                return;
            }

            if (shouldSuppressSameSessionNotification(event)) {
                return;
            }

            const session = storage.getState().sessions[event.sessionId];
            const notification = buildActivityLocalNotificationContent({
                event,
                session,
                serverUrl: getActiveServerUrl(),
                accountId: getActiveServerAccountScope()?.accountId,
                includeReadyMessageText: localSettings.localNotificationsShowReadyMessageText !== false,
                includeRequestMessageText: localSettings.localNotificationsShowRequestMessageText !== false,
            });

            if (isTauriDesktop()) {
                fireAndForget(sendTauriLocalNotification({
                    title: notification.title,
                    body: notification.body,
                }), { tag: 'ActivityLocalNotificationRuntime.sendTauriLocalNotification' });
                return;
            }

            if (Platform.OS === 'web') {
                const sessionId = event.sessionId;
                fireAndForget(sendWebLocalNotification({
                    title: notification.title,
                    body: notification.body,
                    tag: resolveWebNotificationTag(event),
                    onClick: () => navigateToSessionRoute({ router, sessionId }),
                }), { tag: 'ActivityLocalNotificationRuntime.sendWebLocalNotification' });
                return;
            }

            fireAndForget(sendExpoLocalNotification({
                title: notification.title,
                body: notification.body,
                data: notification.data,
                categoryIdentifier: notification.expo.categoryIdentifier,
                channelId: notification.expo.channelId,
            }).then(reconcilePresentedRequests), { tag: 'ActivityLocalNotificationRuntime.sendExpoLocalNotification' });
        });
    }, [localSettings, reconcilePresentedRequests]);

    return null;
}
