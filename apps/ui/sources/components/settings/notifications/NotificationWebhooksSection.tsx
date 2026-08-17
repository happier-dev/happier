import * as React from 'react';

import { useUnistyles } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { Modal } from '@/modal';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import {
    hasConfiguredSecretStringValue,
    type NotificationChannelV1,
    type WebhookNotificationChannelV1,
} from '@happier-dev/protocol';

import {
    addWebhookNotificationChannel,
    removeNotificationChannelById,
    updateNotificationChannelById,
} from './notificationChannels';

type NotificationWebhooksSectionProps = Readonly<{
    webhookChannels: ReadonlyArray<WebhookNotificationChannelV1>;
    setWebhookChannels: (nextChannels: ReadonlyArray<NotificationChannelV1>) => void;
}>;

export function NotificationWebhooksSection({
    webhookChannels,
    setWebhookChannels,
}: NotificationWebhooksSectionProps): React.ReactElement {
    const { theme } = useUnistyles();

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
                    </React.Fragment>
                ))
            )}
        </ItemGroup>
    );
}
