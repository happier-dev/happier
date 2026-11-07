export const NOTIFICATION_CONFIGURATION_ACTION_IDS = [
  'notifications.webhooks.list', 'notifications.webhooks.add', 'notifications.webhooks.update',
  'notifications.webhooks.remove', 'notifications.webhooks.signingSecret.set', 'notifications.webhooks.signingSecret.clear',
  'notifications.webhooks.test',
  'notifications.expoPush.update',
  'notifications.sounds.preview',
  'notifications.desktop.permission.read', 'notifications.desktop.permission.request',
  'notifications.push.tokens.list', 'notifications.push.tokens.remove',
  'notifications.push.permission.read', 'notifications.push.permission.request', 'notifications.push.register',
] as const;
export type NotificationConfigurationActionId = typeof NOTIFICATION_CONFIGURATION_ACTION_IDS[number];
export function isNotificationConfigurationActionId(value: string): value is NotificationConfigurationActionId {
  return (NOTIFICATION_CONFIGURATION_ACTION_IDS as readonly string[]).includes(value);
}
