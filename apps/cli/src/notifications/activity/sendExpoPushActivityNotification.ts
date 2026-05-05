import type { ExpoPushNotificationChannelV1 } from '@happier-dev/protocol';

import type { PushNotificationDeliveryOptions } from '@/api/pushNotifications';
import type { ActivityNotificationEvent } from './activityNotificationEvent';
import { buildActivityNotificationContent } from './buildActivityNotificationContent';

export type ExpoPushActivityNotificationSender = Readonly<{
  sendToAllDevicesAsync: (
    title: string,
    body: string,
    data: Record<string, unknown>,
    options?: PushNotificationDeliveryOptions,
  ) => Promise<void>;
}>;

export async function sendExpoPushActivityNotificationAsync(params: Readonly<{
  channel: ExpoPushNotificationChannelV1;
  event: ActivityNotificationEvent;
  sender: ExpoPushActivityNotificationSender;
  deliveryOptions?: PushNotificationDeliveryOptions;
}>): Promise<void> {
  const built = buildActivityNotificationContent(params.event, {
    readyIncludeMessageText: params.channel.readyIncludeMessageText !== false,
  });
  if (params.deliveryOptions) {
    await params.sender.sendToAllDevicesAsync(built.title, built.body, built.data, params.deliveryOptions);
    return;
  }
  await params.sender.sendToAllDevicesAsync(built.title, built.body, built.data);
}
