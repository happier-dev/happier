import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { isUsageQuotaNotificationEnabled } from '@happier-dev/protocol/account/settings/usagePacingPreferencesV1';
import { UsageNoticeArtifactHeaderV1Schema, UsageNoticeArtifactBodyV1Schema, USAGE_NOTICE_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import type { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import type { AttentionDeliveryDecision, AttentionDeliveryEventId, PluginNotificationChannelKindV1, AccountSettings } from '@happier-dev/protocol';
import type { NotificationChannelCatalogSnapshotV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { isPushNotificationBundledSoundId, resolveExpoNotificationSoundName } from '@happier-dev/protocol/push/pushNotificationActions';
import { resolveAttentionDeliveryPolicyDecision } from '@happier-dev/protocol/account/settings/attentionDeliveryPolicyDecision';

import type { PushNotificationClient, PushNotificationDeliveryOptions } from '@/api/pushNotifications';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { logger } from '@/ui/logger';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  isActiveAccountSettingsSnapshotLifetimeCurrent } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createSavedSecretMaterializerFromSnapshotV1, type SavedSecretMaterializerV1 } from '@/settings/secrets/savedSecretCatalog';
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
  resolveWebhookNotificationSigningSecret,
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
    connectedServiceUsage?: boolean;
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
  if (topic === 'connected_service_usage') return channel.topics.connectedServiceUsage === true;
  return false;
}

const recentDispatchesByKey = new Map<string, number>();

function notificationDedupeKey(event: ActivityNotificationEvent, accountId?: string): string | null {
  if (event.topic === 'connected_service_usage') return accountId
    ? [event.topic, accountId, event.kind, event.serviceId, event.profileId, event.issueFingerprint].join('\0')
    : null;
  if (event.topic === 'notify_me') {
    return event.actionRequestId ? [event.topic, event.actionRequestId].join('\0') : null;
  }
  if (event.topic === 'workflow_run_update') {
    // The workflow owner emits committed occurrences. Two distinct invocation
    // holds can share a Run and kind; time proximity is not replay evidence.
    return null;
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
  accountId?: string;
  nowMs: number;
  dedupeWindowMs: number;
}>): boolean {
  if (input.dedupeWindowMs <= 0) return false;
  const key = notificationDedupeKey(input.event, input.accountId);
  if (!key) return false;
  const lastDispatchedAtMs = recentDispatchesByKey.get(key);
  return typeof lastDispatchedAtMs === 'number' && input.nowMs - lastDispatchedAtMs < input.dedupeWindowMs;
}

function recordDeliveredNotificationForDedupe(input: Readonly<{
  event: ActivityNotificationEvent;
  accountId?: string;
  nowMs: number;
  dedupeWindowMs: number;
}>): void {
  if (input.dedupeWindowMs <= 0) return;
  const key = notificationDedupeKey(input.event, input.accountId);
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

export class NotificationChannelCatalogUnavailableError extends Error {
  readonly code = 'notification_channel_catalog_unavailable' as const;
  constructor(readonly reason: string) {
    super('Notification channel catalog is unavailable');
    this.name = 'NotificationChannelCatalogUnavailableError';
  }
}

function readRuntimeNotificationCatalog(params: Readonly<{
  settings: AccountSettings | null | undefined;
  notificationChannelCatalog?: NotificationChannelCatalogSnapshotV1;
  savedSecretMaterializer?: SavedSecretMaterializerV1;
  isCurrent?: () => boolean | Promise<boolean>;
}>) {
  const active = getActiveAccountSettingsSnapshot();
  const captured = active?.settings === params.settings ? active : null;
  const catalog = params.notificationChannelCatalog ?? captured?.notificationChannelCatalog ?? { status: 'loading' as const };
  if (catalog.status !== 'ready') throw new NotificationChannelCatalogUnavailableError(
    catalog.status === 'unavailable' ? catalog.reason : catalog.status === 'partial' ? 'catalog-incomplete' : 'loading');
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const incumbent = !params.notificationChannelCatalog && captured?.scopeKey ? { scopeKey: captured.scopeKey, lifetimeToken } : null;
  const isCurrent = params.isCurrent ?? (incumbent ? () => isActiveAccountSettingsSnapshotLifetimeCurrent(incumbent) : undefined);
  return { channels: catalog.channels, assertCurrent: async () => {
    if (isCurrent && !await isCurrent()) throw new NotificationChannelCatalogUnavailableError('scope-retired');
  },
    savedSecretMaterializer: params.savedSecretMaterializer ?? (!params.notificationChannelCatalog && captured
      ? createSavedSecretMaterializerFromSnapshotV1(captured) : undefined) };
}

/** Discovery projects the same configured delivery set the Activity owner dispatches. */
export async function listActivityNotificationChannels(params: Readonly<{
  settings: AccountSettings | null | undefined;
  notificationChannelCatalog?: NotificationChannelCatalogSnapshotV1;
  savedSecretMaterializer?: SavedSecretMaterializerV1;
  isCurrent?: () => boolean | Promise<boolean>;
  pluginNotifications?: Pick<StablePluginNotificationsOwner, 'availableHostChannels'> | null;
  pushTokenReader?: Pick<PushNotificationClient, 'fetchPushTokens'>;
}>): Promise<readonly Readonly<{ value: string; label: string; disabled: boolean }>[]> {
  const settings = accountSettingsParse(params.settings ?? {});
  const { channels, savedSecretMaterializer, assertCurrent } = readRuntimeNotificationCatalog(params);
  await assertCurrent();
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
  const pushConfigured = channels.some(channel => channel.kind === 'expo_push' && channel.enabled)
    && configuredForNotifyMe('expo_push') && params.pushTokenReader
    ? (await params.pushTokenReader.fetchPushTokens()).length > 0 : false;
  await assertCurrent();
  const pluginChannels = await pluginNotifications?.availableHostChannels() ?? [];
  await assertCurrent();
  return [
    ...channels.map((channel) => ({ value: channel.id, label: channel.kind === 'expo_push' ? 'Push notifications' : channel.id,
      disabled: !channel.enabled || (channel.kind === 'expo_push' ? !pushConfigured : !configuredForNotifyMe('webhook')
        || channel.signingSecretRef !== null && savedSecretMaterializer?.inspect(channel.signingSecretRef).status !== 'ready') })),
    ...pluginChannels
      .map(({ value, label, kind }) => ({ value, label, disabled: !configuredForNotifyMe(kind) })),
  ];
}

export async function dispatchActivityNotificationAsync(params: Readonly<{
  settings: AccountSettings | null | undefined;
  notificationChannelCatalog?: NotificationChannelCatalogSnapshotV1;
  savedSecretMaterializer?: SavedSecretMaterializerV1;
  isCurrent?: () => boolean | Promise<boolean>;
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
  usageNoticeArtifactStore?: Readonly<{ accountId: string; store: Pick<ReturnType<typeof createAccountArtifactStore>, 'create'> }>;
}>): Promise<Readonly<{ attemptedChannels: number; deliveredChannels: number }>> {
  if (!await isSessionActivityNotificationEligible(params)) {
    return { attemptedChannels: 0, deliveredChannels: 0 };
  }
  const settings = accountSettingsParse(params.settings ?? {});
  if (params.event.topic === 'connected_service_usage'
    && !isUsageQuotaNotificationEnabled(settings.usageQuotaNotificationsV1, params.event.kind)) {
    return { attemptedChannels: 0, deliveredChannels: 0 };
  }
  const { channels, savedSecretMaterializer, assertCurrent } = readRuntimeNotificationCatalog(params);
  await assertCurrent();
  const nowMs = params.nowMs?.() ?? Date.now();
  const dedupeWindowMs = params.dedupeWindowMs ?? 60_000;
  const accountId = params.usageNoticeArtifactStore?.accountId;
  if (isSuppressedDuplicate({ event: params.event, accountId, nowMs, dedupeWindowMs })) {
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

  // Admit the entire selected signing set before any outward delivery. A
  // missing credential must not produce a partially delivered occurrence.
  for (const channel of channels) {
    if (channel.kind !== 'webhook' || !selects(channel.id) || !isTopicEnabled(channel, params.event.topic)) continue;
    const decision = resolveChannelDecision({ settings, channel: 'webhook', event: params.event, now: policyNow });
    if (decision.delivery !== 'suppress') {
      await resolveWebhookNotificationSigningSecret({ channel, savedSecretMaterializer });
    }
  }
  await assertCurrent();

  // Inbox is an existing private Account Artifact projection. Its badge policy is
  // noninterruptive; push/webhook preview policy remains independent below.
  if (params.event.topic === 'connected_service_usage' && params.usageNoticeArtifactStore && !selectedChannelIds) {
    const decision = resolveChannelDecision({ settings, channel: 'badge', event: params.event, now: policyNow });
    if (decision.delivery !== 'suppress') {
      const notice = params.event;
      const content = buildActivityNotificationContent(notice, {
        readyIncludeMessageText: true, requestIncludeMessageText: true, previewBehavior: 'include_preview',
      });
      await assertCurrent();
      attemptedChannels += 1;
      try {
        await params.usageNoticeArtifactStore.store.create({
          usageNoticeAccountId: params.usageNoticeArtifactStore.accountId,
          beforeWrite: assertCurrent,
          header: UsageNoticeArtifactHeaderV1Schema.parse({ v: 1, kind: USAGE_NOTICE_ARTIFACT_KIND_V1, title: content.body, status: 'open', notice }),
          body: JSON.stringify(UsageNoticeArtifactBodyV1Schema.parse({ v: 1, notice })),
        });
        deliveredChannels += 1;
      } catch (error) {
        // The Artifact id is this Account's witnessed occurrence. Never overwrite
        // its read/dismiss state or deliver the same occurrence again.
        if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'conflict') {
          return { attemptedChannels, deliveredChannels };
        }
        throw error;
      }
    }
  }

  const expoDecision = resolveChannelDecision({
    settings,
    channel: 'expo_push',
    event: params.event,
    now: policyNow,
  });
  for (const channel of channels) {
    if (channel.kind !== 'expo_push' || !selects(channel.id) || !isTopicEnabled(channel, params.event.topic)
      || expoDecision.delivery === 'suppress') continue;
    attemptedChannels += 1;
    if (params.expoPushSender) {
      await assertCurrent();
      try {
        const accepted = await sendExpoPushActivityNotificationAsync({
          channel,
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
    await assertCurrent();
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
    await assertCurrent();
    attemptedChannels += 1;
    try {
      await sendWebhookActivityNotificationAsync({
        channel,
        previewBehavior: decision.previewBehavior,
        event: params.event,
        savedSecretMaterializer,
        assertCurrent,
        nowMs: params.nowMs,
        ...(params.webhookNetwork ? { network: params.webhookNetwork } : {}),
      });
      deliveredChannels += 1;
    } catch (error) {
      if (error instanceof NotificationChannelCatalogUnavailableError) throw error;
      logger.debug('[activityNotifications] Failed to dispatch outbound notification', serializeAxiosErrorForLog(error));
    }
  }

  if (pluginNotifications) {
    for (const channel of await pluginNotifications.availableHostChannels()) {
      await assertCurrent();
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
            beforeSend: assertCurrent,
          })) deliveredChannels += 1;
        } catch (error) {
          if (error instanceof NotificationChannelCatalogUnavailableError) throw error;
          logger.debug('[activityNotifications] Failed to dispatch plugin notification', serializeAxiosErrorForLog(error));
        }
      }
    }
  }

  if (deliveredChannels > 0) {
    recordDeliveredNotificationForDedupe({ event: params.event, accountId, nowMs, dedupeWindowMs });
  }

  return {
    attemptedChannels,
    deliveredChannels,
  };
}
