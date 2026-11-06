import * as React from 'react';

import { Platform } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { useFeatureDetails } from '@/hooks/server/useFeatureDetails';
import { useLocalSettings, useSettingsSelector } from '@/sync/domains/state/storage';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';
import { schedulePushTokenReconciliation } from '@/sync/engine/account/syncAccount';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { DEFAULT_LIVE_ACTIVITY_REMOTE_UPDATE_CAPABILITY_DIAGNOSTICS, type LiveActivityRemoteUpdateCapabilityDiagnostics } from '@happier-dev/protocol/activity/live/remoteUpdateCapabilities';
import { BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID } from '@happier-dev/protocol/account/settings/notificationChannels';
import type { WebhookNotificationChannelRecordV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { NotificationConfigurationActionOutputSchemas,
    type NotificationChannelConfigurationPatch, type NotificationConfigurationActionId } from '@happier-dev/protocol/actions/notificationConfigurationActionFamily';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { presentActionTurnedOffNoticeIfOff } from '@/sync/ops/actions/actionTurnedOffNotice';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useNotificationChannelCatalog } from '@/sync/store/useNotificationChannelCatalog';
import { Modal } from '@/modal';

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
import { resolveHomeDisplayLabel, resolveHomeDisplayName } from '@/components/settings/server/homeDisplayName';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { NOTIFICATIONS_SETTINGS } from '@/components/settings/notifications/notificationsSettings';
import { settingRendersOnHost } from '@/components/settings/catalog/settingDeclarations';
import { SettingSection } from '@/components/settings/shell/SettingRow';
import { useDeclaredSettingsWrite } from '@/components/settings/shell/useDeclaredSettingsWrite';

export const NotificationsSettingsView = React.memo(function NotificationsSettingsView() {
    const router = useRouter();
    const settings = useSettingsSelector((settings) => ({
        attentionDeliveryPolicyV1: settings.attentionDeliveryPolicyV1,
        sessionRemoteAlertsEnabled: settings.sessionRemoteAlertsEnabled,
    }), ["attentionDeliveryPolicyV1","sessionRemoteAlertsEnabled"]);
    const localSettings = useLocalSettings();
    const scope = useAccountSettingsScope();
    const channelCatalog = useNotificationChannelCatalog(scope);
    const execution = useMountedActionExecution(scope);
    const { execute: executeAction, ready: actionReady, approval, isCurrent } = execution;
    const writeSetting = useDeclaredSettingsWrite(execution);
    const executeNotificationAction = React.useCallback(async (actionId: NotificationConfigurationActionId, input: unknown) => {
        if (!actionReady) return null;
        try {
            const result = await executeAction(actionId, input);
            if (!isCurrent()) return null;
            if (!result.ok) {
                if (result.errorCode === 'action_account_scope_changed' || isActionApprovalDeclinedErrorCode(result.errorCode)) return null;
                if (presentActionTurnedOffNoticeIfOff(result, actionId)) return null;
                throw new Error(result.error);
            }
            return result.result;
        } catch (error) {
            if (isCurrent()) Modal.alert(t('common.error'), error instanceof Error ? error.message : t('common.error'));
            return null;
        }
    }, [actionReady, executeAction, isCurrent]);
    const executeMutation = React.useCallback<ExecuteNotificationConfigurationMutation>(async mutation => {
        const result = await executeNotificationAction(mutation.actionId, mutation.input);
        return result === null ? null : NotificationConfigurationActionOutputSchemas[mutation.actionId].parse(result);
    }, [executeNotificationAction]);
    const activeServer = useActiveServerSnapshot();
    useServerProfilesGeneration();
    // The canonical Home naming owner: the published or user-given name, else "this Home" in a sentence
    // and "This Home" as a detail value — never the address.
    const activeHomeProfile = getServerProfileById(activeServer.serverId);
    const activeHomeName = resolveHomeDisplayLabel(activeHomeProfile, activeServer.serverId);
    const activeHomeInSentence = resolveHomeDisplayName(activeHomeProfile) ?? t('settingsAccount.thisHome');
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
    const catalogPending = channelCatalog.status === 'loading' && !builtin;
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

    const updateBuiltin = React.useCallback(async (patch: NotificationChannelConfigurationPatch) =>
        executeMutation({ actionId: 'notifications.expoPush.update', input: { patch } }), [executeMutation]);

    const setPushEnabled = React.useCallback(async (enabled: boolean) => {
        if (!await updateBuiltin({ enabled })) return;
        schedulePushTokenReconciliation();
        if (!enabled) return;
        // Enabling push here is the user's demonstrated intent, so it is the right moment to ask
        // the OS — framed in-app first. Registration itself never prompts, so without this the
        // setting could be on while the OS permission was never requested.
        await executeNotificationAction('notifications.push.permission.request', {});
    }, [updateBuiltin, executeNotificationAction]);

    const setExpoPushEventEnabled = React.useCallback(async (event: NotificationTypeEventId, enabled: boolean) => {
        if (event === 'follow_update') { await writeSetting(NOTIFICATIONS_SETTINGS.settings.following, enabled); return; }
        const topic = event === 'permission_request' ? 'permissionRequest' : event === 'user_action_request' ? 'userActionRequest' : 'ready';
        await updateBuiltin({ topics: { [topic]: enabled } });
    }, [writeSetting, updateBuiltin]);

    const setExpoPushReadyPreviewEnabled = React.useCallback(async (enabled: boolean) => {
        await updateBuiltin({ readyIncludeMessageText: enabled });
    }, [updateBuiltin]);

    const setExpoPushRequestPreviewEnabled = React.useCallback(async (enabled: boolean) => {
        await updateBuiltin({ requestIncludeMessageText: enabled });
    }, [updateBuiltin]);

    const setAccountSoundPreset = React.useCallback((preset: 'happier' | 'system' | 'silent') => {
        void writeSetting(NOTIFICATIONS_SETTINGS.settings.soundPreset, preset);
    }, [writeSetting]);

    const setDeviceSoundsEnabled = React.useCallback((enabled: boolean) => {
        void writeSetting(NOTIFICATIONS_SETTINGS.settings.deviceEnabled, enabled);
    }, [writeSetting]);

    const previewSound = React.useCallback(() => {
        void executeNotificationAction('notifications.sounds.preview', {});
    }, [executeNotificationAction]);

    const showIosActivitySurfaceSections = settingRendersOnHost(NOTIFICATIONS_SETTINGS.settings.liveActivitiesEnabled);
    const showSharedDesktopActivitySurfaceSettings = !showIosActivitySurfaceSections
        && settingRendersOnHost(NOTIFICATIONS_SETTINGS.settings.enabled);

    return (
        <ItemList style={{ paddingTop: 0 }} testID="settings-notifications-screen">
            <SettingsPageHeader description={t('settingsNotifications.pageDescription')} />
            {approval.approvalId && scope ? (
                <ActionApprovalPendingNotice testID="settings-notifications-approval-pending"
                    message={t('secrets.catalog.approvalPending')}
                    onOpenApproval={() => router.pushRetainingCurrent(`/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(scope.serverId)}`)} />
            ) : null}
            {isDesktopHost() ? (
                <NotificationDesktopPermissionSection />
            ) : null}
            <NotificationPushSection
                homeName={activeHomeInSentence}
                pushEnabled={pushEnabled}
                pending={catalogPending}
                setPushEnabled={setPushEnabled}
                openPushTroubleshooting={openPushTroubleshooting}
                mutePhoneWhenComputerFocused={attentionPolicy.mutePhoneWhenComputerFocused === true}
                setMutePhoneWhenComputerFocused={(enabled) => { void writeSetting(NOTIFICATIONS_SETTINGS.settings.mutePhoneWhenComputerFocused, enabled); }}
            />
            <NotificationTypesSection
                policy={attentionPolicy}
                builtin={builtin ?? null}
                pushEnabled={pushEnabled}
                pending={catalogPending}
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
                setAccountQuietHours={(preset) => { void writeSetting(NOTIFICATIONS_SETTINGS.settings.quietHoursAccount, preset); }}
                setDeviceQuietHoursOverride={(quietHoursOverride) => { void writeSetting(NOTIFICATIONS_SETTINGS.settings.quietHoursDevice, quietHoursOverride); }}
            />
            <SettingSection section={NOTIFICATIONS_SETTINGS.sectionRefs.remoteAlerts}>
            {followingEnabled ? <NotificationRemoteAlertsSection
                homeName={activeHomeName}
                accountEnabled={settings.sessionRemoteAlertsEnabled}
                deviceEnabled={localSettings.deviceRemoteAlertsEnabled}
                nativeDevice={settingRendersOnHost(NOTIFICATIONS_SETTINGS.settings.device)}
                registration={remoteAlerts.registration}
                setAccountEnabled={async (enabled) => {
                    if (await writeSetting(NOTIFICATIONS_SETTINGS.settings.account, enabled)) schedulePushTokenReconciliation();
                }}
                setDeviceEnabled={async (enabled) => {
                    if (await writeSetting(NOTIFICATIONS_SETTINGS.settings.device, enabled)) schedulePushTokenReconciliation();
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
                setSetting={writeSetting}
            />
            <NotificationForegroundBehaviorSection
                localSettings={localSettings}
                setSetting={writeSetting}
            />
            <NotificationBadgesSection
                localSettings={localSettings}
                setSetting={writeSetting}
            />
            {showIosActivitySurfaceSections ? (
                <>
                    <ActivitySurfacesSettingsSection
                        localSettings={localSettings}
                        setSetting={writeSetting}
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
                    setSetting={writeSetting}
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
