export type LiveActivityApnsDeliveryAction =
  | 'success'
  | 'permanent_drop_target'
  | 'permanent_fix_payload'
  | 'operator_config'
  | 'transient_retry'
  | 'unknown_failure';

export type LiveActivityApnsDeliveryClassification = Readonly<{
  action: LiveActivityApnsDeliveryAction;
  reason?: string;
}>;

export const LIVE_ACTIVITY_APNS_PUSH_TYPE = 'liveactivity';

export type LiveActivityApnsTemplate = 'quietFocus' | 'urgentAttention';
export type LiveActivityApnsEvent = 'update' | 'end';
export type LiveActivityApnsPriority = 5 | 10;

export type LiveActivityApnsDeliveryFields = Readonly<{
  pushType: typeof LIVE_ACTIVITY_APNS_PUSH_TYPE;
  topic: string;
  priority: LiveActivityApnsPriority;
  collapseId: string;
  expiration: number;
  allowsAlert: boolean;
}>;

const DROP_TARGET_REASONS = new Set([
  'BadDeviceToken',
  'Unregistered',
]);

const OPERATOR_CONFIG_REASONS = new Set([
  'BadCertificate',
  'BadCertificateEnvironment',
  'BadTopic',
  'DeviceTokenNotForTopic',
  'ExpiredProviderToken',
  'InvalidProviderToken',
  'MissingProviderToken',
  'MissingTopic',
]);

const FIX_PAYLOAD_REASONS = new Set([
  'BadCollapseId',
  'BadExpirationDate',
  'BadMessageId',
  'BadPriority',
  'BadPushType',
  'BadRequest',
  'PayloadEmpty',
  'PayloadTooLarge',
]);

const QUIET_FOCUS_EXPIRATION_SECONDS = 30 * 60;
const URGENT_ATTENTION_EXPIRATION_SECONDS = 60;
const END_EXPIRATION_SECONDS = 5 * 60;
const APNS_COLLAPSE_ID_MAX_BYTES = 64;

function countUtf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const char of value) {
    const charBytes = countUtf8Bytes(char);
    if (bytes + charBytes > maxBytes) break;
    result += char;
    bytes += charBytes;
  }
  return result;
}

function hashCollapseIdSource(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, '0');
}

function normalizeReason(reason: unknown): string | undefined {
  if (typeof reason !== 'string') return undefined;
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildLiveActivityTopic(bundleId: string): string {
  return `${bundleId.trim()}.push-type.liveactivity`;
}

function buildLiveActivityCollapseId(params: Readonly<{
  activityId: string;
  event: LiveActivityApnsEvent;
  template: LiveActivityApnsTemplate;
}>): string {
  const activityId = params.activityId.trim() || 'activity';
  const collapseId = `${activityId}:${params.event}:${params.template}`;
  if (countUtf8Bytes(collapseId) <= APNS_COLLAPSE_ID_MAX_BYTES) {
    return collapseId;
  }

  const hash = hashCollapseIdSource(collapseId);
  const suffix = `:${params.event}:${params.template}:${hash}`;
  const prefixBudget = APNS_COLLAPSE_ID_MAX_BYTES - countUtf8Bytes(suffix);
  const prefix = truncateUtf8(activityId, Math.max(0, prefixBudget));
  return `${prefix}${suffix}`;
}

function resolveLiveActivityPriority(params: Readonly<{
  event: LiveActivityApnsEvent;
  template: LiveActivityApnsTemplate;
}>): LiveActivityApnsPriority {
  return params.event === 'update' && params.template === 'urgentAttention' ? 10 : 5;
}

function resolveLiveActivityExpirationSeconds(params: Readonly<{
  event: LiveActivityApnsEvent;
  priority: LiveActivityApnsPriority;
}>): number {
  if (params.priority === 10) return URGENT_ATTENTION_EXPIRATION_SECONDS;
  if (params.event === 'end') return END_EXPIRATION_SECONDS;
  return QUIET_FOCUS_EXPIRATION_SECONDS;
}

export function classifyLiveActivityApnsDeliveryResponse(params: Readonly<{
  status: number;
  reason?: string | null;
}>): LiveActivityApnsDeliveryClassification {
  const status = params.status;
  const reason = normalizeReason(params.reason);

  if (status >= 200 && status < 300) {
    return { action: 'success' };
  }

  if (status === 410 || (reason && DROP_TARGET_REASONS.has(reason))) {
    return { action: 'permanent_drop_target', reason };
  }

  if (status === 413 || (reason && FIX_PAYLOAD_REASONS.has(reason))) {
    return { action: 'permanent_fix_payload', reason };
  }

  if (status === 403 || (reason && OPERATOR_CONFIG_REASONS.has(reason))) {
    return { action: 'operator_config', reason };
  }

  if (status === 429 || status >= 500) {
    return { action: 'transient_retry', reason };
  }

  return { action: 'unknown_failure', reason };
}

export function deriveLiveActivityApnsDeliveryFields(params: Readonly<{
  bundleId: string;
  activityId: string;
  event: LiveActivityApnsEvent;
  template: LiveActivityApnsTemplate;
  nowEpochSeconds: number;
  quietHoursActive: boolean;
  alertRequested: boolean;
}>): LiveActivityApnsDeliveryFields {
  const priority = resolveLiveActivityPriority(params);
  const expirationSeconds = resolveLiveActivityExpirationSeconds({
    event: params.event,
    priority,
  });

  return {
    pushType: LIVE_ACTIVITY_APNS_PUSH_TYPE,
    topic: buildLiveActivityTopic(params.bundleId),
    priority,
    collapseId: buildLiveActivityCollapseId(params),
    expiration: params.nowEpochSeconds + expirationSeconds,
    allowsAlert:
      priority === 10
      && params.event === 'update'
      && params.template === 'urgentAttention'
      && params.alertRequested
      && !params.quietHoursActive,
  };
}
