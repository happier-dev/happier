import {
    BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
    NotificationChannelsV1Schema,
    WebhookNotificationChannelV1Schema,
    AttentionDeliveryPolicyV1Schema,
    deriveAttentionDeliveryPolicyFromLegacySettings,
    type AttentionDeliveryPolicyV1,
    type NotificationChannelV1,
    type NotificationChannelsV1,
    type NotificationsSettingsV1,
    type WebhookNotificationChannelV1,
} from '@happier-dev/protocol';

const LEGACY_NOTIFICATION_EVENT_IDS = [
    'ready',
    'permission_request',
    'user_action_request',
] as const;

type AttentionDeliveryEventConfig = AttentionDeliveryPolicyV1['events'][string];
type AttentionDeliveryChannelConfig = AttentionDeliveryPolicyV1['channels'][string];

function isLegacyNotificationEventEnabled(
    policy: AttentionDeliveryPolicyV1,
    eventId: typeof LEGACY_NOTIFICATION_EVENT_IDS[number],
): boolean {
    return (
        policy.events[eventId]?.enabled !== false
        && policy.channels.expo_push.events[eventId]?.enabled !== false
    );
}

function buildLegacyNotificationsMirrorFromPolicy(policy: AttentionDeliveryPolicyV1): NotificationsSettingsV1 {
    const readyPreviewBehavior =
        policy.channels.expo_push.events.ready?.previewBehavior
        ?? policy.events.ready?.previewBehavior
        ?? policy.channels.expo_push.previewBehavior
        ?? policy.privacy.surfaces.expo_push
        ?? policy.privacy.defaultPreviewBehavior;
    return {
        v: 1,
        pushEnabled: policy.channels.expo_push.enabled !== false,
        ready: isLegacyNotificationEventEnabled(policy, 'ready'),
        readyIncludeMessageText: readyPreviewBehavior === 'include_preview',
        permissionRequest: isLegacyNotificationEventEnabled(policy, 'permission_request'),
        userActionRequest: isLegacyNotificationEventEnabled(policy, 'user_action_request'),
        connectedServiceAccountSwitch: policy.events.connected_service_account_switch?.enabled !== false
            && policy.channels.expo_push.events.connected_service_account_switch?.enabled !== false,
        connectedServiceQuotaBlocked: policy.events.connected_service_quota_blocked?.enabled !== false
            && policy.channels.expo_push.events.connected_service_quota_blocked?.enabled !== false,
        connectedServiceQuotaRecovered: policy.events.connected_service_quota_recovered?.enabled !== false
            && policy.channels.expo_push.events.connected_service_quota_recovered?.enabled !== false,
        foregroundBehavior: policy.foregroundBehavior,
    };
}

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

export function buildWebhookNotificationSettingsDelta({
    basePolicy,
    webhookChannels,
}: {
    basePolicy: AttentionDeliveryPolicyV1;
    webhookChannels: ReadonlyArray<NotificationChannelV1>;
}): {
    notificationChannelsV1: NotificationChannelsV1;
    attentionDeliveryPolicyV1: AttentionDeliveryPolicyV1;
} {
    const policy = AttentionDeliveryPolicyV1Schema.parse(basePolicy);
    const notifications = buildLegacyNotificationsMirrorFromPolicy(policy);
    const expoChannel = {
        v: 1 as const,
        id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
        kind: 'expo_push' as const,
        enabled: notifications.pushEnabled,
        topics: {
            ready: notifications.ready,
            permissionRequest: notifications.permissionRequest,
            userActionRequest: notifications.userActionRequest,
        },
        readyIncludeMessageText: notifications.readyIncludeMessageText,
    };
    const notificationChannels = NotificationChannelsV1Schema.parse([
        expoChannel,
        ...webhookChannels.filter((channel) => channel.id !== BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID),
    ]);
    const derivedPolicy = deriveAttentionDeliveryPolicyFromLegacySettings({
        notificationsSettings: notifications,
        notificationChannels,
    });

    const attentionDeliveryPolicyV1 = mergeLegacyNotificationMirrorIntoPolicy({
        basePolicy: policy,
        derivedPolicy,
    });

    return {
        notificationChannelsV1: notificationChannels,
        attentionDeliveryPolicyV1,
    };
}

function mergeLegacyEventEnabled(
    base: AttentionDeliveryEventConfig,
    derived: AttentionDeliveryEventConfig,
): AttentionDeliveryEventConfig {
    return {
        ...base,
        enabled: derived.enabled,
    };
}

function mergeLegacyChannelMirror(
    base: AttentionDeliveryChannelConfig,
    derived: AttentionDeliveryChannelConfig,
): AttentionDeliveryChannelConfig {
    const events = { ...base.events };
    for (const eventId of LEGACY_NOTIFICATION_EVENT_IDS) {
        events[eventId] = mergeLegacyEventEnabled(base.events[eventId], derived.events[eventId]);
    }

    return {
        ...base,
        enabled: derived.enabled,
        previewBehavior: derived.previewBehavior,
        events,
    };
}

function mergeLegacyNotificationMirrorIntoPolicy(params: Readonly<{
    basePolicy: AttentionDeliveryPolicyV1;
    derivedPolicy: AttentionDeliveryPolicyV1;
}>): AttentionDeliveryPolicyV1 {
    const basePolicy = AttentionDeliveryPolicyV1Schema.parse(params.basePolicy);
    const derivedPolicy = params.derivedPolicy;
    const events = { ...basePolicy.events };
    for (const eventId of LEGACY_NOTIFICATION_EVENT_IDS) {
        events[eventId] = mergeLegacyEventEnabled(basePolicy.events[eventId], derivedPolicy.events[eventId]);
    }

    return AttentionDeliveryPolicyV1Schema.parse({
        ...basePolicy,
        events,
        channels: {
            ...basePolicy.channels,
            expo_push: mergeLegacyChannelMirror(basePolicy.channels.expo_push, derivedPolicy.channels.expo_push),
            webhook: mergeLegacyChannelMirror(basePolicy.channels.webhook, derivedPolicy.channels.webhook),
        },
    });
}
