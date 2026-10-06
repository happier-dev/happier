import { createHash, randomUUID } from 'node:crypto';

import { HAPPIER_FOCUS_LIVE_ACTIVITY_NAME, LIVE_ACTIVITY_CONTENT_STATE_MAX_BYTES, LIVE_ACTIVITY_ALERT_TITLE_MAX_LENGTH, LIVE_ACTIVITY_ALERT_BODY_MAX_LENGTH, LiveActivityRemoteUpdateRequestV1Schema } from '@happier-dev/protocol/activity/live/remoteUpdates';
import { PUSH_NOTIFICATION_BUNDLED_SOUND_FILES, resolveExpoNotificationSoundName } from '@happier-dev/protocol/push/pushNotificationActions';
import type { AttentionDeliveryDecision, HappierFocusLiveActivityAttentionState, HappierFocusLiveActivityContentStateV1, LiveActivityRemoteTransportMode, LiveActivityRemoteUpdateRequestV1 } from '@happier-dev/protocol';

import { logger } from '@/ui/logger';

import type { ActivityNotificationEvent } from '../activityNotificationEvent';
import { buildActivityNotificationContent } from '../buildActivityNotificationContent';

const LIVE_ACTIVITY_LABELS = {
  title: 'Happier',
  openLabel: 'Open',
  inboxLabel: 'Inbox',
  attentionLabel: 'Attention',
} as const satisfies HappierFocusLiveActivityContentStateV1['labels'];

const LIVE_ACTIVITY_DEFAULT_TARGET = 'open-inbox';
const LIVE_ACTIVITY_DEFAULT_TITLE = 'Happier';
const LIVE_ACTIVITY_ACTION_BUTTONS_ENABLED = true;

type LiveActivityInterruptiveAlert =
  NonNullable<Extract<LiveActivityRemoteUpdateRequestV1, { event: 'update' }>['interruptiveAlert']>;
type LiveActivityNotificationEvent = Exclude<
  ActivityNotificationEvent,
  Readonly<{ topic: 'workflow_run_update' | 'notify_me' }>
>;

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

function truncateDisplayText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 0) return '';
  let prefix = value.slice(0, maxLength - 1);
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return `${prefix}…`;
}

function fitContentStateBudget(state: HappierFocusLiveActivityContentStateV1): HappierFocusLiveActivityContentStateV1 {
  const bytes = (value: HappierFocusLiveActivityContentStateV1) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes(state) <= LIVE_ACTIVITY_CONTENT_STATE_MAX_BYTES) return state;
  const fields = ['title', 'subtitle', 'previewText', 'statusText'] as const;
  const project = (maxLength: number) => {
    const next = { ...state };
    for (const field of fields) {
      const value = state[field];
      if (typeof value === 'string') next[field] = truncateDisplayText(value, maxLength);
    }
    return next;
  };
  // Share the available display space; never truncate session routing or state facts.
  let low = 0;
  let high = Math.max(...fields.map((field) => state[field]?.length ?? 0));
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes(project(middle)) <= LIVE_ACTIVITY_CONTENT_STATE_MAX_BYTES) low = middle;
    else high = middle - 1;
  }
  return project(low);
}

function resolveTransportMode(mode: string | null | undefined): LiveActivityRemoteTransportMode | null {
  if (
    mode === 'hosted_happier_relay'
    || mode === 'direct_apns'
    || mode === 'background_wake_best_effort'
  ) {
    return mode;
  }
  return null;
}

function resolveAttentionState(event: ActivityNotificationEvent): HappierFocusLiveActivityAttentionState {
  if (event.topic === 'permission_request') return 'permission_required';
  if (event.topic === 'user_action_request') return 'action_required';
  return 'unread';
}

function buildSessionTarget(params: Readonly<{ serverId: string; sessionId: string }>): string {
  return `open-session:${encodeURIComponent(params.sessionId)}?serverId=${encodeURIComponent(params.serverId)}`;
}

function resolveTitle(params: Readonly<{
  event: LiveActivityNotificationEvent;
  notificationTitle: string;
  previewBehavior: AttentionDeliveryDecision['previewBehavior'];
}>): string {
  if (params.previewBehavior === 'status_only') return LIVE_ACTIVITY_DEFAULT_TITLE;
  return normalizeText(params.event.sessionTitle)
    ?? normalizeText(params.notificationTitle)
    ?? LIVE_ACTIVITY_DEFAULT_TITLE;
}

function resolveSubtitle(params: Readonly<{
  event: ActivityNotificationEvent;
  previewBehavior: AttentionDeliveryDecision['previewBehavior'];
}>): string | null {
  if (params.previewBehavior !== 'include_preview') return null;
  const { event } = params;
  if (event.topic === 'ready') {
    return normalizeText(event.waitingForCommandLabel);
  }
  if (event.topic === 'permission_request' || event.topic === 'user_action_request') {
    return normalizeText(event.toolName);
  }
  if (event.topic === 'connected_service_account_switch') return 'Provider account switched';
  if (event.topic === 'connected_service_quota_recovered') return 'Provider quota recovered';
  return 'Provider quota blocked';
}

function resolveGenericStatusText(event: ActivityNotificationEvent): string {
  if (event.topic === 'ready') return 'Ready';
  if (event.topic === 'permission_request') return 'Permission required';
  if (event.topic === 'connected_service_account_switch') return 'Provider account switched';
  if (event.topic === 'connected_service_quota_blocked') return 'Provider quota blocked';
  if (event.topic === 'connected_service_quota_recovered') return 'Provider quota recovered';
  return 'Action required';
}

function resolveStatusText(params: Readonly<{
  event: ActivityNotificationEvent;
  notificationBody: string;
  previewBehavior: AttentionDeliveryDecision['previewBehavior'];
}>): string | null {
  if (params.previewBehavior !== 'include_preview') {
    return resolveGenericStatusText(params.event);
  }
  return normalizeText(params.notificationBody);
}

function resolvePreviewText(params: Readonly<{
  event: ActivityNotificationEvent;
  notificationBody: string;
  toolDetails?: string | null;
  previewBehavior: AttentionDeliveryDecision['previewBehavior'];
}>): string | null {
  if (params.previewBehavior !== 'include_preview') return null;
  if (params.event.topic === 'ready') {
    return normalizeText(params.event.assistantPreviewText);
  }
  return normalizeText(params.toolDetails) ?? normalizeText(params.notificationBody);
}

function buildSnapshotFingerprint(contentState: HappierFocusLiveActivityContentStateV1): string {
  const { generatedAt: _generatedAt, staleAt: _staleAt, ...stableContentState } = contentState;
  return `sha256:${createHash('sha256').update(JSON.stringify(stableContentState)).digest('hex')}`;
}

function resolveInterruptiveAlertSound(
  decision: AttentionDeliveryDecision,
): LiveActivityInterruptiveAlert['sound'] | undefined {
  if (decision.sound.kind === 'system_default') return 'default';
  if (decision.sound.kind !== 'bundled') return undefined;
  const sound = resolveExpoNotificationSoundName(decision.sound.id);
  if (
    sound === PUSH_NOTIFICATION_BUNDLED_SOUND_FILES.soft.expoSoundName
    || sound === PUSH_NOTIFICATION_BUNDLED_SOUND_FILES.urgent.expoSoundName
  ) {
    return sound;
  }
  return undefined;
}

function resolveInterruptiveAlert(params: Readonly<{
  event: ActivityNotificationEvent;
  decision: AttentionDeliveryDecision;
  title: string;
  body: string;
}>): LiveActivityInterruptiveAlert | undefined {
  if (params.event.topic === 'ready') return undefined;
  if (params.decision.delivery !== 'deliver') return undefined;
  if (params.decision.sound.kind === 'none') return undefined;
  const sound = resolveInterruptiveAlertSound(params.decision);
  return {
    title: truncateDisplayText(params.title, LIVE_ACTIVITY_ALERT_TITLE_MAX_LENGTH),
    body: truncateDisplayText(params.body, LIVE_ACTIVITY_ALERT_BODY_MAX_LENGTH),
    ...(sound ? { sound } : {}),
  };
}

export function buildLiveActivityRemoteUpdateRequest(params: Readonly<{
  event: ActivityNotificationEvent;
  decision: AttentionDeliveryDecision;
  serverId: string;
  nowMs: number;
  requestId?: string;
}>): LiveActivityRemoteUpdateRequestV1 | null {
  if (params.decision.delivery === 'suppress') return null;
  const event = params.event;
  if (event.topic === 'workflow_run_update' || event.topic === 'notify_me') return null;
  if (!event.sessionId) return null;

  const behavior = params.decision.liveActivityRemoteBehavior;
  const transportMode = resolveTransportMode(behavior?.mode);
  if (!transportMode || behavior?.freshness !== 'fresh') return null;

  const serverId = params.serverId.trim();
  if (!serverId) return null;

  const staleAt = Date.parse(behavior.staleAt ?? '');
  if (!Number.isFinite(staleAt) || staleAt <= params.nowMs) return null;

  const built = buildActivityNotificationContent(event, {
    readyIncludeMessageText: params.decision.previewBehavior === 'include_preview',
    requestIncludeMessageText: params.decision.previewBehavior === 'include_preview',
  });
  const contentState = fitContentStateBudget({
    version: 1,
    generatedAt: params.nowMs,
    staleAt,
    sessionId: event.sessionId,
    title: resolveTitle({
      event,
      notificationTitle: built.title,
      previewBehavior: params.decision.previewBehavior,
    }),
    subtitle: resolveSubtitle({
      event,
      previewBehavior: params.decision.previewBehavior,
    }),
    previewText: resolvePreviewText({
      event,
      notificationBody: built.body,
      toolDetails: built.toolDetails,
      previewBehavior: params.decision.previewBehavior,
    }),
    statusText: resolveStatusText({
      event,
      notificationBody: built.body,
      previewBehavior: params.decision.previewBehavior,
    }),
    attentionState: resolveAttentionState(event),
    defaultTarget: LIVE_ACTIVITY_DEFAULT_TARGET,
    sessionTarget: buildSessionTarget({ serverId, sessionId: event.sessionId }),
    overflowCount: 0,
    totalAttentionCount: 1,
    allowActionButtons: LIVE_ACTIVITY_ACTION_BUTTONS_ENABLED,
    labels: LIVE_ACTIVITY_LABELS,
  } satisfies HappierFocusLiveActivityContentStateV1);

  const interruptiveAlert = resolveInterruptiveAlert({
    event,
    decision: params.decision,
    title: contentState.title,
    body: contentState.statusText ?? contentState.title,
  });

  const request = {
    v: 1,
    requestId: params.requestId ?? `la-${randomUUID()}`,
    createdAt: params.nowMs,
    transportMode,
    activityKey: {
      serverId,
      sessionId: event.sessionId,
      activityName: HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
    },
    event: 'update',
    snapshotFingerprint: buildSnapshotFingerprint(contentState),
    contentState,
    ...(interruptiveAlert ? { interruptiveAlert } : {}),
  } satisfies LiveActivityRemoteUpdateRequestV1;

  const parsed = LiveActivityRemoteUpdateRequestV1Schema.safeParse(request);
  if (!parsed.success) {
    logger.warn('[activityNotifications] Live Activity update rejected by payload validation', { issueCount: parsed.error.issues.length });
    return null;
  }
  return parsed.data;
}
