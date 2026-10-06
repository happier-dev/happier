import { accountSettingsParse, resolveNotificationChannelsV1FromAccountSettings } from '@happier-dev/protocol/account/settings/accountSettings';
import type { AttentionDeliveryDecision, AttentionDeliveryEventId, PluginNotificationChannelKindV1, AccountSettings, ExpoPushNotificationChannelV1 } from '@happier-dev/protocol';
import { BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID } from '@happier-dev/protocol/account/settings/notificationChannels';
import { isPushNotificationBundledSoundId, resolveExpoNotificationSoundName } from '@happier-dev/protocol/push/pushNotificationActions';
import { resolveAttentionDeliveryPolicyDecision } from '@happier-dev/protocol/account/settings/attentionDeliveryPolicyDecision';

import type { PushNotificationClient, PushNotificationDeliveryOptions } from '@/api/pushNotifications';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { logger } from '@/ui/logger';
import type { ActivityNotificationEvent } from './activityNotificationEvent';
import type { StablePluginNotificationsOwner } from '@/plugins/runtime/invocation/services/notifications';
import { buildActivityNotificationContent } from './buildActivityNotificationContent';
import { createHostPluginNotificationChannels } from './pluginNotificationChannels';
import { isSessionActivityNotificationEligible, type SessionNotificationContextReader } from './sessionActivityNotificationEligibility';
import { buildLiveActivityRemoteUpdateRequest } from './liveActivity/buildLiveActivityRemoteUpdateRequest';
import {
  sendLiveActivityRemoteUpdate,
  type LiveActivityRemoteUpdateSender,
} from './liveActivity/sendLiveActivityRemoteUpdate';
import {
  sendExpoPushActivityNotificationAsync,
  type ExpoPushActivityNotificationSender,
} from './sendExpoPushActivityNotification';
import {
  sendWebhookActivityNotificationAsync,
  type WebhookActivityNotificationNetworkDependencies,
} from './sendWebhookActivityNotification';

function isTopicEnabled(channel: {
  enabled: boolean;
  topics: {
    ready: boolean;
    permissionRequest: boolean;
    userActionRequest: boolean;
    connectedServiceAccountSwitch?: boolean;
    connectedServiceQuotaBlocked?: boolean;
    connectedServiceQuotaRecovered?: boolean;
  };
}, topic: ActivityNotificationEvent['topic']): boolean {
  if (channel.enabled !== true) return false;
  if (topic === 'workflow_run_update' || topic === 'notify_me') return true;
  if (topic === 'ready') return channel.topics.ready === true;
  if (topic === 'permission_request') return channel.topics.permissionRequest === true;
  if (topic === 'user_action_request') return channel.topics.userActionRequest === true;
  if (topic === 'connected_service_account_switch') return channel.topics.connectedServiceAccountSwitch === true;
  if (topic === 'connected_service_credential_health') return channel.topics.connectedServiceAccountSwitch === true;
  if (topic === 'connected_service_quota_blocked') return channel.topics.connectedServiceQuotaBlocked === true;
  if (topic === 'connected_service_quota_recovered') return channel.topics.connectedServiceQuotaRecovered === true;
  return false;
}

const recentDispatchesByKey = new Map<string, number>();

function notificationDedupeKey(event: ActivityNotificationEvent): string | null {
  if (event.topic === 'notify_me') {
    return event.actionRequestId ? [event.topic, event.actionRequestId].join('\0') : null;
  }
  if (event.topic === 'workflow_run_update') {
    return [event.topic, event.runId, event.updateKind].join('\0');
  }
  if (event.topic === 'connected_service_account_switch') {
    return [
      event.topic,
      event.sessionId,
      event.serviceId,
      event.groupId,
      event.fromProfileId ?? '',
      event.toProfileId ?? '',
      event.reason,
      event.limitCategory ?? '',
      event.providerLimitId ?? '',
    ].join('\0');
  }
  if (event.topic === 'connected_service_quota_blocked' || event.topic === 'connected_service_quota_recovered') {
    return [
      event.topic,
      event.serviceId,
      event.groupId ?? '',
      event.profileId ?? '',
      event.nativeAuth === true ? 'native' : '',
      event.sessionId,
      event.issueFingerprint,
    ].join('\0');
  }
  if (event.topic === 'connected_service_credential_health') {
    return [
      event.topic,
      event.sessionId,
      event.serviceId,
      event.profileId,
      event.status,
      event.reason ?? '',
      event.providerErrorCode ?? '',
    ].join('\0');
  }
  return null;
}

function isSuppressedDuplicate(input: Readonly<{
  event: ActivityNotificationEvent;
  nowMs: number;
  dedupeWindowMs: number;
}>): boolean {
  if (input.dedupeWindowMs <= 0) return false;
  const key = notificationDedupeKey(input.event);
  if (!key) return false;
  const lastDispatchedAtMs = recentDispatchesByKey.get(key);
  return typeof lastDispatchedAtMs === 'number' && input.nowMs - lastDispatchedAtMs < input.dedupeWindowMs;
}

function recordDeliveredNotificationForDedupe(input: Readonly<{
  event: ActivityNotificationEvent;
  nowMs: number;
  dedupeWindowMs: number;
}>): void {
  if (input.dedupeWindowMs <= 0) return;
  const key = notificationDedupeKey(input.event);
  if (!key) return;
  recentDispatchesByKey.set(key, input.nowMs);
}

export function resolveActivityNotificationPolicyEvent(
  event: ActivityNotificationEvent,
): AttentionDeliveryEventId {
  if (event.topic === 'connected_service_credential_health') {
    return 'connected_service_account_switch';
  }
  if (event.topic !== 'workflow_run_update') return event.topic;
  if (event.updateKind === 'completed' || event.updateKind === 'completed_with_failures') {
    return 'task_completed';
  }
  if (event.updateKind === 'failed' || event.updateKind === 'outcome_uncertain') return 'task_failed';
  return 'user_action_request';
}

function resolveChannelDecision(params: Readonly<{
  settings: AccountSettings;
  channel: PluginNotificationChannelKindV1;
  event: ActivityNotificationEvent;
  now: Date;
}>): AttentionDeliveryDecision {
  return resolveAttentionDeliveryPolicyDecision({
    policy: params.settings.attentionDeliveryPolicyV1,
    event: resolveActivityNotificationPolicyEvent(params.event),
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
      connectedServiceAccountSwitch: true,
      connectedServiceQuotaBlocked: true,
      connectedServiceQuotaRecovered: true,
    },
    readyIncludeMessageText: decision.previewBehavior === 'include_preview',
    requestIncludeMessageText: decision.previewBehavior === 'include_preview',
  };
}

/** Discovery projects the same configured delivery set the Activity owner dispatches. */
export async function listActivityNotificationChannels(params: Readonly<{
  settings: AccountSettings | null | undefined;
  pluginNotifications?: Pick<StablePluginNotificationsOwner, 'availableHostChannels'> | null;
  pushTokenReader?: Pick<PushNotificationClient, 'fetchPushTokens'>;
}>): Promise<readonly Readonly<{ value: string; label: string; disabled: boolean }>[]> {
  const settings = accountSettingsParse(params.settings ?? {});
  const pluginNotifications = params.pluginNotifications === undefined
    ? createHostPluginNotificationChannels()
    : params.pluginNotifications;
  const configuredForNotifyMe = (kind: PluginNotificationChannelKindV1) => {
    const decision = resolveChannelDecision({ settings, channel: kind,
      event: { topic: 'notify_me', message: '' }, now: new Date() });
    // Quiet hours apply when the future occurrence delivers, not when its intent
    // is registered. Disabled channels/events remain unavailable in the catalog.
    return decision.delivery !== 'suppress' || decision.reason === 'quiet_hours';
  };
  const pushConfigured = configuredForNotifyMe('expo_push') && params.pushTokenReader
    ? (await params.pushTokenReader.fetchPushTokens()).length > 0 : false;
  return [
    { value: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID, label: 'Push notifications', disabled: !pushConfigured },
    ...resolveNotificationChannelsV1FromAccountSettings(settings)
      .filter((channel) => channel.kind === 'webhook')
      .map((channel) => ({ value: channel.id, label: channel.id,
        disabled: !channel.enabled || !configuredForNotifyMe('webhook') })),
    ...(await pluginNotifications?.availableHostChannels() ?? [])
      .map(({ value, label, kind }) => ({ value, label, disabled: !configuredForNotifyMe(kind) })),
  ];
}

export async function dispatchActivityNotificationAsync(params: Readonly<{
  settings: AccountSettings | null | undefined;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  event: ActivityNotificationEvent;
  expoPushSender?: ExpoPushActivityNotificationSender | null;
  liveActivityRemoteSender?: LiveActivityRemoteUpdateSender | null;
  nowMs?: () => number;
  dedupeWindowMs?: number;
  webhookNetwork?: WebhookActivityNotificationNetworkDependencies;
  fetchSessionNotificationContext?: SessionNotificationContextReader['fetchSessionNotificationContext'];
  channels?: readonly string[];
  pluginNotifications?: Pick<StablePluginNotificationsOwner, 'availableHostChannels' | 'sendHostNotification'> | null;
}>): Promise<Readonly<{ attemptedChannels: number; deliveredChannels: number }>> {
  if (!await isSessionActivityNotificationEligible(params)) {
    return { attemptedChannels: 0, deliveredChannels: 0 };
  }
  const settings = accountSettingsParse(params.settings ?? {});
  const channels = resolveNotificationChannelsV1FromAccountSettings(settings);
  const nowMs = params.nowMs?.() ?? Date.now();
  const dedupeWindowMs = params.dedupeWindowMs ?? 60_000;
  if (isSuppressedDuplicate({ event: params.event, nowMs, dedupeWindowMs })) {
    return { attemptedChannels: 0, deliveredChannels: 0 };
  }
  const policyNow = new Date(nowMs);
  let attemptedChannels = 0;
  let deliveredChannels = 0;
  const selectedChannelIds = params.channels ? new Set(params.channels) : null;
  const selects = (id: string) => !selectedChannelIds || selectedChannelIds.has(id);
  const pluginNotifications = params.pluginNotifications === undefined
    ? createHostPluginNotificationChannels()
    : params.pluginNotifications;

  const expoDecision = resolveChannelDecision({
    settings,
    channel: 'expo_push',
    event: params.event,
    now: policyNow,
  });
  if (selects(BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID) && expoDecision.delivery !== 'suppress') {
    attemptedChannels += 1;
    if (params.expoPushSender) {
      try {
        const accepted = await sendExpoPushActivityNotificationAsync({
          channel: buildCanonicalExpoPushChannel(expoDecision),
          event: params.event,
          sender: params.expoPushSender,
          deliveryOptions: {
            ...resolveExpoPushDeliveryOptions(expoDecision),
            ...(expoDecision.suppressIfComputerFocused === true ? { suppressIfComputerFocused: true } : {}),
          },
          previewBehavior: expoDecision.previewBehavior,
        });
        if (accepted) deliveredChannels += 1;
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
  const liveActivityRequest = !selectedChannelIds && params.liveActivityRemoteSender
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
    if (!selects(channel.id)) continue;
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
        previewBehavior: decision.previewBehavior,
        event: params.event,
        settingsSecretsReadKeys: params.settingsSecretsReadKeys,
        nowMs: params.nowMs,
        ...(params.webhookNetwork ? { network: params.webhookNetwork } : {}),
      });
      deliveredChannels += 1;
    } catch (error) {
      logger.debug('[activityNotifications] Failed to dispatch outbound notification', serializeAxiosErrorForLog(error));
    }
  }

  if (pluginNotifications) {
    for (const channel of await pluginNotifications.availableHostChannels()) {
      if (!selects(channel.value)) continue;
      const decision = resolveChannelDecision({ settings,
        channel: channel.kind,
        event: params.event, now: policyNow });
      if (decision.delivery !== 'suppress') {
        attemptedChannels += 1;
        try {
          const content = buildActivityNotificationContent(params.event, {
            readyIncludeMessageText: decision.previewBehavior === 'include_preview',
            requestIncludeMessageText: decision.previewBehavior === 'include_preview',
            previewBehavior: decision.previewBehavior,
          });
          if (await pluginNotifications.sendHostNotification({
            channelId: channel.value, title: content.title, body: content.body, data: content.data,
          })) deliveredChannels += 1;
        } catch (error) {
          logger.debug('[activityNotifications] Failed to dispatch plugin notification', serializeAxiosErrorForLog(error));
        }
      }
    }
  }

  if (deliveredChannels > 0) {
    recordDeliveredNotificationForDedupe({ event: params.event, nowMs, dedupeWindowMs });
  }

  return {
    attemptedChannels,
    deliveredChannels,
  };
}
