import {
  DEFAULT_NOTIFICATIONS_SETTINGS_V1,
  resolveNotificationChannelsV1FromAccountSettings,
  type AccountSettings,
} from '@happier-dev/protocol';

function resolveNotifications(settings: AccountSettings | null | undefined): AccountSettings['notificationsSettingsV1'] {
  return settings?.notificationsSettingsV1 ?? DEFAULT_NOTIFICATIONS_SETTINGS_V1;
}

export function shouldSendReadyPushNotification(settings?: AccountSettings | null): boolean {
  const channels = resolveNotificationChannelsV1FromAccountSettings(settings);
  if (channels.length > 0) {
    return channels.some((channel) => channel.enabled === true && channel.topics.ready === true);
  }
  const notifications = resolveNotifications(settings);
  return notifications.pushEnabled !== false && notifications.ready !== false;
}

export function shouldSendPermissionRequestPushNotification(settings?: AccountSettings | null): boolean {
  const channels = resolveNotificationChannelsV1FromAccountSettings(settings);
  if (channels.length > 0) {
    return channels.some((channel) => channel.enabled === true && channel.topics.permissionRequest === true);
  }
  const notifications = resolveNotifications(settings);
  return notifications.pushEnabled !== false && notifications.permissionRequest !== false;
}

export function shouldSendUserActionRequestPushNotification(settings?: AccountSettings | null): boolean {
  const channels = resolveNotificationChannelsV1FromAccountSettings(settings);
  if (channels.length > 0) {
    return channels.some((channel) => channel.enabled === true && channel.topics.userActionRequest === true);
  }
  const notifications = resolveNotifications(settings);
  return notifications.pushEnabled !== false && notifications.userActionRequest !== false;
}
