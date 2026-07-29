import * as React from 'react';

import { Platform } from 'react-native';
import { useRouter } from 'expo-router';

import { sendExpoLocalNotification } from '@/activity/notifications/channels/sendExpoLocalNotification';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useFeatureDetails } from '@/hooks/server/useFeatureDetails';
import {
    deriveAttentionDeviceOverridesV1FromLegacyLocalSettings,
    hasLegacyAttentionDeviceOverrideFields,
} from '@/sync/domains/settings/attentionDeviceOverridesV1';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { useLocalSettings, useSettings } from '@/sync/domains/state/storage';
import { useApplyLocalSettings, useApplySettings } from '@/sync/store/settingsWriters';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import { runPushNotificationPermissionPriming } from '@/activity/notifications/permission/pushNotificationPermissionPriming';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { fireAndForget } from '@/utils/system/fireAndForget';
import {
    AttentionDeliveryPolicyV1Schema,
    DEFAULT_LIVE_ACTIVITY_REMOTE_UPDATE_CAPABILITY_DIAGNOSTICS,
    PUSH_NOTIFICATION_SOUND_IDS,
    accountSettingsParse,
    resolveExpoNotificationSoundName,
    resolveNotificationChannelsV1FromAccountSettings,
    type AttentionDeliveryPolicyV1,
    type LiveActivityRemoteUpdateCapabilityDiagnostics,
    type NotificationChannelV1,
    type WebhookNotificationChannelV1,
} from '@happier-dev/protocol';

import { ActivitySurfacesSettingsSection } from './ActivitySurfacesSettingsSection';
import { NotificationBadgesSection } from './NotificationBadgesSection';
import { NotificationForegroundBehaviorSection } from './NotificationForegroundBehaviorSection';
import { NotificationLiveActivityRemoteUpdatesSection } from './NotificationLiveActivityRemoteUpdatesSection';
import { NotificationLocalDeviceSection } from './NotificationLocalDeviceSection';
import { NotificationDesktopPermissionSection } from './NotificationDesktopPermissionSection';
import { NotificationPushSection } from './NotificationPushSection';
import { NotificationQuietHoursSection } from './NotificationQuietHoursSection';
import { NotificationSoundsSection } from './NotificationSoundsSection';
import { NotificationTypesSection, type NotificationTypeEventId } from './NotificationTypesSection';
import { NotificationWebhooksSection } from './NotificationWebhooksSection';
import { buildWebhookNotificationSettingsDelta } from './notificationChannels';

export const NotificationsSettingsView = React.memo(function NotificationsSettingsView() {
    const router = useRouter();
    const settings = useSettings();
    const localSettings = useLocalSettings();
    const applySettings = useApplySettings();
    const applyLocalSettings = useApplyLocalSettings();

    const attentionPolicy = React.useMemo(
        () => accountSettingsParse(settings).attentionDeliveryPolicyV1,
        [settings],
    );
    const notificationChannels = React.useMemo(
        () => resolveNotificationChannelsV1FromAccountSettings(settings),
        [settings],
    );
    const webhookChannels = React.useMemo(
        () => notificationChannels.filter((channel): channel is WebhookNotificationChannelV1 => (
            channel.kind === 'webhook'
        )),
        [notificationChannels],
    );

    const pushEnabled = attentionPolicy.channels.expo_push.enabled !== false;
    const previewSupported = Platform.OS !== 'web' && !isTauriDesktop();
    const liveActivityRemoteUpdateDiagnostics =
        useFeatureDetails<LiveActivityRemoteUpdateCapabilityDiagnostics>({
            featureId: 'app.ui.liveActivities',
            fallback: DEFAULT_LIVE_ACTIVITY_REMOTE_UPDATE_CAPABILITY_DIAGNOSTICS,
            select: (features) => features.capabilities.liveActivities.remoteUpdates,
        });

    const openPushTroubleshooting = React.useCallback(() => {
        router.push('/settings/notifications/push');
    }, [router]);

    const applyWebhookNotificationSettings = React.useCallback((nextChannels: ReadonlyArray<NotificationChannelV1>) => {
        applySettings(buildWebhookNotificationSettingsDelta({
            basePolicy: attentionPolicy,
            webhookChannels: nextChannels,
        }));
    }, [applySettings, attentionPolicy]);

    const setWebhookChannels = React.useCallback((nextChannels: ReadonlyArray<NotificationChannelV1>) => {
        applyWebhookNotificationSettings(nextChannels);
    }, [applyWebhookNotificationSettings]);

    const setAttentionPolicy = React.useCallback((next: Partial<AttentionDeliveryPolicyV1>) => {
        applySettings({
            attentionDeliveryPolicyV1: AttentionDeliveryPolicyV1Schema.parse({
                ...attentionPolicy,
                ...next,
            }),
        });
    }, [applySettings, attentionPolicy]);

    const setPushEnabled = React.useCallback((enabled: boolean) => {
        setAttentionPolicy({
            channels: {
                ...attentionPolicy.channels,
                expo_push: {
                    ...attentionPolicy.channels.expo_push,
                    enabled,
                },
            },
        });
        if (!enabled) return;
        // Enabling push here is the user's demonstrated intent, so it is the right moment to ask
        // the OS — framed in-app first. Registration itself never prompts, so without this the
        // setting could be on while the OS permission was never requested.
        void runPushNotificationPermissionPriming({
            pushEnabled: true,
            trigger: 'user_action',
            onGranted: () => sync.onPushPermissionGranted(),
        });
    }, [attentionPolicy.channels, setAttentionPolicy]);

    const setExpoPushEventEnabled = React.useCallback((event: NotificationTypeEventId, enabled: boolean) => {
        const expoPushChannel = attentionPolicy.channels.expo_push;
        setAttentionPolicy({
            events: {
                ...attentionPolicy.events,
                [event]: {
                    ...attentionPolicy.events[event],
                    enabled,
                },
            },
            channels: {
                ...attentionPolicy.channels,
                expo_push: {
                    ...expoPushChannel,
                    events: {
                        ...expoPushChannel.events,
                        [event]: {
                            ...expoPushChannel.events[event],
                            enabled,
                        },
                    },
                },
            },
        });
    }, [attentionPolicy.channels, attentionPolicy.events, setAttentionPolicy]);

    const setExpoPushReadyPreviewEnabled = React.useCallback((enabled: boolean) => {
        const expoPushChannel = attentionPolicy.channels.expo_push;
        setAttentionPolicy({
            channels: {
                ...attentionPolicy.channels,
                expo_push: {
                    ...expoPushChannel,
                    previewBehavior: enabled ? 'include_preview' : 'status_only',
                },
            },
        });
    }, [attentionPolicy.channels, setAttentionPolicy]);

    const setAccountSoundPreset = React.useCallback((preset: 'happier' | 'system' | 'silent') => {
        const eventSoundIds = { ...attentionPolicy.sounds.eventSoundIds };
        delete eventSoundIds.permission_request;
        delete eventSoundIds.user_action_request;

        const sounds = preset === 'happier'
            ? {
                ...attentionPolicy.sounds,
                defaultSoundId: PUSH_NOTIFICATION_SOUND_IDS.soft,
                eventSoundIds: {
                    ...eventSoundIds,
                    permission_request: PUSH_NOTIFICATION_SOUND_IDS.urgent,
                    user_action_request: PUSH_NOTIFICATION_SOUND_IDS.urgent,
                },
            }
            : {
                ...attentionPolicy.sounds,
                defaultSoundId: preset === 'system'
                    ? PUSH_NOTIFICATION_SOUND_IDS.systemDefault
                    : PUSH_NOTIFICATION_SOUND_IDS.none,
                eventSoundIds,
            };

        setAttentionPolicy({
            sounds,
        });
    }, [attentionPolicy.sounds, setAttentionPolicy]);

    const setLocalSetting = React.useCallback((delta: Partial<LocalSettings>) => {
        const deltaRecord: Record<string, unknown> = { ...delta };
        const canonicalDelta = (
            delta.attentionDeviceOverridesV1 !== undefined
            || !hasLegacyAttentionDeviceOverrideFields(deltaRecord)
        )
            ? delta
            : {
                ...delta,
                attentionDeviceOverridesV1: deriveAttentionDeviceOverridesV1FromLegacyLocalSettings({
                    legacy: deltaRecord,
                    base: localSettings.attentionDeviceOverridesV1,
                }),
            };
        applyLocalSettings(canonicalDelta);
    }, [applyLocalSettings, localSettings.attentionDeviceOverridesV1]);

    const setDeviceSoundsEnabled = React.useCallback((enabled: boolean) => {
        applyLocalSettings({
            attentionDeviceOverridesV1: {
                ...localSettings.attentionDeviceOverridesV1,
                sounds: {
                    ...localSettings.attentionDeviceOverridesV1.sounds,
                    enabled,
                },
            },
        });
    }, [applyLocalSettings, localSettings.attentionDeviceOverridesV1]);

    const previewSound = React.useCallback(() => {
        const sound = (
            localSettings.attentionDeviceOverridesV1.sounds.enabled === false
            || attentionPolicy.sounds.defaultSoundId === PUSH_NOTIFICATION_SOUND_IDS.none
        )
            ? null
            : resolveExpoNotificationSoundName(attentionPolicy.sounds.defaultSoundId);
        fireAndForget(Promise.resolve(sendExpoLocalNotification({
            title: t('settingsNotifications.sounds.previewNotificationTitle'),
            body: t('settingsNotifications.sounds.previewNotificationBody'),
            sound,
        })), {
            tag: 'NotificationsSettingsView.previewSound',
        });
    }, [attentionPolicy.sounds.defaultSoundId, localSettings.attentionDeviceOverridesV1.sounds.enabled]);

    const showIosActivitySurfaceSections = Platform.OS === 'ios';
    const showSharedDesktopActivitySurfaceSettings = !showIosActivitySurfaceSections && isTauriDesktop();

    return (
        <ItemList style={{ paddingTop: 0 }} testID="settings-notifications-screen">
            {showIosActivitySurfaceSections ? (
                <>
                    <ActivitySurfacesSettingsSection
                        localSettings={localSettings}
                        setLocalSetting={setLocalSetting}
                    />
                    <NotificationLiveActivityRemoteUpdatesSection
                        policy={attentionPolicy}
                        deviceModeOverride={localSettings.attentionDeviceOverridesV1.liveActivities.remoteUpdateModeOverride}
                        diagnostics={liveActivityRemoteUpdateDiagnostics}
                    />
                </>
            ) : showSharedDesktopActivitySurfaceSettings ? (
                <ActivitySurfacesSettingsSection
                    localSettings={localSettings}
                    setLocalSetting={setLocalSetting}
                    renderMode="shared_only"
                />
            ) : null}

            <NotificationBadgesSection
                localSettings={localSettings}
                setLocalSetting={setLocalSetting}
            />
            <NotificationLocalDeviceSection
                localSettings={localSettings}
                setLocalSetting={setLocalSetting}
            />
            {isTauriDesktop() ? (
                <NotificationDesktopPermissionSection />
            ) : null}
            <NotificationQuietHoursSection
                policy={attentionPolicy}
                deviceOverride={localSettings.attentionDeviceOverridesV1.quietHoursOverride}
                setAccountQuietHours={(quietHours) => setAttentionPolicy({ quietHours })}
                setDeviceQuietHoursOverride={(quietHoursOverride) => setLocalSetting({
                    attentionDeviceOverridesV1: {
                        ...localSettings.attentionDeviceOverridesV1,
                        quietHoursOverride,
                    },
                })}
            />
            <NotificationSoundsSection
                policy={attentionPolicy}
                deviceOverrides={localSettings.attentionDeviceOverridesV1}
                previewSupported={previewSupported}
                setAccountSoundPreset={setAccountSoundPreset}
                setDeviceSoundsEnabled={setDeviceSoundsEnabled}
                previewSound={previewSound}
            />
            <NotificationPushSection
                pushEnabled={pushEnabled}
                setPushEnabled={setPushEnabled}
                openPushTroubleshooting={openPushTroubleshooting}
            />
            <NotificationWebhooksSection
                webhookChannels={webhookChannels}
                setWebhookChannels={setWebhookChannels}
            />
            <NotificationTypesSection
                policy={attentionPolicy}
                pushEnabled={pushEnabled}
                setEventEnabled={setExpoPushEventEnabled}
                setReadyPreviewEnabled={setExpoPushReadyPreviewEnabled}
            />
            <NotificationForegroundBehaviorSection
                localSettings={localSettings}
                setLocalSetting={setLocalSetting}
            />
        </ItemList>
    );
});
