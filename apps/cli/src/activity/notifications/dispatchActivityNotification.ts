import {
  resolveNotificationChannelsV1FromAccountSettings,
  type AccountSettings,
} from '@happier-dev/protocol';

import { logger } from '@/ui/logger';
import type { ActivityNotificationEvent } from './activityNotificationEvent';
import {
  sendExpoPushActivityNotificationAsync,
  type ExpoPushActivityNotificationSender,
} from './sendExpoPushActivityNotification';
import { sendWebhookActivityNotificationAsync } from './sendWebhookActivityNotification';

function isTopicEnabled(channel: {
  enabled: boolean;
  topics: {
    ready: boolean;
    permissionRequest: boolean;
    userActionRequest: boolean;
  };
}, topic: ActivityNotificationEvent['topic']): boolean {
  if (channel.enabled !== true) return false;
  if (topic === 'ready') return channel.topics.ready === true;
  if (topic === 'permission_request') return channel.topics.permissionRequest === true;
  return channel.topics.userActionRequest === true;
}

export async function dispatchActivityNotificationAsync(params: Readonly<{
  settings: AccountSettings | null | undefined;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  event: ActivityNotificationEvent;
  expoPushSender?: ExpoPushActivityNotificationSender | null;
  nowMs?: () => number;
}>): Promise<Readonly<{ attemptedChannels: number; deliveredChannels: number }>> {
  const channels = resolveNotificationChannelsV1FromAccountSettings(params.settings ?? null);
  let attemptedChannels = 0;
  let deliveredChannels = 0;

  for (const channel of channels) {
    if (!isTopicEnabled(channel, params.event.topic)) continue;
    attemptedChannels += 1;
    try {
      if (channel.kind === 'expo_push') {
        if (!params.expoPushSender) continue;
        await sendExpoPushActivityNotificationAsync({
          channel,
          event: params.event,
          sender: params.expoPushSender,
        });
        deliveredChannels += 1;
        continue;
      }

      await sendWebhookActivityNotificationAsync({
        channel,
        event: params.event,
        settingsSecretsReadKeys: params.settingsSecretsReadKeys,
        nowMs: params.nowMs,
      });
      deliveredChannels += 1;
    } catch (error) {
      logger.debug('[activityNotifications] Failed to dispatch outbound notification', error);
    }
  }

  return {
    attemptedChannels,
    deliveredChannels,
  };
}
