import {
  accountSettingsParse,
  type AttentionDeliveryDecision,
  BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
  isPushNotificationBundledSoundId,
  resolveExpoNotificationSoundName,
  resolveAttentionDeliveryPolicyDecision,
  resolveNotificationChannelsV1FromAccountSettings,
  type AccountSettings,
  type ExpoPushNotificationChannelV1,
} from '@happier-dev/protocol';

import type { PushNotificationDeliveryOptions } from '@/api/pushNotifications';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { logger } from '@/ui/logger';
import type { ActivityNotificationEvent } from './activityNotificationEvent';
import { buildLiveActivityRemoteUpdateRequest } from './liveActivity/buildLiveActivityRemoteUpdateRequest';
import {
  sendLiveActivityRemoteUpdate,
  type LiveActivityRemoteUpdateSender,
} from './liveActivity/sendLiveActivityRemoteUpdate';
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

function resolveChannelDecision(params: Readonly<{
  settings: AccountSettings;
  channel: 'expo_push' | 'webhook' | 'live_activity';
  event: ActivityNotificationEvent;
  now: Date;
}>): AttentionDeliveryDecision {
  return resolveAttentionDeliveryPolicyDecision({
    policy: params.settings.attentionDeliveryPolicyV1,
    event: params.event.topic,
    channel: params.channel,
    now: params.now,
  });
}

function resolveExpoPushDeliveryOptions(decision: AttentionDeliveryDecision): PushNotificationDeliveryOptions | undefined {
  if (decision.delivery === 'silent') {
    return { sound: null, priority: 'normal', androidSoundId: 'none' };
  }
  if (decision.sound.kind === 'none') {
    return { sound: null, priority: 'high', androidSoundId: 'none' };
  }
  if (decision.sound.kind === 'system_default') {
    return { sound: 'default', priority: 'high' };
  }
  if (decision.sound.kind === 'custom') {
    return { sound: null, priority: 'high', androidSoundId: 'none' };
  }
  const soundId = decision.sound.id ?? 'default';
  return {
    sound: resolveExpoNotificationSoundName(soundId) ?? null,
    priority: 'high',
    ...(isPushNotificationBundledSoundId(soundId) ? { androidSoundId: soundId } : {}),
  };
}

function buildCanonicalExpoPushChannel(decision: AttentionDeliveryDecision): ExpoPushNotificationChannelV1 {
  return {
    v: 1,
    id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
    kind: 'expo_push',
    enabled: true,
    topics: {
      ready: true,
      permissionRequest: true,
      userActionRequest: true,
    },
    readyIncludeMessageText: decision.previewBehavior === 'include_preview',
  };
}

export async function dispatchActivityNotificationAsync(params: Readonly<{
  settings: AccountSettings | null | undefined;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  event: ActivityNotificationEvent;
  expoPushSender?: ExpoPushActivityNotificationSender | null;
  liveActivityRemoteSender?: LiveActivityRemoteUpdateSender | null;
  nowMs?: () => number;
}>): Promise<Readonly<{ attemptedChannels: number; deliveredChannels: number }>> {
  const settings = accountSettingsParse(params.settings ?? {});
  const channels = resolveNotificationChannelsV1FromAccountSettings(settings);
  const nowMs = params.nowMs?.() ?? Date.now();
  const policyNow = new Date(nowMs);
  let attemptedChannels = 0;
  let deliveredChannels = 0;

  const expoDecision = resolveChannelDecision({
    settings,
    channel: 'expo_push',
    event: params.event,
    now: policyNow,
  });
  if (expoDecision.delivery !== 'suppress') {
    attemptedChannels += 1;
    if (params.expoPushSender) {
      try {
        await sendExpoPushActivityNotificationAsync({
          channel: buildCanonicalExpoPushChannel(expoDecision),
          event: params.event,
          sender: params.expoPushSender,
          deliveryOptions: resolveExpoPushDeliveryOptions(expoDecision),
        });
        deliveredChannels += 1;
      } catch (error) {
        logger.debug('[activityNotifications] Failed to dispatch outbound notification', serializeAxiosErrorForLog(error));
      }
    }
  }

  const liveActivityDecision = resolveChannelDecision({
    settings,
    channel: 'live_activity',
    event: params.event,
    now: policyNow,
  });
  const liveActivityRequest = params.liveActivityRemoteSender
    ? buildLiveActivityRemoteUpdateRequest({
        event: params.event,
        decision: liveActivityDecision,
        serverId: params.liveActivityRemoteSender.serverId,
        nowMs,
      })
    : null;
  if (liveActivityRequest && params.liveActivityRemoteSender) {
    attemptedChannels += 1;
    try {
      await sendLiveActivityRemoteUpdate({
        request: liveActivityRequest,
        sender: params.liveActivityRemoteSender,
      });
      deliveredChannels += 1;
    } catch (error) {
      logger.debug('[activityNotifications] Failed to dispatch Live Activity remote update', serializeAxiosErrorForLog(error));
    }
  }

  for (const channel of channels) {
    if (channel.kind !== 'webhook') continue;
    if (!isTopicEnabled(channel, params.event.topic)) continue;
    const decision = resolveChannelDecision({
      settings,
      channel: 'webhook',
      event: params.event,
      now: policyNow,
    });
    if (decision.delivery === 'suppress') {
      continue;
    }
    attemptedChannels += 1;
    try {
      await sendWebhookActivityNotificationAsync({
        channel,
        event: params.event,
        settingsSecretsReadKeys: params.settingsSecretsReadKeys,
        nowMs: params.nowMs,
      });
      deliveredChannels += 1;
    } catch (error) {
      logger.debug('[activityNotifications] Failed to dispatch outbound notification', serializeAxiosErrorForLog(error));
    }
  }

  return {
    attemptedChannels,
    deliveredChannels,
  };
}
