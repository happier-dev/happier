import type { ExpoPushNotificationChannelV1 } from '@happier-dev/protocol';

import type { ActivityNotificationEvent } from './activityNotificationEvent';
import { buildActivityNotificationContent } from './buildActivityNotificationContent';

export type ExpoPushActivityNotificationSender = Readonly<{
  sendToAllDevicesAsync: (title: string, body: string, data: Record<string, unknown>) => Promise<void>;
}>;

export async function sendExpoPushActivityNotificationAsync(params: Readonly<{
  channel: ExpoPushNotificationChannelV1;
  event: ActivityNotificationEvent;
  sender: ExpoPushActivityNotificationSender;
}>): Promise<void> {
  const built = buildActivityNotificationContent(params.event, {
    readyIncludeMessageText: params.channel.readyIncludeMessageText !== false,
  });
  await params.sender.sendToAllDevicesAsync(built.title, built.body, built.data);
}
