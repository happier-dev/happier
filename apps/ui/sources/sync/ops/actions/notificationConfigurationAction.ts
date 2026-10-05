import {
    accountSettingsParse, hasConfiguredSecretStringValue, resolveNotificationChannelsV1FromAccountSettings,
    NotificationConfigurationActionInputSchemas, type ActionExecutorDeps,
} from '@happier-dev/protocol';
import {
    addWebhookNotificationChannel, updateNotificationChannelById, removeNotificationChannelById,
    buildWebhookNotificationSettingsDelta,
} from '@/components/settings/notifications/notificationChannels';
import type { LazyActionAccountContext } from './actionAccountContext';

/** Domain edits use the same channel reducers and policy mirror as the notification settings view. */
export function createNotificationConfigurationAction(account: Pick<LazyActionAccountContext, 'assertCurrent' | 'readSettings' | 'mutateRawSettings'> | null): NonNullable<ActionExecutorDeps['notificationConfigurationAction']> {
    return async ({ actionId, input, context }) => {
        context.signal?.throwIfAborted();
        if (!account) return { ok: false, errorCode: 'action_account_scope_unavailable', error: 'action_account_scope_unavailable' };
        account.assertCurrent();
        if (actionId === 'notifications.webhooks.list') {
            const settings = await account.readSettings();
            account.assertCurrent();
            return { items: resolveNotificationChannelsV1FromAccountSettings(settings).flatMap(channel => channel.kind !== 'webhook' ? [] : [{
                channelId: channel.id, url: channel.url, enabled: channel.enabled !== false,
                signingSecretConfigured: hasConfiguredSecretStringValue(channel.signingSecret),
                topics: { ready: channel.topics.ready !== false, permissionRequest: channel.topics.permissionRequest !== false,
                    userActionRequest: channel.topics.userActionRequest !== false },
                readyIncludeMessageText: channel.readyIncludeMessageText !== false,
                requestIncludeMessageText: channel.requestIncludeMessageText === true,
            }]) };
        }
        let channelId = '';
        try {
          await account.mutateRawSettings(raw => {
            context.signal?.throwIfAborted();
            account.assertCurrent();
            const channels = resolveNotificationChannelsV1FromAccountSettings(raw);
            let next = channels;
            if (actionId === 'notifications.webhooks.add') {
                const { url } = NotificationConfigurationActionInputSchemas[actionId].parse(input);
                next = addWebhookNotificationChannel({ channels, url });
                channelId = next.find(channel => !channels.some(previous => previous.id === channel.id))!.id;
            } else {
                const target = NotificationConfigurationActionInputSchemas[actionId].parse(input);
                channelId = target.channelId;
                const channel = channels.find(candidate => candidate.id === channelId && candidate.kind === 'webhook');
                if (!channel || channel.kind !== 'webhook') throw new WebhookNotFoundError();
                if (actionId === 'notifications.webhooks.remove') {
                    next = removeNotificationChannelById({ channels, channelId });
                } else {
                    const patch = actionId === 'notifications.webhooks.update'
                        ? NotificationConfigurationActionInputSchemas[actionId].parse(input).patch
                        : actionId === 'notifications.webhooks.signingSecret.set'
                            ? { signingSecret: { _isSecretValue: true as const, value: NotificationConfigurationActionInputSchemas[actionId].parse(input).secret } }
                            : { signingSecret: null };
                    next = updateNotificationChannelById({ channels, channelId, patch: {
                        ...patch, topics: 'topics' in patch && patch.topics ? { ...channel.topics, ...patch.topics } : channel.topics,
                    } });
                }
            }
            return { ...raw, ...buildWebhookNotificationSettingsDelta({
                basePolicy: accountSettingsParse(raw).attentionDeliveryPolicyV1, webhookChannels: next,
            }) };
          });
        } catch (error) {
            if (error instanceof WebhookNotFoundError) return { ok: false, errorCode: 'notification_webhook_not_found', error: 'notification_webhook_not_found' };
            throw error;
        }
        account.assertCurrent();
        context.signal?.throwIfAborted();
        return { channelId };
    };
}

class WebhookNotFoundError extends Error {}
