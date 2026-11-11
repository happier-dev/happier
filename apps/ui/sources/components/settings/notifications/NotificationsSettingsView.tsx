import * as React from 'react';

import { useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { Switch } from '@/components/ui/forms/Switch';
import { Modal } from '@/modal';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

import { useLocalSettings, useSettings } from '@/sync/domains/state/storage';
import { useApplyLocalSettings, useApplySettings } from '@/sync/store/settingsWriters';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { runPushNotificationPermissionPriming } from '@/activity/notifications/permission/pushNotificationPermissionPriming';
import { requestWebLocalNotificationPermission } from '@/activity/notifications/channels/sendWebLocalNotification';

import {
    DEFAULT_NOTIFICATIONS_SETTINGS_V1,
    NotificationsSettingsV1Schema,
    hasConfiguredSecretStringValue,
    resolveNotificationChannelsV1FromAccountSettings,
    type NotificationChannelV1,
    type NotificationsSettingsV1,
    type WebhookNotificationChannelV1,
} from '@happier-dev/protocol';

import {
    addWebhookNotificationChannel,
    buildNotificationSettingsDelta,
    removeNotificationChannelById,
    updateNotificationChannelById,
} from './notificationChannels';
import { useTauriNotificationPermissionDiagnostics } from './useTauriNotificationPermissionDiagnostics';
import { Icon } from '@/components/ui/icons/Icon';

type ForegroundBehavior = 'full' | 'silent' | 'off';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const NotificationsSettingsView = React.memo(function NotificationsSettingsView() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const settings = useSettings();
    const localSettings = useLocalSettings();
    const applySettings = useApplySettings();
    const applyLocalSettings = useApplyLocalSettings();
    const connectedServiceQuotaNotificationsEnabled = useFeatureEnabled('connectedServices.quotas');
    const connectedServiceFallbackNotificationsEnabled = useFeatureEnabled('connectedServices.accountFallback');
    const showConnectedServiceAccountSwitchNotifications = connectedServiceFallbackNotificationsEnabled;
    const showConnectedServiceQuotaNotifications = connectedServiceQuotaNotificationsEnabled;
    const showConnectedServiceNotificationTopics = showConnectedServiceAccountSwitchNotifications || showConnectedServiceQuotaNotifications;
    const isDesktopNotificationsSupported = React.useMemo(() => isTauriDesktop(), []);
    const desktopNotificationPermission = useTauriNotificationPermissionDiagnostics(isDesktopNotificationsSupported);

    const notificationsRaw = isRecord(settings) ? settings.notificationsSettingsV1 : undefined;
    const notifications = React.useMemo(() => {
        try {
            return NotificationsSettingsV1Schema.parse(notificationsRaw);
        } catch {
            return DEFAULT_NOTIFICATIONS_SETTINGS_V1;
        }
    }, [notificationsRaw]);
    const notificationChannels = React.useMemo(
        () => resolveNotificationChannelsV1FromAccountSettings(settings),
        [settings],
    );
    const webhookChannels = React.useMemo(
        () => notificationChannels.filter((channel): channel is WebhookNotificationChannelV1 => channel.kind === 'webhook'),
        [notificationChannels],
    );

    const pushEnabled = notifications.pushEnabled !== false;

    const openPushTroubleshooting = React.useCallback(() => {
        router.push('/settings/notifications/push');
    }, [router]);

    const applyRemoteNotificationSettings = React.useCallback((nextNotifications: NotificationsSettingsV1, nextChannels: ReadonlyArray<NotificationChannelV1>) => {
        applySettings(buildNotificationSettingsDelta({
            notifications: nextNotifications,
            webhookChannels: nextChannels,
        }));
    }, [applySettings]);

    const setNotifications = React.useCallback((next: Partial<typeof notifications>) => {
        const nextNotifications = NotificationsSettingsV1Schema.parse({
            ...notifications,
            ...next,
            v: 1,
        });
        applyRemoteNotificationSettings(nextNotifications, webhookChannels);
    }, [applyRemoteNotificationSettings, notifications, webhookChannels]);

    /**
     * Enabling push here is the user's demonstrated intent, so it is the right moment to ask the OS
     * — framed in-app first. Registration itself never prompts, so without this the setting could
     * be on while the OS permission was never requested.
     */
    const handlePushEnabledChange = React.useCallback(async (value: boolean) => {
        setNotifications({ pushEnabled: value });
        if (!value) return;
        await runPushNotificationPermissionPriming({
            pushEnabled: true,
            trigger: 'user_action',
            onGranted: () => sync.onPushPermissionGranted(),
        });
    }, [setNotifications]);

    const setNotificationTopic = React.useCallback((
        topic: 'connectedServiceAccountSwitch' | 'connectedServiceQuotaBlocked' | 'connectedServiceQuotaRecovered',
        value: boolean,
    ) => {
        setNotifications({
            [topic]: value,
            ...(topic === 'connectedServiceQuotaBlocked' && !value
                ? { connectedServiceQuotaRecovered: false }
                : {}),
        });
    }, [setNotifications]);

    const setWebhookChannels = React.useCallback((nextChannels: ReadonlyArray<NotificationChannelV1>) => {
        applyRemoteNotificationSettings(notifications, nextChannels);
    }, [applyRemoteNotificationSettings, notifications]);

    const setWebhookTopic = React.useCallback((
        channel: WebhookNotificationChannelV1,
        topic: 'connectedServiceAccountSwitch' | 'connectedServiceQuotaBlocked' | 'connectedServiceQuotaRecovered',
        value: boolean,
    ) => {
        setWebhookChannels(updateNotificationChannelById({
            channels: webhookChannels,
            channelId: channel.id,
            patch: {
                topics: {
                    ...channel.topics,
                    [topic]: value,
                    ...(topic === 'connectedServiceQuotaBlocked' && !value
                        ? { connectedServiceQuotaRecovered: false }
                        : {}),
                },
            },
        }));
    }, [setWebhookChannels, webhookChannels]);

    const setLocalSetting = React.useCallback((delta: Record<string, boolean | ForegroundBehavior>) => {
        applyLocalSettings(delta);
    }, [applyLocalSettings]);

    const promptWebhookUrl = React.useCallback(async (defaultValue?: string) => {
        const raw = await Modal.prompt(
            t('settingsNotifications.webhooks.urlPromptTitle'),
            t('settingsNotifications.webhooks.urlPromptSubtitle'),
            {
                defaultValue,
                placeholder: t('settingsNotifications.webhooks.urlPromptPlaceholder'),
                confirmText: defaultValue ? t('common.save') : t('common.add'),
                cancelText: t('common.cancel'),
            },
        );
        const nextUrl = raw?.trim();
        if (!nextUrl) {
            return null;
        }

        try {
            const parsed = new URL(nextUrl);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                throw new Error('unsupported protocol');
            }
            return nextUrl;
        } catch {
            await Modal.alert(
                t('settingsNotifications.webhooks.invalidUrlTitle'),
                t('settingsNotifications.webhooks.invalidUrlSubtitle'),
            );
            return null;
        }
    }, []);

    const promptWebhookSigningSecret = React.useCallback(async (channel: WebhookNotificationChannelV1) => {
        const raw = await Modal.prompt(
            t('settingsNotifications.webhooks.signingSecretPromptTitle'),
            hasConfiguredSecretStringValue(channel.signingSecret)
                ? t('settingsNotifications.webhooks.signingSecretPromptSubtitleReplace')
                : t('settingsNotifications.webhooks.signingSecretPromptSubtitleAdd'),
            {
                placeholder: t('settingsNotifications.webhooks.signingSecretPromptPlaceholder'),
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
                inputType: 'secure-text',
            },
        );
        const nextSecret = raw?.trim();
        return nextSecret ? { _isSecretValue: true as const, value: nextSecret } : null;
    }, []);

    const handleAddWebhook = React.useCallback(async () => {
        const url = await promptWebhookUrl();
        if (!url) {
            return;
        }

        setWebhookChannels(addWebhookNotificationChannel({
            channels: webhookChannels,
            url,
        }));
    }, [promptWebhookUrl, setWebhookChannels, webhookChannels]);

    const handleEditWebhook = React.useCallback(async (channel: WebhookNotificationChannelV1) => {
        const url = await promptWebhookUrl(channel.url);
        if (!url) {
            return;
        }

        setWebhookChannels(updateNotificationChannelById({
            channels: webhookChannels,
            channelId: channel.id,
            patch: { url },
        }));
    }, [promptWebhookUrl, setWebhookChannels, webhookChannels]);

    const handleDeleteWebhook = React.useCallback(async (channel: WebhookNotificationChannelV1) => {
        const confirmed = await Modal.confirm(
            t('settingsNotifications.webhooks.deleteTitle'),
            t('settingsNotifications.webhooks.deleteConfirm', { url: channel.url }),
            {
                cancelText: t('common.cancel'),
                confirmText: t('common.delete'),
                destructive: true,
            },
        );
        if (!confirmed) {
            return;
        }

        setWebhookChannels(removeNotificationChannelById({
            channels: webhookChannels,
            channelId: channel.id,
        }));
    }, [setWebhookChannels, webhookChannels]);

    const handleSetWebhookSigningSecret = React.useCallback(async (channel: WebhookNotificationChannelV1) => {
        const signingSecret = await promptWebhookSigningSecret(channel);
        if (!signingSecret) {
            return;
        }

        setWebhookChannels(updateNotificationChannelById({
            channels: webhookChannels,
            channelId: channel.id,
            patch: { signingSecret },
        }));
    }, [promptWebhookSigningSecret, setWebhookChannels, webhookChannels]);

    const handleClearWebhookSigningSecret = React.useCallback((channel: WebhookNotificationChannelV1) => {
        setWebhookChannels(updateNotificationChannelById({
            channels: webhookChannels,
            channelId: channel.id,
            patch: { signingSecret: null },
        }));
    }, [setWebhookChannels, webhookChannels]);

    const desktopPermissionSubtitle = React.useMemo(() => {
        switch (desktopNotificationPermission.status) {
            case 'checking':
                return t('settingsNotifications.desktop.permission.checkingSubtitle');
            case 'granted':
                return t('settingsNotifications.desktop.permission.grantedSubtitle');
            case 'error':
                return t('settingsNotifications.desktop.permission.errorSubtitle');
            case 'notGranted':
            default:
                return t('settingsNotifications.desktop.permission.notGrantedSubtitle');
        }
    }, [desktopNotificationPermission.status]);

    const desktopPermissionIconColor = desktopNotificationPermission.status === 'granted'
        ? theme.colors.state.success.foreground
        : desktopNotificationPermission.status === 'checking'
            ? theme.colors.text.secondary
            : theme.colors.state.neutral.foreground;

    return (
        <ItemList style={{ paddingTop: 0 }} testID="settings-notifications-screen">
            <ItemGroup
                title={t('settingsNotifications.badges.title')}
                footer={t('settingsNotifications.badges.footer')}
            >
                <Item
                    testID="settings-notifications-badges-enabled"
                    title={t('settingsNotifications.badges.enabledTitle')}
                    subtitle={t('settingsNotifications.badges.enabledSubtitle')}
                    icon={<Icon name="stack" size={29} color={theme.colors.accent.blue} />}
                    rightElement={(
                        <Switch
                            value={localSettings.activityBadgesEnabled !== false}
                            onValueChange={(value) => setLocalSetting({ activityBadgesEnabled: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.badges.unreadTitle')}
                    subtitle={t('settingsNotifications.badges.unreadSubtitle')}
                    icon={<Icon name="envelope-simple-open" size={29} color={theme.colors.text.secondary} />}
                    rightElement={(
                        <Switch
                            value={localSettings.activityBadgeShowUnread !== false}
                            disabled={localSettings.activityBadgesEnabled === false}
                            onValueChange={(value) => setLocalSetting({ activityBadgeShowUnread: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.badges.permissionRequestsTitle')}
                    subtitle={t('settingsNotifications.badges.permissionRequestsSubtitle')}
                    icon={<Icon name="hand" size={29} color={theme.colors.text.secondary} />}
                    rightElement={(
                        <Switch
                            value={localSettings.activityBadgeShowPendingPermissionRequests !== false}
                            disabled={localSettings.activityBadgesEnabled === false}
                            onValueChange={(value) => setLocalSetting({ activityBadgeShowPendingPermissionRequests: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.badges.userActionsTitle')}
                    subtitle={t('settingsNotifications.badges.userActionsSubtitle')}
                    icon={<Icon name="chat-dots" size={29} color={theme.colors.text.secondary} />}
                    rightElement={(
                        <Switch
                            value={localSettings.activityBadgeShowPendingUserActionRequests !== false}
                            disabled={localSettings.activityBadgesEnabled === false}
                            onValueChange={(value) => setLocalSetting({ activityBadgeShowPendingUserActionRequests: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.badges.queuedTitle')}
                    subtitle={t('settingsNotifications.badges.queuedSubtitle')}
                    icon={<Icon name="hourglass" size={29} color={theme.colors.text.secondary} />}
                    rightElement={(
                        <Switch
                            value={localSettings.activityBadgeShowQueuedUserInput !== false}
                            disabled={localSettings.activityBadgesEnabled === false}
                            onValueChange={(value) => setLocalSetting({ activityBadgeShowQueuedUserInput: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.badges.friendRequestsTitle')}
                    subtitle={t('settingsNotifications.badges.friendRequestsSubtitle')}
                    icon={<Icon name="users" size={29} color={theme.colors.text.secondary} />}
                    rightElement={(
                        <Switch
                            value={localSettings.activityBadgeShowFriendRequestsInboxCount !== false}
                            disabled={localSettings.activityBadgesEnabled === false}
                            onValueChange={(value) => setLocalSetting({ activityBadgeShowFriendRequestsInboxCount: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.badges.desktopDotTitle')}
                    subtitle={t('settingsNotifications.badges.desktopDotSubtitle')}
                    icon={<Icon name="circle" size={29} color={theme.colors.text.secondary} />}
                    rightElement={(
                        <Switch
                            value={localSettings.activityBadgeShowDesktopNonNumericDot !== false}
                            disabled={localSettings.activityBadgesEnabled === false}
                            onValueChange={(value) => setLocalSetting({ activityBadgeShowDesktopNonNumericDot: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsNotifications.local.title')}
                footer={t('settingsNotifications.local.footer')}
            >
                <Item
                    testID="settings-notifications-local-enabled"
                    title={t('common.enabled')}
                    subtitle={t('settingsNotifications.local.enabledSubtitle')}
                    icon={<Icon name="device-mobile" size={29} color={theme.colors.accent.blue} />}
                    rightElement={(
                        <Switch
                            value={localSettings.localNotificationsEnabled !== false}
                            onValueChange={(value) => {
                                const enabled = Boolean(value);
                                setLocalSetting({ localNotificationsEnabled: enabled });
                                // Browsers only show their permission prompt for a user gesture. The
                                // desktop app requests permission from its own diagnostics row.
                                if (enabled && !isDesktopNotificationsSupported) {
                                    fireAndForget(requestWebLocalNotificationPermission(), {
                                        tag: 'NotificationsSettingsView.requestWebLocalNotificationPermission',
                                    });
                                }
                            }}
                        />
                    )}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.local.readyTitle')}
                    subtitle={t('settingsNotifications.local.readySubtitle')}
                    icon={<Icon name="check-circle" size={29} color={theme.colors.state.success.foreground} />}
                    rightElement={(
                        <Switch
                            value={localSettings.localNotificationsShowReady !== false}
                            disabled={localSettings.localNotificationsEnabled === false}
                            onValueChange={(value) => setLocalSetting({ localNotificationsShowReady: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.local.readyPreviewTitle')}
                    subtitle={t('settingsNotifications.local.readyPreviewSubtitle')}
                    icon={<Icon name="chat-circle-dots" size={29} color={theme.colors.text.secondary} />}
                    rightElement={(
                        <Switch
                            value={localSettings.localNotificationsShowReadyMessageText !== false}
                            disabled={localSettings.localNotificationsEnabled === false || localSettings.localNotificationsShowReady === false}
                            onValueChange={(value) => setLocalSetting({ localNotificationsShowReadyMessageText: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.local.requestPreviewTitle')}
                    subtitle={t('settingsNotifications.local.requestPreviewSubtitle')}
                    icon={<Icon name="chat-circle-dots" size={29} color={theme.colors.text.secondary} />}
                    rightElement={(
                        <Switch
                            value={localSettings.localNotificationsShowRequestMessageText !== false}
                            disabled={localSettings.localNotificationsEnabled === false || (localSettings.localNotificationsShowPendingPermissionRequests === false && localSettings.localNotificationsShowPendingUserActionRequests === false)}
                            onValueChange={(value) => setLocalSetting({ localNotificationsShowRequestMessageText: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.local.permissionRequestsTitle')}
                    subtitle={t('settingsNotifications.local.permissionRequestsSubtitle')}
                    icon={<Icon name="hand" size={29} color={theme.colors.text.secondary} />}
                    rightElement={(
                        <Switch
                            value={localSettings.localNotificationsShowPendingPermissionRequests !== false}
                            disabled={localSettings.localNotificationsEnabled === false}
                            onValueChange={(value) => setLocalSetting({ localNotificationsShowPendingPermissionRequests: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.local.userActionsTitle')}
                    subtitle={t('settingsNotifications.local.userActionsSubtitle')}
                    icon={<Icon name="chat-dots" size={29} color={theme.colors.text.secondary} />}
                    rightElement={(
                        <Switch
                            value={localSettings.localNotificationsShowPendingUserActionRequests !== false}
                            disabled={localSettings.localNotificationsEnabled === false}
                            onValueChange={(value) => setLocalSetting({ localNotificationsShowPendingUserActionRequests: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
            </ItemGroup>

            {isDesktopNotificationsSupported ? (
                <ItemGroup
                    title={t('settingsNotifications.desktop.title')}
                    footer={t('settingsNotifications.desktop.footer')}
                >
                    <Item
                        testID="settings-notifications-desktop-permission"
                        title={t('settingsNotifications.desktop.permission.title')}
                        subtitle={desktopPermissionSubtitle}
                        icon={<Icon name="desktop" size={29} color={desktopPermissionIconColor} />}
                        onPress={desktopNotificationPermission.status === 'granted'
                            ? undefined
                            : () => { void desktopNotificationPermission.requestPermission(); }}
                        showChevron={desktopNotificationPermission.status !== 'granted'}
                    />
                </ItemGroup>
            ) : null}

            <ItemGroup
                title={t('settingsNotifications.push.title')}
                footer={t('settingsNotifications.push.footer')}
            >
                <Item
                    testID="settings-notifications-push-enabled"
                    title={t('common.enabled')}
                    subtitle={t('settingsNotifications.push.enabledSubtitle')}
                    icon={<Icon name="bell" size={29} color={theme.colors.accent.blue} />}
                    rightElement={(
                        <Switch
                            value={pushEnabled}
                            onValueChange={(value) => { void handlePushEnabledChange(Boolean(value)); }}
                        />
                    )}
                    showChevron={false}
                />
                <Item
                    testID="settings-notifications-mute-phone-focused-computer"
                    title={t('settingsNotifications.mutePhoneWhenComputerFocusedTitle')}
                    subtitle={t('settingsNotifications.mutePhoneWhenComputerFocusedSubtitle')}
                    disabled={!pushEnabled}
                    rightElement={<Switch
                        value={notifications.mutePhoneWhenComputerFocused === true}
                        disabled={!pushEnabled}
                        onValueChange={(value) => setNotifications({ mutePhoneWhenComputerFocused: Boolean(value) })}
                    />}
                    showChevron={false}
                />
                <Item
                    testID="settings-notifications-push-troubleshoot"
                    title={t('settingsNotifications.push.troubleshootTitle')}
                    subtitle={t('settingsNotifications.push.troubleshootSubtitle')}
                    icon={<Icon name="question" size={29} color={theme.colors.text.secondary} />}
                    onPress={openPushTroubleshooting}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsNotifications.webhooks.title')}
                footer={t('settingsNotifications.webhooks.footer')}
            >
                <Item
                    testID="settings-notifications-add-webhook"
                    title={t('settingsNotifications.webhooks.addTitle')}
                    subtitle={t('settingsNotifications.webhooks.addSubtitle')}
                    icon={<Icon name="plus-circle" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => { void handleAddWebhook(); }}
                    showChevron={false}
                />
                {webhookChannels.length === 0 ? (
                    <Item
                        title={t('settingsNotifications.webhooks.emptyTitle')}
                        subtitle={t('settingsNotifications.webhooks.emptySubtitle')}
                        icon={<Icon name="link" size={29} color={theme.colors.text.secondary} />}
                        showChevron={false}
                    />
                ) : (
                    webhookChannels.map((channel) => (
                        <React.Fragment key={channel.id}>
                            <Item
                                testID={`settings-notifications-webhook-${channel.id}`}
                                title={channel.url}
                                subtitle={channel.enabled
                                    ? t('settingsNotifications.webhooks.enabledSubtitle')
                                    : t('settingsNotifications.webhooks.disabledSubtitle')}
                                icon={<Icon name="link" size={29} color={theme.colors.accent.blue} />}
                                rightElement={(
                                    <ItemRowActions
                                        title={channel.url}
                                        compactActionIds={['edit', 'delete']}
                                        actions={[
                                            {
                                                id: 'edit',
                                                title: t('common.edit'),
                                                icon: 'pencil',
                                                onPress: () => { void handleEditWebhook(channel); },
                                            },
                                            {
                                                id: 'delete',
                                                title: t('common.delete'),
                                                icon: 'trash',
                                                destructive: true,
                                                onPress: () => { void handleDeleteWebhook(channel); },
                                            },
                                        ]}
                                    />
                                )}
                                showChevron={false}
                            />
                            <Item
                                title={t('settingsNotifications.webhooks.enabledTitle')}
                                subtitle={t('settingsNotifications.webhooks.channelEnabledSubtitle')}
                                icon={<Icon name="bell" size={29} color={theme.colors.text.secondary} />}
                                rightElement={(
                                    <Switch
                                        value={channel.enabled !== false}
                                        onValueChange={(value) => setWebhookChannels(updateNotificationChannelById({
                                            channels: webhookChannels,
                                            channelId: channel.id,
                                            patch: { enabled: Boolean(value) },
                                        }))}
                                    />
                                )}
                                showChevron={false}
                            />
                            <Item
                                title={t('settingsNotifications.webhooks.signingSecretTitle')}
                                subtitle={hasConfiguredSecretStringValue(channel.signingSecret)
                                    ? t('settingsNotifications.webhooks.signingSecretConfiguredSubtitle')
                                    : t('settingsNotifications.webhooks.signingSecretEmptySubtitle')}
                                icon={<Icon name="key" size={29} color={theme.colors.text.secondary} />}
                                onPress={() => { void handleSetWebhookSigningSecret(channel); }}
                                rightElement={hasConfiguredSecretStringValue(channel.signingSecret) ? (
                                    <ItemRowActions
                                        title={t('settingsNotifications.webhooks.signingSecretTitle')}
                                        compactActionIds={['clear-signing-secret']}
                                        actions={[
                                            {
                                                id: 'clear-signing-secret',
                                                title: t('settingsNotifications.webhooks.signingSecretClearAction'),
                                                icon: 'x-circle',
                                                onPress: () => { handleClearWebhookSigningSecret(channel); },
                                            },
                                        ]}
                                    />
                                ) : undefined}
                                showChevron={false}
                            />
                            <Item
                                title={t('settingsNotifications.webhooks.readyTitle')}
                                subtitle={t('settingsNotifications.webhooks.readySubtitle')}
                                icon={<Icon name="check-circle" size={29} color={theme.colors.state.success.foreground} />}
                                rightElement={(
                                    <Switch
                                        value={channel.topics.ready !== false}
                                        disabled={channel.enabled === false}
                                        onValueChange={(value) => setWebhookChannels(updateNotificationChannelById({
                                            channels: webhookChannels,
                                            channelId: channel.id,
                                            patch: {
                                                topics: {
                                                    ...channel.topics,
                                                    ready: Boolean(value),
                                                },
                                            },
                                        }))}
                                    />
                                )}
                                showChevron={false}
                            />
                            <Item
                                title={t('settingsNotifications.webhooks.readyPreviewTitle')}
                                subtitle={t('settingsNotifications.webhooks.readyPreviewSubtitle')}
                                icon={<Icon name="chat-circle-dots" size={29} color={theme.colors.text.secondary} />}
                                rightElement={(
                                    <Switch
                                        value={channel.readyIncludeMessageText !== false}
                                        disabled={channel.enabled === false || channel.topics.ready === false}
                                        onValueChange={(value) => setWebhookChannels(updateNotificationChannelById({
                                            channels: webhookChannels,
                                            channelId: channel.id,
                                            patch: { readyIncludeMessageText: Boolean(value) },
                                        }))}
                                    />
                                )}
                                showChevron={false}
                            />
                            <Item
                                title={t('settingsNotifications.webhooks.requestPreviewTitle')}
                                subtitle={t('settingsNotifications.webhooks.requestPreviewSubtitle')}
                                icon={<Icon name="chat-circle-dots" size={29} color={theme.colors.text.secondary} />}
                                rightElement={(
                                    <Switch
                                        value={channel.requestIncludeMessageText === true}
                                        disabled={channel.enabled === false || (channel.topics.permissionRequest === false && channel.topics.userActionRequest === false)}
                                        onValueChange={(value) => setWebhookChannels(updateNotificationChannelById({
                                            channels: webhookChannels,
                                            channelId: channel.id,
                                            patch: { requestIncludeMessageText: Boolean(value) },
                                        }))}
                                    />
                                )}
                                showChevron={false}
                            />
                            <Item
                                title={t('settingsNotifications.webhooks.permissionRequestsTitle')}
                                subtitle={t('settingsNotifications.webhooks.permissionRequestsSubtitle')}
                                icon={<Icon name="hand" size={29} color={theme.colors.text.secondary} />}
                                rightElement={(
                                    <Switch
                                        value={channel.topics.permissionRequest !== false}
                                        disabled={channel.enabled === false}
                                        onValueChange={(value) => setWebhookChannels(updateNotificationChannelById({
                                            channels: webhookChannels,
                                            channelId: channel.id,
                                            patch: {
                                                topics: {
                                                    ...channel.topics,
                                                    permissionRequest: Boolean(value),
                                                },
                                            },
                                        }))}
                                    />
                                )}
                                showChevron={false}
                            />
                            <Item
                                title={t('settingsNotifications.webhooks.userActionsTitle')}
                                subtitle={t('settingsNotifications.webhooks.userActionsSubtitle')}
                                icon={<Icon name="chat-dots" size={29} color={theme.colors.text.secondary} />}
                                rightElement={(
                                    <Switch
                                        value={channel.topics.userActionRequest !== false}
                                        disabled={channel.enabled === false}
                                        onValueChange={(value) => setWebhookChannels(updateNotificationChannelById({
                                            channels: webhookChannels,
                                            channelId: channel.id,
                                            patch: {
                                                topics: {
                                                    ...channel.topics,
                                                    userActionRequest: Boolean(value),
                                                },
                                            },
                                        }))}
                                    />
                                )}
                                showChevron={false}
                            />
                            {showConnectedServiceNotificationTopics ? (
                                <>
                                    {showConnectedServiceAccountSwitchNotifications ? (
                                        <Item
                                            testID={`settings-notifications-webhook-topic:${channel.id}:connectedServiceAccountSwitch`}
                                            title={t('settingsNotifications.connectedServices.accountSwitch.title')}
                                            subtitle={t('settingsNotifications.connectedServices.accountSwitch.subtitle')}
                                            icon={<Icon name="arrows-left-right" size={29} color={theme.colors.text.secondary} />}
                                            rightElement={(
                                                <Switch
                                                    value={channel.topics.connectedServiceAccountSwitch !== false}
                                                    disabled={channel.enabled === false}
                                                    onValueChange={(value) => setWebhookTopic(channel, 'connectedServiceAccountSwitch', Boolean(value))}
                                                />
                                            )}
                                            showChevron={false}
                                        />
                                    ) : null}
                                    {showConnectedServiceQuotaNotifications ? (
                                        <>
                                            <Item
                                                testID={`settings-notifications-webhook-topic:${channel.id}:connectedServiceQuotaBlocked`}
                                                title={t('settingsNotifications.connectedServices.quotaBlocked.title')}
                                                subtitle={t('settingsNotifications.connectedServices.quotaBlocked.subtitle')}
                                                icon={<Icon name="timer" size={29} color={theme.colors.text.secondary} />}
                                                rightElement={(
                                                    <Switch
                                                        value={channel.topics.connectedServiceQuotaBlocked !== false}
                                                        disabled={channel.enabled === false}
                                                        onValueChange={(value) => setWebhookTopic(channel, 'connectedServiceQuotaBlocked', Boolean(value))}
                                                    />
                                                )}
                                                showChevron={false}
                                            />
                                            <Item
                                                testID={`settings-notifications-webhook-topic:${channel.id}:connectedServiceQuotaRecovered`}
                                                title={t('settingsNotifications.connectedServices.quotaRecovered.title')}
                                                subtitle={t('settingsNotifications.connectedServices.quotaRecovered.subtitle')}
                                                icon={<Icon name="check-circle" size={29} color={theme.colors.text.secondary} />}
                                                rightElement={(
                                                    <Switch
                                                        value={channel.topics.connectedServiceQuotaBlocked !== false && channel.topics.connectedServiceQuotaRecovered !== false}
                                                        disabled={channel.enabled === false || channel.topics.connectedServiceQuotaBlocked === false}
                                                        onValueChange={(value) => setWebhookTopic(channel, 'connectedServiceQuotaRecovered', Boolean(value))}
                                                    />
                                                )}
                                                showChevron={false}
                                            />
                                        </>
                                    ) : null}
                                </>
                            ) : null}
                        </React.Fragment>
                    ))
                )}
            </ItemGroup>

            {showConnectedServiceNotificationTopics ? (
                <ItemGroup
                    title={t('settingsNotifications.connectedServices.title')}
                    footer={t('settingsNotifications.connectedServices.footer')}
                >
                    {showConnectedServiceAccountSwitchNotifications ? (
                        <Item
                            testID="settings-notifications-connected-service-account-switch"
                            title={t('settingsNotifications.connectedServices.accountSwitch.title')}
                            subtitle={t('settingsNotifications.connectedServices.accountSwitch.subtitle')}
                            icon={<Icon name="arrows-left-right" size={29} color={theme.colors.text.secondary} />}
                            rightElement={(
                                <Switch
                                    value={notifications.connectedServiceAccountSwitch !== false}
                                    disabled={!pushEnabled}
                                    onValueChange={(value) => setNotificationTopic('connectedServiceAccountSwitch', Boolean(value))}
                                />
                            )}
                            showChevron={false}
                        />
                    ) : null}
                    {showConnectedServiceQuotaNotifications ? (
                        <>
                            <Item
                                testID="settings-notifications-connected-service-quota-blocked"
                                title={t('settingsNotifications.connectedServices.quotaBlocked.title')}
                                subtitle={t('settingsNotifications.connectedServices.quotaBlocked.subtitle')}
                                icon={<Icon name="timer" size={29} color={theme.colors.text.secondary} />}
                                rightElement={(
                                    <Switch
                                        value={notifications.connectedServiceQuotaBlocked !== false}
                                        disabled={!pushEnabled}
                                        onValueChange={(value) => setNotificationTopic('connectedServiceQuotaBlocked', Boolean(value))}
                                    />
                                )}
                                showChevron={false}
                            />
                            <Item
                                testID="settings-notifications-connected-service-quota-recovered"
                                title={t('settingsNotifications.connectedServices.quotaRecovered.title')}
                                subtitle={t('settingsNotifications.connectedServices.quotaRecovered.subtitle')}
                                icon={<Icon name="check-circle" size={29} color={theme.colors.text.secondary} />}
                                rightElement={(
                                    <Switch
                                        value={notifications.connectedServiceQuotaBlocked !== false && notifications.connectedServiceQuotaRecovered !== false}
                                        disabled={!pushEnabled || notifications.connectedServiceQuotaBlocked === false}
                                        onValueChange={(value) => setNotificationTopic('connectedServiceQuotaRecovered', Boolean(value))}
                                    />
                                )}
                                showChevron={false}
                            />
                        </>
                    ) : null}
                </ItemGroup>
            ) : null}

            <ItemGroup
                title={t('settingsNotifications.types.title')}
                footer={t('settingsNotifications.types.footer')}
            >
                <Item
                    title={t('settingsNotifications.types.ready.title')}
                    subtitle={t('settingsNotifications.types.ready.subtitle')}
                    icon={<Icon name="check-circle" size={29} color={theme.colors.state.success.foreground} />}
                    rightElement={(
                        <Switch
                            value={notifications.ready !== false}
                            disabled={!pushEnabled}
                            onValueChange={(value) => setNotifications({ ready: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.types.readyPreview.title')}
                    subtitle={t('settingsNotifications.types.readyPreview.subtitle')}
                    icon={<Icon name="chat-circle-dots" size={29} color={theme.colors.text.secondary} />}
                    rightElement={(
                        <Switch
                            value={notifications.readyIncludeMessageText !== false}
                            disabled={!pushEnabled || notifications.ready === false}
                            onValueChange={(value) => setNotifications({ readyIncludeMessageText: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.types.requestPreview.title')}
                    subtitle={t('settingsNotifications.types.requestPreview.subtitle')}
                    icon={<Icon name="chat-circle-dots" size={29} color={theme.colors.text.secondary} />}
                    rightElement={(
                        <Switch
                            value={notifications.requestIncludeMessageText === true}
                            disabled={!pushEnabled || (notifications.permissionRequest === false && notifications.userActionRequest === false)}
                            onValueChange={(value) => setNotifications({ requestIncludeMessageText: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.types.permissionRequests.title')}
                    subtitle={t('settingsNotifications.types.permissionRequests.subtitle')}
                    icon={<Icon name="hand" size={29} color={theme.colors.text.secondary} />}
                    rightElement={(
                        <Switch
                            value={notifications.permissionRequest !== false}
                            disabled={!pushEnabled}
                            onValueChange={(value) => setNotifications({ permissionRequest: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.types.userActions.title')}
                    subtitle={t('settingsNotifications.types.userActions.subtitle')}
                    icon={<Icon name="chat-dots" size={29} color={theme.colors.text.secondary} />}
                    rightElement={(
                        <Switch
                            value={notifications.userActionRequest !== false}
                            disabled={!pushEnabled}
                            onValueChange={(value) => setNotifications({ userActionRequest: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsNotifications.foregroundBehavior.title')}
                footer={t('settingsNotifications.foregroundBehavior.footer')}
            >
                <Item
                    title={t('settingsNotifications.foregroundBehavior.full')}
                    subtitle={t('settingsNotifications.foregroundBehavior.fullDescription')}
                    icon={<Icon name="speaker-high" size={29} color={theme.colors.accent.blue} />}
                    selected={localSettings.localNotificationsForegroundBehavior === 'full'}
                    disabled={localSettings.localNotificationsEnabled === false}
                    onPress={() => setLocalSetting({ localNotificationsForegroundBehavior: 'full' })}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.foregroundBehavior.silent')}
                    subtitle={t('settingsNotifications.foregroundBehavior.silentDescription')}
                    icon={<Icon name="speaker-slash" size={29} color={theme.colors.accent.blue} />}
                    selected={localSettings.localNotificationsForegroundBehavior === 'silent'}
                    disabled={localSettings.localNotificationsEnabled === false}
                    onPress={() => setLocalSetting({ localNotificationsForegroundBehavior: 'silent' })}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.foregroundBehavior.off')}
                    subtitle={t('settingsNotifications.foregroundBehavior.offDescription')}
                    icon={<Icon name="bell-slash" size={29} color={theme.colors.accent.blue} />}
                    selected={localSettings.localNotificationsForegroundBehavior === 'off'}
                    disabled={localSettings.localNotificationsEnabled === false}
                    onPress={() => setLocalSetting({ localNotificationsForegroundBehavior: 'off' })}
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
});
