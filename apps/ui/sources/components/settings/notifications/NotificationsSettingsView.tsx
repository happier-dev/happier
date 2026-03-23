import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { Switch } from '@/components/ui/forms/Switch';
import { Modal } from '@/modal';

import { useLocalSettings, useSettings } from '@/sync/domains/state/storage';
import { useApplyLocalSettings, useApplySettings } from '@/sync/store/settingsWriters';
import { t } from '@/text';

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

type ForegroundBehavior = 'full' | 'silent' | 'off';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const NotificationsSettingsView = React.memo(function NotificationsSettingsView() {
    const { theme } = useUnistyles();
    const settings = useSettings();
    const localSettings = useLocalSettings();
    const applySettings = useApplySettings();
    const applyLocalSettings = useApplyLocalSettings();

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

    const setWebhookChannels = React.useCallback((nextChannels: ReadonlyArray<NotificationChannelV1>) => {
        applyRemoteNotificationSettings(notifications, nextChannels);
    }, [applyRemoteNotificationSettings, notifications]);

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
                    icon={<Ionicons name="albums-outline" size={29} color={theme.colors.accent.blue} />}
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
                    icon={<Ionicons name="mail-unread-outline" size={29} color={theme.colors.textSecondary} />}
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
                    icon={<Ionicons name="hand-left-outline" size={29} color={theme.colors.textSecondary} />}
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
                    icon={<Ionicons name="chatbox-ellipses-outline" size={29} color={theme.colors.textSecondary} />}
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
                    icon={<Ionicons name="hourglass-outline" size={29} color={theme.colors.textSecondary} />}
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
                    icon={<Ionicons name="people-outline" size={29} color={theme.colors.textSecondary} />}
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
                    icon={<Ionicons name="ellipse-outline" size={29} color={theme.colors.textSecondary} />}
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
                    icon={<Ionicons name="phone-portrait-outline" size={29} color={theme.colors.accent.blue} />}
                    rightElement={(
                        <Switch
                            value={localSettings.localNotificationsEnabled !== false}
                            onValueChange={(value) => setLocalSetting({ localNotificationsEnabled: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.local.readyTitle')}
                    subtitle={t('settingsNotifications.local.readySubtitle')}
                    icon={<Ionicons name="checkmark-circle-outline" size={29} color={theme.colors.success} />}
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
                    icon={<Ionicons name="chatbubble-ellipses-outline" size={29} color={theme.colors.textSecondary} />}
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
                    title={t('settingsNotifications.local.permissionRequestsTitle')}
                    subtitle={t('settingsNotifications.local.permissionRequestsSubtitle')}
                    icon={<Ionicons name="hand-left-outline" size={29} color={theme.colors.textSecondary} />}
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
                    icon={<Ionicons name="chatbox-ellipses-outline" size={29} color={theme.colors.textSecondary} />}
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

            <ItemGroup
                title={t('settingsNotifications.push.title')}
                footer={t('settingsNotifications.push.footer')}
            >
                <Item
                    testID="settings-notifications-push-enabled"
                    title={t('common.enabled')}
                    subtitle={t('settingsNotifications.push.enabledSubtitle')}
                    icon={<Ionicons name="notifications-outline" size={29} color={theme.colors.accent.blue} />}
                    rightElement={(
                        <Switch
                            value={pushEnabled}
                            onValueChange={(value) => setNotifications({ pushEnabled: Boolean(value) })}
                        />
                    )}
                    showChevron={false}
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
                    icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => { void handleAddWebhook(); }}
                    showChevron={false}
                />
                {webhookChannels.length === 0 ? (
                    <Item
                        title={t('settingsNotifications.webhooks.emptyTitle')}
                        subtitle={t('settingsNotifications.webhooks.emptySubtitle')}
                        icon={<Ionicons name="link-outline" size={29} color={theme.colors.textSecondary} />}
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
                                icon={<Ionicons name="link-outline" size={29} color={theme.colors.accent.blue} />}
                                rightElement={(
                                    <ItemRowActions
                                        title={channel.url}
                                        compactActionIds={['edit', 'delete']}
                                        actions={[
                                            {
                                                id: 'edit',
                                                title: t('common.edit'),
                                                icon: 'pencil-outline',
                                                onPress: () => { void handleEditWebhook(channel); },
                                            },
                                            {
                                                id: 'delete',
                                                title: t('common.delete'),
                                                icon: 'trash-outline',
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
                                icon={<Ionicons name="notifications-outline" size={29} color={theme.colors.textSecondary} />}
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
                                icon={<Ionicons name="key-outline" size={29} color={theme.colors.textSecondary} />}
                                onPress={() => { void handleSetWebhookSigningSecret(channel); }}
                                rightElement={hasConfiguredSecretStringValue(channel.signingSecret) ? (
                                    <ItemRowActions
                                        title={t('settingsNotifications.webhooks.signingSecretTitle')}
                                        compactActionIds={['clear-signing-secret']}
                                        actions={[
                                            {
                                                id: 'clear-signing-secret',
                                                title: t('settingsNotifications.webhooks.signingSecretClearAction'),
                                                icon: 'close-circle-outline',
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
                                icon={<Ionicons name="checkmark-circle-outline" size={29} color={theme.colors.success} />}
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
                                icon={<Ionicons name="chatbubble-ellipses-outline" size={29} color={theme.colors.textSecondary} />}
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
                                title={t('settingsNotifications.webhooks.permissionRequestsTitle')}
                                subtitle={t('settingsNotifications.webhooks.permissionRequestsSubtitle')}
                                icon={<Ionicons name="hand-left-outline" size={29} color={theme.colors.textSecondary} />}
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
                                icon={<Ionicons name="chatbox-ellipses-outline" size={29} color={theme.colors.textSecondary} />}
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
                        </React.Fragment>
                    ))
                )}
            </ItemGroup>

            <ItemGroup
                title={t('settingsNotifications.types.title')}
                footer={t('settingsNotifications.types.footer')}
            >
                <Item
                    title={t('settingsNotifications.types.ready.title')}
                    subtitle={t('settingsNotifications.types.ready.subtitle')}
                    icon={<Ionicons name="checkmark-circle-outline" size={29} color={theme.colors.success} />}
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
                    icon={<Ionicons name="chatbubble-ellipses-outline" size={29} color={theme.colors.textSecondary} />}
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
                    title={t('settingsNotifications.types.permissionRequests.title')}
                    subtitle={t('settingsNotifications.types.permissionRequests.subtitle')}
                    icon={<Ionicons name="hand-left-outline" size={29} color={theme.colors.textSecondary} />}
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
                    icon={<Ionicons name="chatbox-ellipses-outline" size={29} color={theme.colors.textSecondary} />}
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
                    icon={<Ionicons name="volume-high-outline" size={29} color={theme.colors.accent.blue} />}
                    selected={localSettings.localNotificationsForegroundBehavior === 'full'}
                    disabled={localSettings.localNotificationsEnabled === false}
                    onPress={() => setLocalSetting({ localNotificationsForegroundBehavior: 'full' })}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.foregroundBehavior.silent')}
                    subtitle={t('settingsNotifications.foregroundBehavior.silentDescription')}
                    icon={<Ionicons name="volume-off-outline" size={29} color={theme.colors.accent.blue} />}
                    selected={localSettings.localNotificationsForegroundBehavior === 'silent'}
                    disabled={localSettings.localNotificationsEnabled === false}
                    onPress={() => setLocalSetting({ localNotificationsForegroundBehavior: 'silent' })}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.foregroundBehavior.off')}
                    subtitle={t('settingsNotifications.foregroundBehavior.offDescription')}
                    icon={<Ionicons name="notifications-off-outline" size={29} color={theme.colors.accent.blue} />}
                    selected={localSettings.localNotificationsForegroundBehavior === 'off'}
                    disabled={localSettings.localNotificationsEnabled === false}
                    onPress={() => setLocalSetting({ localNotificationsForegroundBehavior: 'off' })}
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
});
