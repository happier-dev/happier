import {
    BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
    NotificationChannelsV1Schema,
    WebhookNotificationChannelV1Schema,
    deriveExpoPushNotificationChannelFromLegacySettings,
    type NotificationChannelV1,
    type NotificationChannelsV1,
    type NotificationsSettingsV1,
    type WebhookNotificationChannelV1,
} from '@happier-dev/protocol';

function slugifyWebhookChannelId(url: string): string {
    const slug = url
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

    return slug.length > 0 ? `webhook-${slug}` : 'webhook';
}

function ensureUniqueChannelId(channels: ReadonlyArray<NotificationChannelV1>, baseId: string): string {
    const used = new Set(channels.map((channel) => channel.id));
    if (!used.has(baseId)) {
        return baseId;
    }

    let nextIndex = 2;
    while (used.has(`${baseId}-${nextIndex}`)) {
        nextIndex += 1;
    }
    return `${baseId}-${nextIndex}`;
}

export function addWebhookNotificationChannel({
    channels,
    url,
}: {
    channels: ReadonlyArray<NotificationChannelV1>;
    url: string;
}): NotificationChannelsV1 {
    const nextChannel = WebhookNotificationChannelV1Schema.parse({
        v: 1,
        id: ensureUniqueChannelId(channels, slugifyWebhookChannelId(url)),
        kind: 'webhook',
        enabled: true,
        url: url.trim(),
        signingSecret: null,
        topics: {
            ready: true,
            permissionRequest: true,
            userActionRequest: true,
        },
        readyIncludeMessageText: false,
    });

    return NotificationChannelsV1Schema.parse([
        ...channels.filter((channel) => channel.kind !== 'webhook'),
        ...channels.filter((channel) => channel.kind === 'webhook'),
        nextChannel,
    ]);
}

export function updateNotificationChannelById({
    channels,
    channelId,
    patch,
}: {
    channels: ReadonlyArray<NotificationChannelV1>;
    channelId: string;
    patch: Partial<WebhookNotificationChannelV1>;
}): NotificationChannelsV1 {
    return NotificationChannelsV1Schema.parse(
        channels.map((channel) => {
            if (channel.id !== channelId || channel.kind !== 'webhook') {
                return channel;
            }

            return WebhookNotificationChannelV1Schema.parse({
                ...channel,
                ...patch,
            });
        }),
    );
}

export function removeNotificationChannelById({
    channels,
    channelId,
}: {
    channels: ReadonlyArray<NotificationChannelV1>;
    channelId: string;
}): NotificationChannelsV1 {
    return NotificationChannelsV1Schema.parse(channels.filter((channel) => channel.id !== channelId));
}

export function buildNotificationSettingsDelta({
    notifications,
    webhookChannels,
}: {
    notifications: NotificationsSettingsV1;
    webhookChannels: ReadonlyArray<NotificationChannelV1>;
}): {
    notificationsSettingsV1: NotificationsSettingsV1;
    notificationChannelsV1: NotificationChannelsV1;
} {
    const expoChannel = deriveExpoPushNotificationChannelFromLegacySettings(notifications);

    return {
        notificationsSettingsV1: notifications,
        notificationChannelsV1: NotificationChannelsV1Schema.parse([
            expoChannel,
            ...webhookChannels.filter((channel) => channel.id !== BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID),
        ]),
    };
}
