import { isDeepStrictEqual } from 'node:util';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { guardStopWarningNotificationIdV1 } from '@happier-dev/protocol/activity/webhookPayload';
import { isUsageQuotaNotificationEnabled } from '@happier-dev/protocol/account/settings/usagePacingPreferencesV1';
import { AccountNoticeArtifactHeaderV1Schema, AccountNoticeArtifactBodyV1Schema, ACCOUNT_NOTICE_ARTIFACT_KIND_V1, ServiceHealthNoticeNotificationV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import type { AccountNoticeWriteReceipt, createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import type { AttentionDeliveryDecision, AttentionDeliveryEventId, PluginNotificationChannelKindV1, AccountSettings } from '@happier-dev/protocol';
import type { NotificationChannelCatalogSnapshotV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { isPushNotificationBundledSoundId, resolveExpoNotificationSoundName } from '@happier-dev/protocol/push/pushNotificationActions';
import { resolveAttentionDeliveryPolicyDecision } from '@happier-dev/protocol/account/settings/attentionDeliveryPolicyDecision';
import { isFollowDeliveryMutedV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { readAccountSessionDeliveryMutedScopes } from '@/api/sessionDeliveryMuteTransport';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';

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
import { hydrateNotificationChannelCatalogForOperation } from '@/settings/notifications/hydrateNotificationChannelCatalog';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { resolveSessionActivityNotificationAdmission, type SessionNotificationContextReader } from './sessionActivityNotificationEligibility';
import type { FollowEventV1, FollowPolicyV1, ResolveFollowDeliveryV1Params } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
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
    machines?: boolean;
  };
}, event: ActivityNotificationEvent): boolean {
  const topic = event.topic;
  if (channel.enabled !== true) return false;
  if (topic === 'service_health') return channel.topics.machines === true;
  if (topic === 'follow_update') return event.follow.event.kind === 'needs_you'
    ? event.follow.event.type === 'approval' ? channel.topics.permissionRequest === true : channel.topics.userActionRequest === true
    : channel.topics.ready === true;
  if (topic === 'workflow_run_update' || topic === 'notify_me') return true;
  if (topic === 'ready') return channel.topics.ready === true;
  if (topic === 'permission_request') return channel.topics.permissionRequest === true;
  if (topic === 'user_action_request') return channel.topics.userActionRequest === true;
  if (topic === 'connected_service_account_switch') return channel.topics.connectedServiceAccountSwitch === true;
  if (topic === 'connected_service_credential_health') return channel.topics.connectedServiceAccountSwitch === true;
  if (topic === 'connected_service_quota_blocked') return channel.topics.connectedServiceQuotaBlocked === true;
  if (topic === 'connected_service_quota_recovered') return channel.topics.connectedServiceQuotaRecovered === true;
  if (topic === 'connected_service_usage') return channel.topics.connectedServiceUsage === true;
  if (topic === 'guard_stop_warning' || topic === 'guard_attention' || topic === 'machine_guard_activity' || topic === 'resource_limit') return channel.topics.machines === true;
  return false;
}

const recentDispatchesByKey = new Map<string, number>();

function notificationDedupeKey(event: ActivityNotificationEvent, accountId?: string): string | null {
  if (event.topic === 'resource_limit') return accountId
    ? [event.topic, accountId, event.machineId, event.kind, 'volumeId' in event ? event.volumeId : '', event.phase, event.at].join('\0')
    : null;
  if (event.topic === 'machine_guard_activity') return [event.topic, event.machineId, event.episodeId].join('\0');
  if (event.topic === 'guard_stop_warning') return [event.topic, event.machineId, guardStopWarningNotificationIdV1(event)].join('\0');
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
): string {
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
  follow?: ResolveFollowDeliveryV1Params;
}>): AttentionDeliveryDecision {
  return resolveAttentionDeliveryPolicyDecision({
    policy: params.settings.attentionDeliveryPolicyV1,
    event: resolveActivityNotificationPolicyEvent(params.event),
    channel: params.channel,
    now: params.now,
    follow: params.follow,
    ...(params.event.topic === 'service_health' && params.event.type ? { inboxItemType: params.event.type } : {}),
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

async function readRuntimeNotificationCatalog(params: Readonly<{
  settings: AccountSettings | null | undefined;
  operationContext?: SavedSecretOperationContextV1;
  notificationChannelCatalog?: NotificationChannelCatalogSnapshotV1;
  savedSecretMaterializer?: SavedSecretMaterializerV1;
  isCurrent?: () => boolean | Promise<boolean>;
}>) {
  const operation = params.operationContext;
  if (operation) {
    if (!await operation.isCurrent()) throw new NotificationChannelCatalogUnavailableError('scope-retired');
    const existing = operation.readSnapshot()?.notificationChannelCatalog;
    if (!existing || existing.status === 'loading') await hydrateNotificationChannelCatalogForOperation({ operationContext: operation });
    const snapshot = operation.readSnapshot();
    if (!snapshot || !await operation.isCurrent()) throw new NotificationChannelCatalogUnavailableError('scope-retired');
    const catalog = snapshot.notificationChannelCatalog;
    if (catalog?.status !== 'ready') throw new NotificationChannelCatalogUnavailableError(
      catalog?.status === 'unavailable' ? catalog.reason : catalog?.status === 'partial' ? 'catalog-incomplete' : 'loading');
    return { settings: snapshot.settings, channels: catalog.channels,
      assertCurrent: async () => {
        if (!await operation.isCurrent() || operation.readSnapshot() !== snapshot || params.isCurrent && !await params.isCurrent()) {
          throw new NotificationChannelCatalogUnavailableError('scope-retired');
        }
      }, savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(snapshot,
        { isCurrent: () => operation.readSnapshot() === snapshot }) };
  }
  const active = getActiveAccountSettingsSnapshot();
  const captured = active?.settings === params.settings ? active : null;
  const catalog = params.notificationChannelCatalog ?? captured?.notificationChannelCatalog ?? { status: 'loading' as const };
  if (catalog.status !== 'ready') throw new NotificationChannelCatalogUnavailableError(
    catalog.status === 'unavailable' ? catalog.reason : catalog.status === 'partial' ? 'catalog-incomplete' : 'loading');
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const incumbent = !params.notificationChannelCatalog && captured?.scopeKey ? { scopeKey: captured.scopeKey, lifetimeToken } : null;
  return { settings: params.settings, channels: catalog.channels, assertCurrent: async () => {
    if (params.isCurrent && !await params.isCurrent()
      || incumbent && !isActiveAccountSettingsSnapshotLifetimeCurrent(incumbent)) throw new NotificationChannelCatalogUnavailableError('scope-retired');
  },
    savedSecretMaterializer: params.savedSecretMaterializer ?? (!params.notificationChannelCatalog && captured
      ? createSavedSecretMaterializerFromSnapshotV1(captured) : undefined) };
}

/** Discovery projects the same configured delivery set the Activity owner dispatches. */
export async function listActivityNotificationChannels(params: Readonly<{
  settings: AccountSettings | null | undefined;
  operationContext?: SavedSecretOperationContextV1;
  notificationChannelCatalog?: NotificationChannelCatalogSnapshotV1;
  savedSecretMaterializer?: SavedSecretMaterializerV1;
  isCurrent?: () => boolean | Promise<boolean>;
  pluginNotifications?: Pick<StablePluginNotificationsOwner, 'availableHostChannels'> | null;
  pushTokenReader?: Pick<PushNotificationClient, 'fetchPushTokens'>;
}>): Promise<readonly Readonly<{ value: string; label: string; disabled: boolean }>[]> {
  const runtime = await readRuntimeNotificationCatalog(params);
  const settings = accountSettingsParse(runtime.settings ?? {});
  const { channels, savedSecretMaterializer, assertCurrent } = runtime;
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
  signal?: AbortSignal;
  operationContext?: SavedSecretOperationContextV1;
  notificationChannelCatalog?: NotificationChannelCatalogSnapshotV1;
  savedSecretMaterializer?: SavedSecretMaterializerV1;
  isCurrent?: (signal?: AbortSignal) => boolean | Promise<boolean>;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  event: ActivityNotificationEvent;
  /** Current local-controller native delivery only; external destinations need source opt-in. */
  serviceHealthCommit?: Readonly<{
    receipt: AccountNoticeWriteReceipt; machineId: string; controllerMachineId: string | null | undefined;
  }>;
  expoPushSender?: ExpoPushActivityNotificationSender | null;
  liveActivityRemoteSender?: LiveActivityRemoteUpdateSender | null;
  nowMs?: () => number;
  dedupeWindowMs?: number;
  webhookNetwork?: WebhookActivityNotificationNetworkDependencies;
  fetchSessionNotificationContext?: SessionNotificationContextReader['fetchSessionNotificationContext'];
  readAccountSessionDeliveryMutedScopes?: SessionNotificationContextReader['readAccountSessionDeliveryMutedScopes'];
  follow?: ResolveFollowDeliveryV1Params;
  followEvent?: FollowEventV1;
  /** Only the admitted private evaluator supplies these; arbitrary Action policies are not an access grant. */
  admittedRulePolicies?: readonly FollowPolicyV1[];
  channels?: readonly string[];
  pluginNotifications?: Pick<StablePluginNotificationsOwner, 'availableHostChannels' | 'sendHostNotification'> | null;
  usageNoticeArtifactStore?: Readonly<{ accountId: string; store: Pick<ReturnType<typeof createAccountArtifactStore>, 'create'> }>;
  /** Existing source-owned personal Follow CAS before outward delivery. Inbox rows stay derived. */
  acceptSourceFollowDelivery?: () => Promise<boolean>;
}>): Promise<Readonly<{ attemptedChannels: number; deliveredChannels: number }>> {
  params.signal?.throwIfAborted();
  const serviceHealth = params.event.topic === 'service_health';
  if (serviceHealth) {
    const admission = params.serviceHealthCommit;
    const receipt = admission?.receipt;
    const opening = receipt?.changed ? ServiceHealthNoticeNotificationV1Schema.safeParse(receipt.healthOpening) : null;
    // No catalog hydration, credential materialization or delivery may precede
    // a committed opening and fresh proof that this daemon is its controller.
    if (!admission || !receipt?.changed || !receipt.revision || !opening?.success
      || receipt.artifactId !== opening.data.data.artifactId || !isDeepStrictEqual(opening.data, params.event)
      || !admission.controllerMachineId || admission.controllerMachineId !== admission.machineId
      || !params.isCurrent || !await params.isCurrent(params.signal)) {
      return { attemptedChannels: 0, deliveredChannels: 0 };
    }
    params.signal?.throwIfAborted();
  }
  const admission = await resolveSessionActivityNotificationAdmission(params);
  params.signal?.throwIfAborted();
  if (!admission.eligible) {
    return { attemptedChannels: 0, deliveredChannels: 0 };
  }
  const sourceSessionId = params.event.topic === 'ready' || params.event.topic === 'permission_request'
    || params.event.topic === 'user_action_request' || params.event.topic === 'follow_update' && 'sessionId' in params.event ? params.event.sessionId : null;
  const sourceFollow = params.event.topic === 'follow_update' && 'original' in params.event.follow ? params.event.follow : null;
  if (sourceSessionId || sourceFollow) {
    const operation = params.operationContext;
    const scopes = params.readAccountSessionDeliveryMutedScopes
      ? await params.readAccountSessionDeliveryMutedScopes()
      : operation && await operation.isCurrent() ? await readAccountSessionDeliveryMutedScopes({
          serverHttpBaseUrl: operation.serverHttpBaseUrl, token: operation.credentials.token,
          accountId: readAccountIdFromToken(operation.credentials.token) ?? '',
        }) : null;
    const original = sourceFollow?.original;
    const source = original ? 'kind' in original ? { kind: 'discussion' as const, discussionId: original.discussion.discussionId }
      : original.source : null;
    if (scopes === null || isFollowDeliveryMutedV1(scopes, source ? { source,
      ...(source.kind === 'execution_run' ? { senderSessionId: source.sessionId } : {}) }
      : { senderSessionId: sourceSessionId!, source: { kind: 'session', sessionId: sourceSessionId! } }))
      return { attemptedChannels: 0, deliveredChannels: 0 };
  }
  if (params.event.topic === 'connected_service_usage'
    && !isUsageQuotaNotificationEnabled(accountSettingsParse(params.operationContext?.readSnapshot()?.settings
      ?? params.settings ?? {}).usageQuotaNotificationsV1, params.event.kind)) {
    return { attemptedChannels: 0, deliveredChannels: 0 };
  }
  const runtime = await readRuntimeNotificationCatalog(params);
  const settings = accountSettingsParse(runtime.settings ?? {});
  const { channels, savedSecretMaterializer, assertCurrent } = runtime;
  await assertCurrent();
  const nowMs = params.nowMs?.() ?? Date.now();
  const dedupeWindowMs = params.dedupeWindowMs ?? 60_000;
  const accountId = params.usageNoticeArtifactStore?.accountId;
  if (isSuppressedDuplicate({ event: params.event, accountId, nowMs, dedupeWindowMs })) {
    return { attemptedChannels: 0, deliveredChannels: 0 };
  }
  const policyNow = new Date(nowMs);
  const channelDecision = (channel: PluginNotificationChannelKindV1) => resolveChannelDecision({
    settings, channel, event: params.event, now: policyNow,
    follow: params.event.topic === 'follow_update' ? admission.follow : params.follow ?? admission.follow,
  });
  let attemptedChannels = 0;
  let deliveredChannels = 0;
  const selectedChannelIds = serviceHealth
    ? new Set(channels.filter(channel => channel.kind === 'expo_push' && (!params.channels || params.channels.includes(channel.id)))
      .map(channel => channel.id))
    : params.channels ? new Set(params.channels) : null;
  const selects = (id: string) => !selectedChannelIds || selectedChannelIds.has(id);
  const pluginNotifications = serviceHealth ? null : params.pluginNotifications === undefined
    ? createHostPluginNotificationChannels()
    : params.pluginNotifications;

  // Admit the entire selected signing set before any outward delivery. A
  // missing credential must not produce a partially delivered occurrence.
  for (const channel of channels) {
    if (channel.kind !== 'webhook' || !selects(channel.id) || !isTopicEnabled(channel, params.event)) continue;
    const decision = channelDecision('webhook');
    if (decision.delivery !== 'suppress') {
      await resolveWebhookNotificationSigningSecret({ channel, savedSecretMaterializer });
    }
  }
  await assertCurrent();

  // Only notices own stored Inbox content. Run and Discussion rows read their
  // original owners, so their resolution cannot diverge from a copied Artifact.
  if ((params.event.topic === 'connected_service_usage' || params.event.topic === 'resource_limit')
    && params.usageNoticeArtifactStore && !selectedChannelIds) {
    const decision = channelDecision('badge');
    if (decision.delivery !== 'suppress') {
      const notice = params.event;
      const content = buildActivityNotificationContent(notice, {
        readyIncludeMessageText: true, requestIncludeMessageText: true, previewBehavior: 'include_preview',
      });
      await assertCurrent();
      attemptedChannels += 1;
      try {
        await params.usageNoticeArtifactStore.store.create({
          noticeAccountId: params.usageNoticeArtifactStore.accountId,
          beforeWrite: assertCurrent,
          header: AccountNoticeArtifactHeaderV1Schema.parse({ v: 1, kind: ACCOUNT_NOTICE_ARTIFACT_KIND_V1,
            title: content.body || content.title, status: 'open', resolved: false, type: 'update', source: { kind: 'host', topic: notice.topic }, notice }),
          body: JSON.stringify(AccountNoticeArtifactBodyV1Schema.parse({ v: 1, resolved: false, type: 'update', source: { kind: 'host', topic: notice.topic }, notice })),
        });
        deliveredChannels += 1;
      } catch (error) {
        // The Artifact id is this Account's witnessed occurrence. Never overwrite
        // its read/dismiss state or deliver the same occurrence again.
        if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'conflict') {
          return { attemptedChannels, deliveredChannels };
        } else {
          throw error;
        }
      }
    }
  }
  if (sourceFollow && !await params.acceptSourceFollowDelivery?.()) {
    return { attemptedChannels, deliveredChannels };
  }

  const expoDecision = channelDecision('expo_push');
  for (const channel of channels) {
    if (channel.kind !== 'expo_push' || !selects(channel.id) || !isTopicEnabled(channel, params.event)
      || expoDecision.delivery === 'suppress' || admission.homeOwnsPush) continue;
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
            ...(params.event.topic === 'resource_limit' && params.event.phase === 'recovered'
              ? { sound: null, priority: 'normal' as const, androidSoundId: 'none' } : {}),
            ...(expoDecision.suppressIfComputerFocused === true ? { suppressIfComputerFocused: true } : {}),
          },
          previewBehavior: expoDecision.previewBehavior,
          nowMs,
        });
        if (accepted) deliveredChannels += 1;
      } catch (error) {
        logger.debug('[activityNotifications] Failed to dispatch outbound notification', serializeAxiosErrorForLog(error));
      }
    }
  }

  const liveActivityDecision = channelDecision('live_activity');
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
    if (!isTopicEnabled(channel, params.event)) continue;
    const decision = channelDecision('webhook');
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
      const decision = channelDecision(channel.kind);
      if (decision.delivery !== 'suppress') {
        attemptedChannels += 1;
        try {
          const content = buildActivityNotificationContent(params.event, {
            readyIncludeMessageText: decision.previewBehavior === 'include_preview',
            requestIncludeMessageText: decision.previewBehavior === 'include_preview',
            previewBehavior: decision.previewBehavior,
            nowMs,
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
