import * as React from 'react';

import { Platform } from 'react-native';

import {
    isPushNotificationBundledSoundId,
    resolveExpoNotificationSoundName,
    resolvePushNotificationAndroidChannelId,
    type AccountSettings,
} from '@happier-dev/protocol';
import { resolveActivityAttentionDeliveryPlan } from '@/activity/delivery/resolveActivityAttentionDeliveryPlan';
import type { ActivityAttentionDeliveryEventKind } from '@/activity/delivery/activityAttentionDeliveryPlanTypes';
import { localSettingsParse, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { isDesktopMainWindowFocused } from '@/desktop/window/desktopMainWindowPresence';
import { storage, useLocalSetting, useSetting } from '@/sync/domains/state/storage';
import { isSessionSurfaceVisible } from '@/sync/domains/session/sessionSurfaceVisibility';
import { getActiveServerUrl } from '@/sync/domains/server/serverProfiles';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { buildActivityLocalNotificationContent } from '../buildActivityLocalNotificationContent';
import { sendExpoLocalNotification } from '../channels/sendExpoLocalNotification';
import { sendTauriLocalNotification } from '../channels/sendTauriLocalNotification';
import { subscribeActivityLocalNotifications, type ActivityLocalNotificationEvent } from './activityLocalNotificationBus';

function resolveLocalNotificationEventKind(event: ActivityLocalNotificationEvent): ActivityAttentionDeliveryEventKind {
    if (event.kind === 'ready') return 'ready';
    return event.requestKind === 'permission' ? 'permission_request' : 'user_action_request';
}

function resolveExpoLocalNotificationSound(
    event: ActivityLocalNotificationEvent,
    deliveryPlan: ReturnType<typeof resolveActivityAttentionDeliveryPlan>,
): Readonly<{ sound: string | null; channelId?: string }> {
    const kind = resolveLocalNotificationEventKind(event);
    const androidKind = kind === 'permission_request'
        ? 'permission'
        : kind === 'user_action_request'
            ? 'user_action'
            : 'ready';

    if (deliveryPlan.delivery === 'silent' || deliveryPlan.sound.kind === 'none') {
        return {
            sound: null,
            channelId: Platform.OS === 'android'
                ? resolvePushNotificationAndroidChannelId({ kind: androidKind, soundId: 'none' })
                : undefined,
        };
    }
    if (deliveryPlan.sound.kind === 'system_default') {
        return { sound: 'default' };
    }

    const soundId = deliveryPlan.sound.id ?? 'default';
    const sound = resolveExpoNotificationSoundName(soundId) ?? null;
    return {
        sound,
        channelId:
            Platform.OS === 'android' && isPushNotificationBundledSoundId(soundId)
                ? resolvePushNotificationAndroidChannelId({ kind: androidKind, soundId })
                : undefined,
    };
}

function isSessionActivelyViewedForLocalNotification(sessionId: string): boolean {
    if (!isSessionSurfaceVisible(sessionId)) {
        return false;
    }

    if (!isDesktopHost()) {
        return true;
    }

    return isDesktopMainWindowFocused();
}

function useActivityLocalNotificationLocalSettings(): Partial<LocalSettings> {
    const attentionDeviceOverridesV1 = useLocalSetting('attentionDeviceOverridesV1');

    return React.useMemo(
        () => localSettingsParse({ attentionDeviceOverridesV1 }),
        [attentionDeviceOverridesV1],
    );
}

function useActivityLocalNotificationAccountSettings(): Partial<AccountSettings> {
    const attentionDeliveryPolicyV1 = useSetting('attentionDeliveryPolicyV1');

    return React.useMemo(
        () => ({ attentionDeliveryPolicyV1 }),
        [attentionDeliveryPolicyV1],
    );
}

export function ActivityLocalNotificationRuntime(): React.ReactElement | null {
    const localSettings = useActivityLocalNotificationLocalSettings();
    const accountSettings = useActivityLocalNotificationAccountSettings();

    React.useEffect(() => {
        return subscribeActivityLocalNotifications((event) => {
            const deliveryPlan = resolveActivityAttentionDeliveryPlan({
                accountSettings,
                localSettings,
                event: resolveLocalNotificationEventKind(event),
                channel: 'local_notification',
                sameSessionVisible: isSessionActivelyViewedForLocalNotification(event.sessionId),
                now: new Date(),
            });
            if (deliveryPlan.delivery === 'suppress') {
                return;
            }

            const session = storage.getState().sessions[event.sessionId];
            const notification = buildActivityLocalNotificationContent({
                event,
                session,
                serverUrl: getActiveServerUrl(),
                includeReadyMessageText: deliveryPlan.previewBehavior === 'include_preview',
            });

            if (isDesktopHost()) {
                fireAndForget(sendTauriLocalNotification({
                    title: notification.title,
                    body: notification.body,
                }), { tag: 'ActivityLocalNotificationRuntime.sendTauriLocalNotification' });
                return;
            }

            if (Platform.OS === 'web') return;

            const resolvedSound = resolveExpoLocalNotificationSound(event, deliveryPlan);
            const expoNotificationParams: Parameters<typeof sendExpoLocalNotification>[0] = {
                title: notification.title,
                body: notification.body,
                data: notification.data,
                categoryIdentifier: notification.expo.categoryIdentifier,
                sound: resolvedSound.sound,
                channelId: resolvedSound.channelId,
            };
            fireAndForget(sendExpoLocalNotification(expoNotificationParams), {
                tag: 'ActivityLocalNotificationRuntime.sendExpoLocalNotification',
            });
        });
    }, [accountSettings, localSettings]);

    return null;
}
