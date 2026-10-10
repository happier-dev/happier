export const NOTIFICATION_CONFIGURATION_ACTION_IDS = [
  'notifications.webhooks.list', 'notifications.webhooks.add', 'notifications.webhooks.update',
  'notifications.webhooks.remove', 'notifications.webhooks.signingSecret.set', 'notifications.webhooks.signingSecret.clear',
  'notifications.expoPush.update',
  'notifications.desktop.permission.read', 'notifications.desktop.permission.request',
] as const;
export type NotificationConfigurationActionId = typeof NOTIFICATION_CONFIGURATION_ACTION_IDS[number];
export function isNotificationConfigurationActionId(value: string): value is NotificationConfigurationActionId {
  return (NOTIFICATION_CONFIGURATION_ACTION_IDS as readonly string[]).includes(value);
}
