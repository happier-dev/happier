import * as React from 'react';

import { Platform } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { sendExpoLocalNotification } from '@/activity/notifications/channels/sendExpoLocalNotification';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { useFeatureDetails } from '@/hooks/server/useFeatureDetails';
import {
    deriveAttentionDeviceOverridesV1FromLegacyLocalSettings,
    hasLegacyAttentionDeviceOverrideFields,
} from '@/sync/domains/settings/attentionDeviceOverridesV1';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { useLocalSettings, useSettingsSelector } from '@/sync/domains/state/storage';
import { useAccountSettingsScope, useApplyLocalSettings, useApplySettings } from '@/sync/store/settingsWriters';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import { schedulePushTokenReconciliation } from '@/sync/engine/account/syncAccount';
import { runPushNotificationPermissionPriming } from '@/activity/notifications/permission/pushNotificationPermissionPriming';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { AttentionDeliveryPolicyV1Schema, accountSettingsParse, type AttentionDeliveryPolicyV1 } from '@happier-dev/protocol/account/settings/accountSettings';
import { DEFAULT_LIVE_ACTIVITY_REMOTE_UPDATE_CAPABILITY_DIAGNOSTICS, type LiveActivityRemoteUpdateCapabilityDiagnostics } from '@happier-dev/protocol/activity/live/remoteUpdateCapabilities';
import { PUSH_NOTIFICATION_SOUND_IDS, resolveExpoNotificationSoundName } from '@happier-dev/protocol/push/pushNotificationActions';
import { BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID } from '@happier-dev/protocol/account/settings/notificationChannels';
import type { WebhookNotificationChannelRecordV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { NotificationConfigurationActionOutputSchemas,
    type NotificationChannelConfigurationPatch } from '@happier-dev/protocol/actions/notificationConfigurationActionFamily';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useNotificationChannelCatalog } from '@/sync/store/useNotificationChannelCatalog';
import { Modal } from '@/modal';

import { SessionAutoFollowPreferencesSection } from '@/components/sessions/follow/SessionAutoFollowPreferencesSection';
import { ActivitySurfacesSettingsSection } from './ActivitySurfacesSettingsSection';
import { NotificationBadgesSection } from './NotificationBadgesSection';
import { NotificationForegroundBehaviorSection } from './NotificationForegroundBehaviorSection';
import { NotificationLiveActivityRemoteUpdatesSection } from './NotificationLiveActivityRemoteUpdatesSection';
import { NotificationLocalDeviceSection } from './NotificationLocalDeviceSection';
import { NotificationDesktopPermissionSection } from './NotificationDesktopPermissionSection';
import { NotificationPushSection } from './NotificationPushSection';
import { NotificationRemoteAlertsSection } from './NotificationRemoteAlertsSection';
import { useRemoteAlertRegistrationStatus } from './useRemoteAlertRegistrationStatus';
import { NotificationQuietHoursSection } from './NotificationQuietHoursSection';
import { NotificationSoundsSection } from './NotificationSoundsSection';
import { NotificationTypesSection, type NotificationTypeEventId } from './NotificationTypesSection';
import { NotificationWebhooksSection, type ExecuteNotificationConfigurationMutation } from './NotificationWebhooksSection';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { NOTIFICATIONS_SETTINGS } from '@/components/settings/notifications/notificationsSettings';
import { settingRendersOnHost } from '@/components/settings/catalog/settingDeclarations';
import { SettingSection } from '@/components/settings/shell/SettingRow';
import { updateAccountNotificationPreference, updateNotificationDeviceSounds, updateNotificationDeviceQuietHours, type AccountNotificationPreference } from './notificationPreferences';

export const NotificationsSettingsView = React.memo(function NotificationsSettingsView() {
    const router = useRouter();
    const settings = useSettingsSelector((settings) => ({
        attentionDeliveryPolicyV1: settings.attentionDeliveryPolicyV1,
        sessionRemoteAlertsEnabled: settings.sessionRemoteAlertsEnabled,
    }));
    const localSettings = useLocalSettings();
    const applySettings = useApplySettings();
    const applyLocalSettings = useApplyLocalSettings();
    const scope = useAccountSettingsScope();
    const channelCatalog = useNotificationChannelCatalog(scope);
    const { execute: executeAction, ready: actionReady, approval } = useMountedActionExecution(scope);
    const executeMutation = React.useCallback<ExecuteNotificationConfigurationMutation>(async mutation => {
        if (!actionReady) return null;
        try {
            const result = await executeAction(mutation.actionId, mutation.input);
            if (!result.ok) {
                if (result.errorCode === 'action_account_scope_changed') return null;
                throw new Error(result.error);
            }
            return NotificationConfigurationActionOutputSchemas[mutation.actionId].parse(result.result);
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('common.error'));
            return null;
        }
    }, [actionReady, executeAction]);
    const activeServer = useActiveServerSnapshot();
    useServerProfilesGeneration();
    const activeHomeName = getServerProfileById(activeServer.serverId)?.name.trim()
        || activeServer.serverUrl.trim()
        || t('settingsNotifications.push.currentHome');
    const followingEnabled = useFeatureEnabled('sessions.following', {
        scopeKind: 'spawn',
        serverId: activeServer.serverId,
    });

    const attentionPolicy = React.useMemo(
        () => accountSettingsParse(settings).attentionDeliveryPolicyV1,
        [settings],
    );
    const webhookChannels = React.useMemo(
        () => channelCatalog.channels.filter((channel): channel is WebhookNotificationChannelRecordV1 => (
            channel.kind === 'webhook'
        )),
        [channelCatalog.channels],
    );
    const builtin = channelCatalog.channels.find((channel): channel is Extract<typeof channel, { kind: 'expo_push' }> =>
        channel.id === BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID && channel.kind === 'expo_push');
    const pushEnabled = builtin?.enabled === true && attentionPolicy.channels.expo_push.enabled !== false;
    const remoteAlerts = useRemoteAlertRegistrationStatus({
        enabled: followingEnabled,
        serverId: activeServer.serverId,
        accountEnabled: settings.sessionRemoteAlertsEnabled,
        policy: attentionPolicy,
        deviceEnabled: localSettings.deviceRemoteAlertsEnabled,
        deviceOverrides: localSettings.attentionDeviceOverridesV1,
    });
    const previewSupported = Platform.OS !== 'web' && !isDesktopHost();
    const liveActivityRemoteUpdateDiagnostics =
        useFeatureDetails<LiveActivityRemoteUpdateCapabilityDiagnostics>({
            featureId: 'app.ui.liveActivities',
            fallback: DEFAULT_LIVE_ACTIVITY_REMOTE_UPDATE_CAPABILITY_DIAGNOSTICS,
            select: (features) => features.capabilities.liveActivities.remoteUpdates,
        });

    const openPushTroubleshooting = React.useCallback(() => {
        router.push('/settings/notifications/push');
    }, [router]);

    const setAttentionPolicy = React.useCallback((next: Partial<AttentionDeliveryPolicyV1>) => {
        applySettings({
            attentionDeliveryPolicyV1: AttentionDeliveryPolicyV1Schema.parse({
                ...attentionPolicy,
                ...next,
            }),
        });
    }, [applySettings, attentionPolicy]);

    const updateBuiltin = React.useCallback(async (patch: NotificationChannelConfigurationPatch) =>
        executeMutation({ actionId: 'notifications.expoPush.update', input: { patch } }), [executeMutation]);

    const setPushEnabled = React.useCallback(async (enabled: boolean) => {
        if (!await updateBuiltin({ enabled })) return;
        schedulePushTokenReconciliation();
        if (!enabled) return;
        // Enabling push here is the user's demonstrated intent, so it is the right moment to ask
        // the OS — framed in-app first. Registration itself never prompts, so without this the
        // setting could be on while the OS permission was never requested.
        void runPushNotificationPermissionPriming({
            pushEnabled: true,
            trigger: 'user_action',
            onGranted: () => sync.onPushPermissionGranted(),
        });
    }, [updateBuiltin]);

    const setNotificationPreference = React.useCallback((id: AccountNotificationPreference, value: boolean | string) => {
        applySettings({ attentionDeliveryPolicyV1: updateAccountNotificationPreference(attentionPolicy, id, value) });
    }, [applySettings, attentionPolicy]);

    const setExpoPushEventEnabled = React.useCallback(async (event: NotificationTypeEventId, enabled: boolean) => {
        if (event === 'follow_update') { setNotificationPreference(event, enabled); return; }
        const topic = event === 'permission_request' ? 'permissionRequest' : event === 'user_action_request' ? 'userActionRequest' : 'ready';
        await updateBuiltin({ topics: { [topic]: enabled } });
    }, [setNotificationPreference, updateBuiltin]);

    const setExpoPushReadyPreviewEnabled = React.useCallback(async (enabled: boolean) => {
        await updateBuiltin({ readyIncludeMessageText: enabled });
    }, [updateBuiltin]);

    const setExpoPushRequestPreviewEnabled = React.useCallback(async (enabled: boolean) => {
        await updateBuiltin({ requestIncludeMessageText: enabled });
    }, [updateBuiltin]);

    const setAccountSoundPreset = React.useCallback((preset: 'happier' | 'system' | 'silent') => {
        setNotificationPreference('soundPreset', preset);
    }, [setNotificationPreference]);

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
        applyLocalSettings(updateNotificationDeviceSounds(localSettings, enabled));
    }, [applyLocalSettings, localSettings]);

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

    const showIosActivitySurfaceSections = settingRendersOnHost(NOTIFICATIONS_SETTINGS.settings.liveActivitiesEnabled);
    const showSharedDesktopActivitySurfaceSettings = !showIosActivitySurfaceSections
        && settingRendersOnHost(NOTIFICATIONS_SETTINGS.settings.enabled);

    return (
        <ItemList style={{ paddingTop: 0 }} testID="settings-notifications-screen">
            <SettingsPageHeader description={t('settingsNotifications.pageDescription')} />
            {approval.approvalId && scope ? (
                <ActionApprovalPendingNotice testID="settings-notifications-approval-pending"
                    message={t('secrets.catalog.approvalPending')}
                    onOpenApproval={() => router.push(`/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(scope.serverId)}`)} />
            ) : null}
            {isDesktopHost() ? (
                <NotificationDesktopPermissionSection />
            ) : null}
            <NotificationPushSection
                homeName={activeHomeName}
                pushEnabled={pushEnabled}
                setPushEnabled={setPushEnabled}
                openPushTroubleshooting={openPushTroubleshooting}
                mutePhoneWhenComputerFocused={attentionPolicy.mutePhoneWhenComputerFocused === true}
                setMutePhoneWhenComputerFocused={(enabled) => setNotificationPreference('mutePhoneWhenComputerFocused', enabled)}
            />
            <NotificationTypesSection
                policy={attentionPolicy}
                builtin={builtin ?? null}
                pushEnabled={pushEnabled}
                setEventEnabled={setExpoPushEventEnabled}
                setReadyPreviewEnabled={setExpoPushReadyPreviewEnabled}
                setRequestPreviewEnabled={setExpoPushRequestPreviewEnabled}
            />
            <NotificationSoundsSection
                policy={attentionPolicy}
                deviceOverrides={localSettings.attentionDeviceOverridesV1}
                previewSupported={previewSupported}
                setAccountSoundPreset={setAccountSoundPreset}
                setDeviceSoundsEnabled={setDeviceSoundsEnabled}
                previewSound={previewSound}
            />
            <NotificationQuietHoursSection
                policy={attentionPolicy}
                deviceOverride={localSettings.attentionDeviceOverridesV1.quietHoursOverride}
                setAccountQuietHours={(quietHours) => setAttentionPolicy({ quietHours })}
                setDeviceQuietHoursOverride={(quietHoursOverride) => setLocalSetting(updateNotificationDeviceQuietHours(localSettings, quietHoursOverride))}
            />
            <SessionAutoFollowPreferencesSection key={activeServer.serverId} serverId={activeServer.serverId} />
            <SettingSection section={NOTIFICATIONS_SETTINGS.sectionRefs.remoteAlerts}>
            {followingEnabled ? <NotificationRemoteAlertsSection
                homeName={activeHomeName}
                accountEnabled={settings.sessionRemoteAlertsEnabled}
                deviceEnabled={localSettings.deviceRemoteAlertsEnabled}
                nativeDevice={settingRendersOnHost(NOTIFICATIONS_SETTINGS.settings.device)}
                registration={remoteAlerts.registration}
                setAccountEnabled={(enabled) => {
                    applySettings({ sessionRemoteAlertsEnabled: enabled });
                    schedulePushTokenReconciliation();
                }}
                setDeviceEnabled={(enabled) => {
                    applyLocalSettings({ deviceRemoteAlertsEnabled: enabled });
                    schedulePushTokenReconciliation();
                }}
                refresh={() => {
                    schedulePushTokenReconciliation();
                    remoteAlerts.refresh();
                }}
            /> : (
                <ItemGroup title={t('settingsNotifications.remoteAlerts.title')}>
                    <Item
                        testID="settings-notifications-remote-unavailable"
                        title={t('settingsNotifications.remoteAlerts.unavailable')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            )}
            </SettingSection>
            <NotificationLocalDeviceSection
                localSettings={localSettings}
                setLocalSetting={setLocalSetting}
            />
            <NotificationForegroundBehaviorSection
                localSettings={localSettings}
                setLocalSetting={setLocalSetting}
            />
            <NotificationBadgesSection
                localSettings={localSettings}
                setLocalSetting={setLocalSetting}
            />
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
            <NotificationWebhooksSection
                webhookChannels={webhookChannels}
                executeMutation={executeMutation}
                canMutate={channelCatalog.status === 'ready' && !channelCatalog.stale}
            />
        </ItemList>
    );
});
