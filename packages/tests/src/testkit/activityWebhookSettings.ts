export function buildCanonicalWebhookAccountSettings(params: Readonly<{
  webhookUrl: string;
  readyEventEnabled?: boolean;
  webhookQuietHoursBehavior?: 'deliver' | 'silent' | 'suppress';
}>): unknown {
  const readyEnabled = params.readyEventEnabled !== false;
  return {
    schemaVersion: 2,
    notificationsSettingsV1: {
      v: 1,
      pushEnabled: false,
      ready: true,
      readyIncludeMessageText: true,
      permissionRequest: true,
      userActionRequest: true,
      foregroundBehavior: 'full',
    },
    notificationChannelsV1: [
      {
        v: 1,
        id: 'webhook-primary',
        kind: 'webhook',
        enabled: true,
        url: params.webhookUrl,
        signingSecret: null,
        topics: {
          ready: true,
          permissionRequest: false,
          userActionRequest: false,
        },
        readyIncludeMessageText: false,
      },
    ],
    attentionDeliveryPolicyV1: {
      v: 1,
      events: {
        ready: { enabled: readyEnabled },
      },
      channels: {
        webhook: {
          enabled: true,
          quietHoursBehavior: params.webhookQuietHoursBehavior ?? 'deliver',
          events: {
            ready: { enabled: readyEnabled },
          },
        },
      },
      quietHours: {
        enabled: true,
        timezone: 'UTC',
        windows: [
          {
            startLocalTime: '22:00',
            endLocalTime: '07:00',
          },
        ],
      },
    },
  };
}
