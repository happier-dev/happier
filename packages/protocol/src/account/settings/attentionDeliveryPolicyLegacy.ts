import type { NotificationChannelsV1 } from './notificationChannels.js';
import {
  AttentionDeliveryEventIdSchema,
  AttentionDeliveryPolicyV1Schema,
  normalizeAttentionDeliveryEventId,
  type AttentionDeliveryEventId,
  type AttentionDeliveryPolicyV1,
} from './attentionDeliveryPolicy.js';

type LegacyNotificationsSettings = {
  pushEnabled?: boolean;
  ready?: boolean;
  readyIncludeMessageText?: boolean;
  permissionRequest?: boolean;
  userActionRequest?: boolean;
  connectedServiceAccountSwitch?: boolean;
  connectedServiceQuotaBlocked?: boolean;
  connectedServiceQuotaRecovered?: boolean;
  foregroundBehavior?: 'full' | 'silent' | 'off';
};

const NOTIFICATION_CHANNEL_EVENT_IDS = [
  'ready',
  'permission_request',
  'user_action_request',
  'connected_service_account_switch',
  'connected_service_quota_blocked',
  'connected_service_quota_recovered',
] as const satisfies ReadonlyArray<AttentionDeliveryEventId>;

function eventEnabledFromLegacySettings(
  settings: Readonly<LegacyNotificationsSettings>,
  eventId: AttentionDeliveryEventId,
): boolean {
  if (eventId === 'ready') return settings.ready !== false;
  if (eventId === 'permission_request') return settings.permissionRequest !== false;
  if (eventId === 'user_action_request') return settings.userActionRequest !== false;
  if (eventId === 'connected_service_account_switch') return settings.connectedServiceAccountSwitch !== false;
  if (eventId === 'connected_service_quota_blocked') return settings.connectedServiceQuotaBlocked !== false;
  if (eventId === 'connected_service_quota_recovered') return settings.connectedServiceQuotaRecovered !== false;
  return true;
}

function eventIdFromChannelTopic(topic: string): AttentionDeliveryEventId | null {
  const normalized = normalizeAttentionDeliveryEventId(topic);
  const parsed = AttentionDeliveryEventIdSchema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
}

export function deriveAttentionDeliveryPolicyFromLegacySettings(params: {
  notificationsSettings: Readonly<LegacyNotificationsSettings>;
  notificationChannels: Readonly<NotificationChannelsV1>;
}): AttentionDeliveryPolicyV1 {
  const notificationsSettings = params.notificationsSettings;
  const policy = AttentionDeliveryPolicyV1Schema.parse({
    foregroundBehavior: notificationsSettings.foregroundBehavior ?? 'full',
  });

  const events = { ...policy.events };
  for (const id of AttentionDeliveryEventIdSchema.options) {
    events[id] = {
      ...events[id],
      enabled: eventEnabledFromLegacySettings(notificationsSettings, id),
    };
  }

  const channels = { ...policy.channels };
  channels.expo_push = {
    ...channels.expo_push,
    enabled: notificationsSettings.pushEnabled !== false,
    previewBehavior: notificationsSettings.readyIncludeMessageText === false ? 'status_only' : 'include_preview',
    events: {
      ...channels.expo_push.events,
      ready: { ...channels.expo_push.events.ready, enabled: notificationsSettings.ready !== false },
      permission_request: {
        ...channels.expo_push.events.permission_request,
        enabled: notificationsSettings.permissionRequest !== false,
      },
      user_action_request: {
        ...channels.expo_push.events.user_action_request,
        enabled: notificationsSettings.userActionRequest !== false,
      },
      connected_service_account_switch: {
        ...channels.expo_push.events.connected_service_account_switch,
        enabled: notificationsSettings.connectedServiceAccountSwitch !== false,
      },
      connected_service_quota_blocked: {
        ...channels.expo_push.events.connected_service_quota_blocked,
        enabled: notificationsSettings.connectedServiceQuotaBlocked !== false,
      },
      connected_service_quota_recovered: {
        ...channels.expo_push.events.connected_service_quota_recovered,
        enabled: notificationsSettings.connectedServiceQuotaRecovered !== false,
      },
    },
  };

  const expoPushChannels = params.notificationChannels.filter((channel) => channel.kind === 'expo_push');
  if (expoPushChannels.length === 0) {
    channels.expo_push = {
      ...channels.expo_push,
      enabled: false,
      events: {
        ...channels.expo_push.events,
        ready: { ...channels.expo_push.events.ready, enabled: false },
        permission_request: { ...channels.expo_push.events.permission_request, enabled: false },
        user_action_request: { ...channels.expo_push.events.user_action_request, enabled: false },
        connected_service_account_switch: {
          ...channels.expo_push.events.connected_service_account_switch,
          enabled: false,
        },
        connected_service_quota_blocked: {
          ...channels.expo_push.events.connected_service_quota_blocked,
          enabled: false,
        },
        connected_service_quota_recovered: {
          ...channels.expo_push.events.connected_service_quota_recovered,
          enabled: false,
        },
      },
    };
  }

  for (const channel of expoPushChannels) {
    if (channel.kind !== 'expo_push') continue;
    const channelId = 'expo_push';
    const current = channels[channelId] ?? AttentionDeliveryPolicyV1Schema.parse({}).channels[channelId];
    const nextEvents = { ...current.events };
    for (const [topic, enabled] of Object.entries(channel.topics ?? {})) {
      const eventId = eventIdFromChannelTopic(topic);
      if (!eventId) continue;
      nextEvents[eventId] = { ...nextEvents[eventId], enabled };
    }
    channels[channelId] = {
      ...current,
      enabled: channel.enabled !== false,
      previewBehavior: channel.readyIncludeMessageText === false ? 'status_only' : current.previewBehavior,
      events: nextEvents,
    };
  }

  const webhookChannels = params.notificationChannels.filter((channel) => channel.kind === 'webhook');
  const enabledWebhookChannels = webhookChannels.filter((channel) => channel.enabled !== false);
  const webhookEvents = { ...channels.webhook.events };
  for (const eventId of NOTIFICATION_CHANNEL_EVENT_IDS) {
    webhookEvents[eventId] = {
      ...webhookEvents[eventId],
      enabled: enabledWebhookChannels.some((channel) => {
        const topicEntry = Object.entries(channel.topics ?? {}).find(([topic]) => eventIdFromChannelTopic(topic) === eventId);
        return topicEntry?.[1] === true;
      }),
    };
  }
  channels.webhook = {
    ...channels.webhook,
    enabled: enabledWebhookChannels.length > 0,
    previewBehavior: enabledWebhookChannels.some((channel) => channel.readyIncludeMessageText === true)
      ? 'include_preview'
      : 'status_only',
    events: webhookEvents,
  };

  return AttentionDeliveryPolicyV1Schema.parse({
    ...policy,
    events,
    channels,
  });
}
