export const NOTIFICATION_NOTIFY_ME_ACTION_ID = 'notifications.notify_me' as const;
export const SAVED_HEALTH_ALERT_TEST_ACTION_ID = 'notifications.test' as const;
export const WEBHOOK_NOTIFICATION_TEST_ACTION_ID = 'notifications.webhooks.test' as const;
export const NOTIFICATION_CONFIGURATION_ACTION_IDS = [
  SAVED_HEALTH_ALERT_TEST_ACTION_ID,
  'notifications.webhooks.list', 'notifications.webhooks.add', 'notifications.webhooks.update',
  'notifications.webhooks.remove', 'notifications.webhooks.signingSecret.set', 'notifications.webhooks.signingSecret.clear',
  WEBHOOK_NOTIFICATION_TEST_ACTION_ID,
  'notifications.expoPush.update',
  'notifications.sounds.preview',
  'notifications.push.test',
  'notifications.desktop.permission.read', 'notifications.desktop.permission.request',
  'notifications.push.tokens.list', 'notifications.push.tokens.remove',
  'notifications.push.permission.read', 'notifications.push.permission.request', 'notifications.push.register',
] as const;
export type NotificationConfigurationActionId = typeof NOTIFICATION_CONFIGURATION_ACTION_IDS[number];
export function isNotificationConfigurationActionId(value: string): value is NotificationConfigurationActionId {
  return (NOTIFICATION_CONFIGURATION_ACTION_IDS as readonly string[]).includes(value);
}
