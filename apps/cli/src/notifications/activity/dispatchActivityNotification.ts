import type { TargetSecretSourcesV1 } from '@/plugins/runtime/lifecycle/contributions/targetSecretSources';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { deriveSessionFollowOriginalOccurrenceKeyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { readActionErrorCodeV1, readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isPluginError } from '@happier-dev/protocol/plugins/errors';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { guardStopWarningNotificationIdV1 } from '@happier-dev/protocol/activity/webhookPayload';
import { isUsageQuotaNotificationEnabled } from '@happier-dev/protocol/account/settings/usagePacingPreferencesV1';
import { AccountNoticeArtifactHeaderV1Schema, AccountNoticeArtifactBodyV1Schema, ACCOUNT_NOTICE_ARTIFACT_KIND_V1,
  ServiceHealthNoticeNotificationV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import type { createAccountArtifactStore, AccountNoticeWriteReceipt } from '@/api/artifacts/accountArtifactStore';
import type { HealthCheckSourceConfigV1, HealthCheckAlertChannelV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import type { AttentionDeliveryDecision, PluginNotificationChannelKindV1, AccountSettings } from '@happier-dev/protocol';
import type { NotificationChannelCatalogSnapshotV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { isPushNotificationBundledSoundId, resolveExpoNotificationSoundName } from '@happier-dev/protocol/push/pushNotificationActions';
import { resolveAttentionDeliveryPolicyDecision, resolveAttentionPushSoundId } from '@happier-dev/protocol/account/settings/attentionDeliveryPolicyDecision';
import { ACTIVITY_REMOTE_ALERT_POLICY_EVENT_V1 } from '@happier-dev/protocol/push/activityRemoteAlert';
import { isFollowDeliveryMutedV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { readAccountSessionDeliveryMutedScopes } from '@/api/sessionDeliveryMuteTransport';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';

import type { PushNotificationClient, PushNotificationDeliveryOptions } from '@/api/pushNotifications';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { logger } from '@/ui/logger';
import { SavedSecretResolutionError, type SavedSecretMaterializerV1 } from '@/settings/secrets/savedSecretCatalog';
import type { ActivityNotificationEvent } from './activityNotificationEvent';
import type { StablePluginNotificationsOwner } from '@/plugins/runtime/invocation/services/notifications';
import type { PluginContributionRef } from '@happier-dev/plugin-sdk';
import { buildActivityNotificationContent } from './buildActivityNotificationContent';
import { createHostPluginNotificationChannels } from './pluginNotificationChannels';
import { NotificationChannelCatalogUnavailableError, prepareRuntimeNotificationCatalogRead, readRuntimeNotificationCatalog } from './runtimeNotificationCatalog';
export { NotificationChannelCatalogUnavailableError } from './runtimeNotificationCatalog';
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
  if (topic === 'plugin_notification') return event.type === 'approval' ? channel.topics.permissionRequest === true
    : event.type === 'decision' || event.type === 'blocked' ? channel.topics.userActionRequest === true : channel.topics.ready === true;
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

const DEFAULT_ACTIVITY_DEDUPE_WINDOW_MS = 60_000;
const recentDispatchesByKey = new Map<string, Readonly<{ dispatchedAtMs: number; expiresAtMs: number }>>();
let nextDedupeSweepAtMs = Number.NEGATIVE_INFINITY;

function pruneExpiredDedupeRecords(nowMs: number): void {
  if (nowMs < nextDedupeSweepAtMs) return;
  // Sweep on dispatch at most once per default window. Records can settle out
  // of order and use different windows, so insertion order cannot imply expiry.
  nextDedupeSweepAtMs = nowMs + DEFAULT_ACTIVITY_DEDUPE_WINDOW_MS;
  const previousSize = recentDispatchesByKey.size;
  for (const [key, record] of recentDispatchesByKey) {
    if (record.expiresAtMs <= nowMs) recentDispatchesByKey.delete(key);
  }
  const evicted = previousSize - recentDispatchesByKey.size;
  if (evicted > 0) {
    logger.infoFile('[activityNotifications] Expired dedupe records', { evicted, retained: recentDispatchesByKey.size });
  }
}

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
  const lastDispatch = recentDispatchesByKey.get(key);
  return lastDispatch !== undefined && input.nowMs - lastDispatch.dispatchedAtMs < input.dedupeWindowMs;
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
  recentDispatchesByKey.set(key, { dispatchedAtMs: input.nowMs, expiresAtMs: input.nowMs + input.dedupeWindowMs });
}

export function resolveActivityNotificationPolicyEvent(
  event: ActivityNotificationEvent,
): string {
  if (event.topic === 'plugin_notification') return event.eventId;
  if (event.topic === 'connected_service_credential_health') {
    return 'connected_service_account_switch';
  }
  if (event.topic !== 'workflow_run_update') return event.topic;
  if (event.updateKind === 'completed' || event.updateKind === 'completed_with_failures') {
    return 'task_completed';
  }
  if (event.updateKind === 'failed' || event.updateKind === 'outcome_uncertain') return ACTIVITY_REMOTE_ALERT_POLICY_EVENT_V1.failed;
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
    // Saved health phases select outward delivery independently of the Inbox
    // row's presentation type. Quiet hours and channel policy still apply.
    ...(params.event.topic === 'plugin_notification' && params.event.type ? { inboxItemType: params.event.type } : {}),
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
  const soundId = resolveAttentionPushSoundId(decision);
  return {
    sound: resolveExpoNotificationSoundName(soundId) ?? null,
    priority: 'high',
    ...(isPushNotificationBundledSoundId(soundId) ? { androidSoundId: soundId } : {}),
  };
}

/** Discovery projects the same configured delivery set the Activity owner dispatches. */
export async function listActivityNotificationChannels(params: Readonly<{
  settings: AccountSettings | null | undefined;
  operationContext?: SavedSecretOperationContextV1;
  secretSources?: TargetSecretSourcesV1;
  notificationChannelCatalog?: NotificationChannelCatalogSnapshotV1;
  savedSecretMaterializer?: SavedSecretMaterializerV1;
  isCurrent?: () => boolean | Promise<boolean>;
  pluginNotifications?: Pick<StablePluginNotificationsOwner, 'availableHostChannels'> | null;
  pushTokenReader?: Pick<PushNotificationClient, 'fetchPushTokens'>;
}>): Promise<readonly Readonly<{ value: string; label: string; disabled: boolean; destinationSetup?: PluginContributionRef }>[]> {
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
      .map(({ value, label, kind, destinationSetup }) => ({ value, label, disabled: !configuredForNotifyMe(kind),
        ...(destinationSetup ? { destinationSetup } : {}) })),
  ];
}

function notificationFailureCause(error: unknown) {
  const diagnostic = readUnexpectedActionErrorDiagnosticV1(error);
  const classification = classifyServerEndpointError(error);
  return { errorClass: diagnostic.errorClass,
    errorCode: error instanceof NotificationChannelCatalogUnavailableError || error instanceof SavedSecretResolutionError
      ? error.code : (isPluginError(error) ? readActionErrorCodeV1(error) : diagnostic.errorCode) ?? classification.kind,
    retryable: classification.retryable,
    ...(classification.statusCode === undefined ? {} : { httpStatus: classification.statusCode }) };
}

function notificationOccurrenceDiagnostic(event: ActivityNotificationEvent) {
  if (event.topic === 'follow_update' && 'sessionId' in event) {
    return { occurrenceId: deriveSessionFollowOriginalOccurrenceKeyV1({ sourceSessionId: event.sessionId, ...event.follow }) ?? randomUUID(),
      sourceSessionId: event.sessionId,
      ...('sourceTurn' in event.follow && event.follow.sourceTurn ? { sourceTurnId: event.follow.sourceTurn.id }
        : 'sourceMessage' in event.follow && event.follow.sourceMessage ? { sourceMessageSeq: event.follow.sourceMessage.seq }
          : 'sourceRequests' in event.follow && event.follow.sourceRequests ? { agentStateVersion: event.follow.sourceRequests.agentStateVersion } : {}) };
  }
  if (event.topic === 'ready' && event.committedLocalId && event.committedSequence !== undefined) {
    return { occurrenceId: deriveSessionFollowOriginalOccurrenceKeyV1({ sourceSessionId: event.sessionId,
      sourceMessage: { localId: event.committedLocalId, seq: event.committedSequence } }),
      sourceSessionId: event.sessionId, sourceMessageSeq: event.committedSequence };
  }
  if (event.topic === 'follow_update' && 'original' in event.follow && 'source' in event.follow.original) {
    return { occurrenceId: deriveSessionFollowOriginalOccurrenceKeyV1(event.follow.original) ?? randomUUID() };
  }
  // A diagnostic invocation id only when the event has no scalar Follow original.
  // Never derive it from, or log, notification bodies, authored localIds or endpoints.
  return { occurrenceId: randomUUID(), ...('sessionId' in event && event.sessionId ? { sourceSessionId: event.sessionId } : {}) };
}

type NotificationChannelOutcome = Readonly<{
  channelId: string;
  kind: PluginNotificationChannelKindV1 | 'account_notice';
  status: 'delivered' | 'failed';
  cause?: Readonly<{ errorCode: string; retryable: boolean }>;
}>;

/** One file-only info receipt per dispatch, including zero-attempt and failed preparation. */
export async function dispatchActivityNotificationAsync(params: Parameters<typeof dispatchActivityNotification>[0]) {
  const outcome: { attemptedChannels: number; deliveredChannels: number; channels: NotificationChannelOutcome[] } = {
    attemptedChannels: 0, deliveredChannels: 0, channels: [],
  };
  let cause: ReturnType<typeof notificationFailureCause> | undefined;
  try {
    return await dispatchActivityNotification(params, outcome);
  } catch (error) {
    cause = notificationFailureCause(error);
    throw error;
  } finally {
    logger.infoFile('[activityNotifications] Dispatch outcome', { ...notificationOccurrenceDiagnostic(params.event),
      topic: params.event.topic, attemptedChannels: outcome.attemptedChannels, deliveredChannels: outcome.deliveredChannels,
      failedChannels: outcome.attemptedChannels - outcome.deliveredChannels, channels: outcome.channels,
      ...(cause ? { cause } : {}) });
  }
}

/** A diagnostic borrows the same policy decision and transport as real delivery. */
export async function dispatchSavedHealthAlertTestAsync(params: Omit<Parameters<typeof dispatchActivityNotification>[0],
  'event' | 'channels' | 'channelDestinations' | 'serviceHealthCommit' | 'onChannelSuppressed'> & Readonly<{
    channel: HealthCheckAlertChannelV1;
  }>): Promise<Readonly<{ status: 'sent' | 'paused' } | { status: 'unavailable'; reason: string }>> {
  const { channel, ...runtime } = params;
  let quietHours = false;
  const result = await dispatchActivityNotificationAsync({ ...runtime,
    channels: [channel.channelId], channelDestinations: [channel],
    event: { topic: 'notify_me', title: 'Health alert test', message: 'Your saved health alert destination is working.' },
    onChannelSuppressed: (_channelId, reason) => { if (reason === 'quiet_hours') quietHours = true; },
  });
  return result.deliveredChannels > 0 ? { status: 'sent' } : quietHours ? { status: 'paused' }
    : { status: 'unavailable', reason: 'notification_delivery_unavailable' };
}

async function dispatchActivityNotification(params: Readonly<{
  settings: AccountSettings | null | undefined;
  /** Stops preparation; an admitted occurrence retains its delivery settlement. */
  signal?: AbortSignal;
  operationContext?: SavedSecretOperationContextV1;
  secretSources?: TargetSecretSourcesV1;
  notificationChannelCatalog?: NotificationChannelCatalogSnapshotV1;
  savedSecretMaterializer?: SavedSecretMaterializerV1;
  isCurrent?: (signal?: AbortSignal) => boolean | Promise<boolean>;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  event: ActivityNotificationEvent;
  /** Derive admitted notification content without changing event identity or policy. */
  prepareEventContent?: () => Promise<ActivityNotificationEvent>;
  /** Current local-controller native delivery only; external destinations need source opt-in. */
  serviceHealthCommit?: Readonly<{
    receipt: AccountNoticeWriteReceipt; machineId: string; controllerMachineId: string | null | undefined;
    alerts?: HealthCheckSourceConfigV1['alerts'];
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
  settledFinished?: true;
  channels?: readonly string[];
  channelDestinations?: readonly HealthCheckAlertChannelV1[];
  /** The selected-channel policy owner reports suppression to explicit diagnostic callers. */
  onChannelSuppressed?: (channelId: string, reason: AttentionDeliveryDecision['reason']) => void;
  pluginNotifications?: Pick<StablePluginNotificationsOwner, 'availableHostChannels' | 'sendHostNotification'> | null;
  usageNoticeArtifactStore?: Readonly<{ accountId: string; store: Pick<ReturnType<typeof createAccountArtifactStore>, 'create'> }>;
  /** Existing source-owned personal Follow CAS before outward delivery. Inbox rows stay derived. */
  acceptSourceFollowDelivery?: () => Promise<boolean>;
}>, outcome: { attemptedChannels: number; deliveredChannels: number; channels: NotificationChannelOutcome[] }
): Promise<Readonly<{ attemptedChannels: number; deliveredChannels: number }>> {
  params.signal?.throwIfAborted();
  const readRuntimeCatalog = prepareRuntimeNotificationCatalogRead(params);
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
    const alerts = admission.alerts;
    const phase = opening.data.healthPhase ?? 'open';
    if (alerts ? alerts.channels.length === 0 || !alerts.phases.includes(phase)
      : phase !== 'open' || opening.data.type !== 'blocked') {
      return { attemptedChannels: 0, deliveredChannels: 0 };
    }
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
      ...(source.kind === 'execution_run' && 'sessionId' in source ? { senderSessionId: source.sessionId } : {}) }
      : { senderSessionId: sourceSessionId!, source: { kind: 'session', sessionId: sourceSessionId! } }))
      return { attemptedChannels: 0, deliveredChannels: 0 };
  }
  if (params.event.topic === 'connected_service_usage'
    && !isUsageQuotaNotificationEnabled(accountSettingsParse(params.operationContext?.readSnapshot()?.settings
      ?? params.settings ?? {}).usageQuotaNotificationsV1, params.event.kind)) {
    return { attemptedChannels: 0, deliveredChannels: 0 };
  }
  const runtime = await readRuntimeCatalog();
  const settings = accountSettingsParse(runtime.settings ?? {});
  // Plugin-native events use only the host push bridge, including during signing preflight.
  const channels = params.event.topic === 'plugin_notification'
    ? runtime.channels.filter(channel => channel.kind === 'expo_push') : runtime.channels;
  let preparationSignal = params.signal;
  const assertCurrent = () => runtime.assertCurrent(preparationSignal);
  await assertCurrent();
  const nowMs = params.nowMs?.() ?? Date.now();
  pruneExpiredDedupeRecords(nowMs);
  const dedupeWindowMs = params.dedupeWindowMs ?? DEFAULT_ACTIVITY_DEDUPE_WINDOW_MS;
  const accountId = params.usageNoticeArtifactStore?.accountId;
  if (isSuppressedDuplicate({ event: params.event, accountId, nowMs, dedupeWindowMs })) {
    return { attemptedChannels: 0, deliveredChannels: 0 };
  }
  const policyNow = new Date(nowMs);
  const channelDecision = (channel: PluginNotificationChannelKindV1) => resolveChannelDecision({
    settings, channel, event: params.event, now: policyNow,
    follow: params.event.topic === 'follow_update' ? admission.follow : params.follow ?? admission.follow,
  });
  const recordChannel = (channelId: string, kind: NotificationChannelOutcome['kind'], cause?: NotificationChannelOutcome['cause']) => {
    outcome.channels.push({ channelId, kind, status: cause ? 'failed' : 'delivered', ...(cause ? { cause } : {}) });
  };
  const selectedChannelIds = serviceHealth
    ? new Set(params.serviceHealthCommit?.alerts?.channels.map(channel => channel.channelId)
      ?? channels.filter(channel => channel.kind === 'expo_push' && (!params.channels || params.channels.includes(channel.id)))
        .map(channel => channel.id))
    : params.channels ? new Set(params.channels) : null;
  const selects = (id: string) => !selectedChannelIds || selectedChannelIds.has(id);
  const channelDestinations = params.serviceHealthCommit?.alerts?.channels ?? params.channelDestinations;
  const pluginNotifications = serviceHealth && params.serviceHealthCommit?.alerts === undefined ? null : params.pluginNotifications === undefined
    ? createHostPluginNotificationChannels()
    : params.pluginNotifications;
  let preparedEventContent: ActivityNotificationEvent | undefined;
  const readEventContent = async () => preparedEventContent ??= await params.prepareEventContent?.() ?? params.event;

  // Admit the entire selected signing set before any outward delivery. A
  // missing credential must not produce a partially delivered occurrence.
  const savedSecretMaterializer = await runtime.acquireSigningMaterializer(channels.flatMap(channel =>
    channel.kind === 'webhook' && selects(channel.id) && isTopicEnabled(channel, params.event)
      && channelDecision('webhook').delivery !== 'suppress' && channel.signingSecretRef
      ? [channel.signingSecretRef] : []), params.signal);
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
      outcome.attemptedChannels += 1;
      preparationSignal = undefined;
      try {
        await params.usageNoticeArtifactStore.store.create({
          noticeAccountId: params.usageNoticeArtifactStore.accountId,
          beforeWrite: assertCurrent,
          header: AccountNoticeArtifactHeaderV1Schema.parse({ v: 1, kind: ACCOUNT_NOTICE_ARTIFACT_KIND_V1,
            title: content.body || content.title, status: 'open', resolved: false, type: 'update', source: { kind: 'host', topic: notice.topic }, notice }),
          body: JSON.stringify(AccountNoticeArtifactBodyV1Schema.parse({ v: 1, resolved: false, type: 'update', source: { kind: 'host', topic: notice.topic }, notice })),
        });
        outcome.deliveredChannels += 1;
        recordChannel('account_notice', 'account_notice');
      } catch (error) {
        // The Artifact id is this Account's witnessed occurrence. Never overwrite
        // its read/dismiss state or deliver the same occurrence again.
        if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'conflict') {
          recordChannel('account_notice', 'account_notice', { errorCode: 'conflict', retryable: false });
          return { attemptedChannels: outcome.attemptedChannels, deliveredChannels: outcome.deliveredChannels };
        } else {
          recordChannel('account_notice', 'account_notice', notificationFailureCause(error));
          throw error;
        }
      }
    }
  }
  if (sourceFollow || params.event.topic === 'follow_update' && 'sourceTurn' in params.event.follow) preparationSignal = undefined;
  if ((sourceFollow || params.event.topic === 'follow_update' && 'sourceTurn' in params.event.follow)
    && !await params.acceptSourceFollowDelivery?.()) {
    return { attemptedChannels: outcome.attemptedChannels, deliveredChannels: outcome.deliveredChannels };
  }

  const expoDecision = channelDecision('expo_push');
  for (const channel of channels) {
    if (channel.kind !== 'expo_push' || !selects(channel.id) || !isTopicEnabled(channel, params.event)
      || admission.homeOwnsPush) continue;
    if (expoDecision.delivery === 'suppress') {
      params.onChannelSuppressed?.(channel.id, expoDecision.reason);
      continue;
    }
    outcome.attemptedChannels += 1;
    if (params.expoPushSender) {
      const event = await readEventContent();
      try { await assertCurrent(); } catch (error) {
        recordChannel(channel.id, 'expo_push', notificationFailureCause(error));
        throw error;
      }
      try {
        preparationSignal = undefined;
        const accepted = await sendExpoPushActivityNotificationAsync({
          channel,
          event,
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
        if (accepted) outcome.deliveredChannels += 1;
        recordChannel(channel.id, 'expo_push', accepted ? undefined : { errorCode: 'not_accepted', retryable: false });
      } catch (error) {
        recordChannel(channel.id, 'expo_push', notificationFailureCause(error));
        logger.debug('[activityNotifications] Failed to dispatch outbound notification', serializeAxiosErrorForLog(error));
      }
    } else {
      recordChannel(channel.id, 'expo_push', { errorCode: 'sender_unavailable', retryable: false });
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
    outcome.attemptedChannels += 1;
    preparationSignal = undefined;
    try {
      await sendLiveActivityRemoteUpdate({
        request: liveActivityRequest,
        sender: params.liveActivityRemoteSender,
      });
      outcome.deliveredChannels += 1;
      recordChannel('live_activity', 'live_activity');
    } catch (error) {
      recordChannel('live_activity', 'live_activity', notificationFailureCause(error));
      logger.debug('[activityNotifications] Failed to dispatch Live Activity remote update', serializeAxiosErrorForLog(error));
    }
  }

  for (const channel of channels) {
    if (channel.kind !== 'webhook') continue;
    if (!selects(channel.id)) continue;
    if (!isTopicEnabled(channel, params.event)) continue;
    const decision = channelDecision('webhook');
    if (decision.delivery === 'suppress') {
      params.onChannelSuppressed?.(channel.id, decision.reason);
      continue;
    }
    const event = await readEventContent();
    // Prepared content keeps the occurrence's topic; plugin-native events never reach webhooks.
    if (event.topic === 'plugin_notification') continue;
    await assertCurrent();
    outcome.attemptedChannels += 1;
    preparationSignal = undefined;
    try {
      await sendWebhookActivityNotificationAsync({
        channel,
        previewBehavior: decision.previewBehavior,
        event,
        savedSecretMaterializer,
        assertCurrent,
        nowMs: params.nowMs,
        ...(params.webhookNetwork ? { network: params.webhookNetwork } : {}),
      });
      outcome.deliveredChannels += 1;
      recordChannel(channel.id, 'webhook');
    } catch (error) {
      recordChannel(channel.id, 'webhook', notificationFailureCause(error));
      if (error instanceof NotificationChannelCatalogUnavailableError) throw error;
      logger.debug('[activityNotifications] Failed to dispatch outbound notification', serializeAxiosErrorForLog(error));
    }
  }

  if (pluginNotifications) {
    const pluginChannels = await pluginNotifications.availableHostChannels();
    preparationSignal?.throwIfAborted();
    for (const channel of pluginChannels) {
      await assertCurrent();
      if (!selects(channel.value)) continue;
      const decision = channelDecision(channel.kind);
      if (decision.delivery === 'suppress') params.onChannelSuppressed?.(channel.value, decision.reason);
      if (decision.delivery !== 'suppress') {
        const event = await readEventContent();
        const destinations = channelDestinations === undefined ? [undefined]
          : channelDestinations.filter(selected => selected.channelId === channel.value).map(selected => selected.destination);
        for (const destination of destinations) {
          outcome.attemptedChannels += 1;
          preparationSignal = undefined;
          try {
            const content = buildActivityNotificationContent(event, {
              readyIncludeMessageText: decision.previewBehavior === 'include_preview',
              requestIncludeMessageText: decision.previewBehavior === 'include_preview',
              previewBehavior: decision.previewBehavior,
              nowMs,
            });
            const accepted = await pluginNotifications.sendHostNotification({
              channelId: channel.value, title: content.title, body: content.body, data: content.data,
              destination,
              beforeSend: assertCurrent,
            });
            if (accepted) outcome.deliveredChannels += 1;
            recordChannel(channel.value, channel.kind, accepted ? undefined : { errorCode: 'not_accepted', retryable: false });
          } catch (error) {
            recordChannel(channel.value, channel.kind, notificationFailureCause(error));
            if (error instanceof NotificationChannelCatalogUnavailableError) throw error;
            logger.debug('[activityNotifications] Failed to dispatch plugin notification', serializeAxiosErrorForLog(error));
          }
        }
      }
    }
  }

  if (outcome.deliveredChannels > 0) {
    recordDeliveredNotificationForDedupe({ event: params.event, accountId, nowMs, dedupeWindowMs });
  }

  return {
    attemptedChannels: outcome.attemptedChannels,
    deliveredChannels: outcome.deliveredChannels,
  };
}
