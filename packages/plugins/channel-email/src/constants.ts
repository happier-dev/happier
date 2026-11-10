export const EMAIL_CHANNEL_PLUGIN_ID = 'happier.channel.email';
export const EMAIL_TRANSPORT_POINT_ID = 'transports';
export const EMAIL_CHANNEL_ACTION_IDS = {
  notificationSetup: 'notifications/setup',
  setup: 'channel/setup-v1', connectionTest: 'channel/connection-test-v1',
  endpointResolve: 'channel/endpoint-resolve-v1', principalResolve: 'channel/principal-resolve-v1',
  observationsPoll: 'channel/observations-poll-v1', messageDeliver: 'channel/message-deliver-v1',
  deliveryReconcile: 'channel/delivery-reconcile-v1', attachmentFetch: 'channel/attachment-fetch-v1',
} as const;
