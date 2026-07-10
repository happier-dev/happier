import { z } from 'zod';

import { isUnsafeTelemetryDataKey } from '../../common/sensitiveKeys.js';
import {
  ConnectedServiceAuthGroupIdSchema,
  ConnectedServiceIdSchema,
  ConnectedServiceProfileIdSchema,
} from '../../connect/connectedServiceSchemas.js';
import { ConnectedServiceLimitCategoryV1Schema } from '../../connect/connectedServiceLimitCategory.js';

export const TurnTerminalStatusV1Schema = z.enum(['completed', 'cancelled', 'failed']);
export type TurnTerminalStatusV1 = z.infer<typeof TurnTerminalStatusV1Schema>;

export const PrimaryTurnStatusV1Schema = z.union([
  z.literal('in_progress'),
  TurnTerminalStatusV1Schema,
]);
export type PrimaryTurnStatusV1 = z.infer<typeof PrimaryTurnStatusV1Schema>;

export const SessionRuntimeIssueSourceV1Schema = z.enum([
  'agent_status_error',
  'agent_process_exit',
  'agent_process_exit_after_switch',
  'agent_session_error',
  'usage_limit',
  'auth_error',
  'dependency_failure',
  'stream_error',
  'permission_blocked',
  'unknown',
]);
export type SessionRuntimeIssueSourceV1 = z.infer<typeof SessionRuntimeIssueSourceV1Schema>;

const SessionRuntimeAgentProcessExitAfterSwitchDetailsV1Schema = z
  .object({
    exitCode: z.number().int().nullable(),
    signal: z.string().trim().min(1).max(128).nullable(),
    lastStderrLine: z.string().trim().min(1).max(2_000).nullable(),
    vendorResumeId: z.string().trim().min(1).max(512).nullable(),
    materializationRoot: z.string().trim().min(1).max(2_000).nullable(),
    effectiveStateMode: z.enum(['shared', 'isolated']).nullable(),
  })
  .strict();

const LEGACY_RUNTIME_ISSUE_SOURCE_BY_VALUE = {
  provider_status_error: 'agent_status_error',
  provider_process_exit: 'agent_process_exit',
  provider_process_exit_after_switch: 'agent_process_exit_after_switch',
  provider_session_error: 'agent_session_error',
} as const satisfies Readonly<Record<string, SessionRuntimeIssueSourceV1>>;

function normalizeLegacyRuntimeIssueStringField(
  record: Record<string, unknown>,
  legacyKey: string,
  canonicalKey: string,
): Record<string, unknown> | null {
  if (!Object.hasOwn(record, legacyKey)) return record;
  const legacyValue = typeof record[legacyKey] === 'string' ? record[legacyKey].trim() : '';
  const hasCanonicalValue = Object.hasOwn(record, canonicalKey);
  const canonicalValue = typeof record[canonicalKey] === 'string' ? record[canonicalKey].trim() : '';
  if (!legacyValue || (hasCanonicalValue && (!canonicalValue || canonicalValue !== legacyValue))) return null;
  const { [legacyKey]: _legacyValue, ...rest } = record;
  return hasCanonicalValue ? rest : { ...rest, [canonicalKey]: legacyValue };
}

function normalizeLegacyRuntimeIssueV1(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  let record = value as Record<string, unknown>;

  for (const [legacyKey, canonicalKey] of [
    ['provider', 'agentId'],
    ['providerTurnId', 'agentTurnId'],
  ] as const) {
    const normalized = normalizeLegacyRuntimeIssueStringField(record, legacyKey, canonicalKey);
    if (!normalized) return undefined;
    record = normalized;
  }

  if (Object.hasOwn(record, 'providerProcessExitAfterSwitch')) {
    if (Object.hasOwn(record, 'agentProcessExitAfterSwitch')) return undefined;
    const { providerProcessExitAfterSwitch, ...rest } = record;
    record = { ...rest, agentProcessExitAfterSwitch: providerProcessExitAfterSwitch };
  }

  const legacySource = typeof record.source === 'string'
    ? LEGACY_RUNTIME_ISSUE_SOURCE_BY_VALUE[record.source as keyof typeof LEGACY_RUNTIME_ISSUE_SOURCE_BY_VALUE]
    : undefined;
  if (legacySource) record = { ...record, source: legacySource };

  const legacyCode = typeof record.code === 'string'
    ? LEGACY_RUNTIME_ISSUE_SOURCE_BY_VALUE[record.code as keyof typeof LEGACY_RUNTIME_ISSUE_SOURCE_BY_VALUE]
    : undefined;
  if (legacyCode) record = { ...record, code: legacyCode };

  return record;
}

const SessionRuntimeUsageLimitActionV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('open_url'),
    labelKey: z.string().trim().min(1).optional(),
    url: z.string().url(),
  }).strict(),
  z.object({
    kind: z.literal('settings'),
  }).strict(),
  z.object({
    kind: z.literal('none'),
  }).strict(),
]);

const SessionRuntimeQuotaSnapshotRefV1Schema = z
  .object({
    serviceId: ConnectedServiceIdSchema,
    profileId: ConnectedServiceProfileIdSchema.optional(),
    groupId: ConnectedServiceAuthGroupIdSchema.optional(),
    fetchedAtMs: z.number().int().nonnegative().optional(),
  })
  .strict();

const SessionRuntimeUsageLimitWindowV1Schema = z
  .object({
    meterId: z.string().trim().min(1),
    scope: z.string().trim().min(1).optional(),
    remainingPct: z.number().finite().min(0).max(100).optional(),
    resetAtMs: z.number().int().nonnegative().optional(),
    status: z.string().trim().min(1).optional(),
  })
  .strict();

export const SessionRuntimeUsageLimitDetailsV1Schema = z
  .object({
    v: z.literal(1),
    resetAtMs: z.number().int().nonnegative().nullable(),
    retryAfterMs: z.number().int().nonnegative().nullable(),
    quotaScope: z.enum(['account', 'workspace', 'organization', 'model', 'provider', 'unknown']),
    recoverability: z.enum(['wait', 'switch_account', 'manual', 'unknown']),
    providerLimitId: z.string().trim().min(1).optional(),
    planType: z.string().trim().min(1).nullable().optional(),
    utilization: z.number().finite().min(0).max(100).nullable().optional(),
    limitCategory: ConnectedServiceLimitCategoryV1Schema.optional(),
    quotaSnapshotRef: SessionRuntimeQuotaSnapshotRefV1Schema.optional(),
    effectiveMeterId: z.string().trim().min(1).optional(),
    effectiveRemainingPct: z.number().finite().min(0).max(100).optional(),
    allWindows: z.array(SessionRuntimeUsageLimitWindowV1Schema).optional(),
    recoveryDecision: z
      .enum(['switching', 'waiting_for_reset', 'manual_intervention', 'not_recoverable'])
      .optional(),
    overage: z
      .object({
        status: z.enum(['allowed', 'allowed_warning', 'rejected', 'unknown']),
        resetAtMs: z.number().int().nonnegative().nullable(),
        disabledReason: z.string().trim().min(1).nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    action: SessionRuntimeUsageLimitActionV1Schema.nullable().optional(),
    connectedService: z
      .object({
        serviceId: ConnectedServiceIdSchema,
        profileId: ConnectedServiceProfileIdSchema.nullable(),
        groupId: ConnectedServiceAuthGroupIdSchema.nullable(),
        groupExhausted: z.boolean().optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

export type SessionRuntimeUsageLimitDetailsV1 = z.infer<typeof SessionRuntimeUsageLimitDetailsV1Schema>;

export const SessionRuntimeTemporaryThrottleDetailsV1Schema = z
  .object({
    v: z.literal(1),
    retryAfterMs: z.number().int().nonnegative().nullable(),
    recoverability: z.enum(['retry', 'manual', 'wait', 'unknown']),
  })
  .strict();

export type SessionRuntimeTemporaryThrottleDetailsV1 =
  z.infer<typeof SessionRuntimeTemporaryThrottleDetailsV1Schema>;

export const SessionRuntimeIssueV1Schema = z.preprocess(
  normalizeLegacyRuntimeIssueV1,
  z.object({
    v: z.literal(1),
    scope: z.literal('primary_session'),
    status: z.literal('failed'),
    code: z.string().trim().min(1).max(256),
    source: SessionRuntimeIssueSourceV1Schema,
    occurredAt: z.number().int().nonnegative(),
    sessionSeq: z.number().int().nonnegative().optional(),
    agentId: z.string().trim().min(1).max(128).optional(),
    agentTurnId: z.string().trim().min(1).max(256).optional(),
    sanitizedPreview: z.string().trim().min(1).max(2_000).optional(),
    usageLimit: SessionRuntimeUsageLimitDetailsV1Schema.optional(),
    temporaryThrottle: SessionRuntimeTemporaryThrottleDetailsV1Schema.optional(),
    agentProcessExitAfterSwitch: SessionRuntimeAgentProcessExitAfterSwitchDetailsV1Schema.optional(),
  }).readonly(),
);
export type SessionRuntimeIssueV1 = z.infer<typeof SessionRuntimeIssueV1Schema>;

const SAFE_USAGE_LIMIT_STRING_MAX_LENGTH = 512;
const SAFE_USAGE_LIMIT_ACTION_URL_MAX_LENGTH = 2_048;
const SECRETISH_DIAGNOSTIC_VALUE_PATTERN =
  /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|authorization|bearer|secret|password|credential)\b/i;

function isUnsafeUsageLimitDiagnosticValue(value: string): boolean {
  if (SECRETISH_DIAGNOSTIC_VALUE_PATTERN.test(value)) return true;
  if (isUnsafeTelemetryDataKey(value)) return true;
  return value
    .split(/[^a-zA-Z0-9_-]+/u)
    .filter(Boolean)
    .some((part) => isUnsafeTelemetryDataKey(part));
}

function sanitizeProviderDiagnosticString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > SAFE_USAGE_LIMIT_STRING_MAX_LENGTH) return null;
  return isUnsafeUsageLimitDiagnosticValue(normalized) ? null : normalized;
}

function sanitizeUsageLimitAction(
  action: SessionRuntimeUsageLimitDetailsV1['action'],
): SessionRuntimeUsageLimitDetailsV1['action'] {
  if (!action) return action;
  if (action.kind !== 'open_url') return action;
  if (action.url.length > SAFE_USAGE_LIMIT_ACTION_URL_MAX_LENGTH) return undefined;
  if (isUnsafeUsageLimitDiagnosticValue(action.url)) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(action.url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;

  return {
    kind: 'open_url',
    ...(action.labelKey ? { labelKey: action.labelKey } : {}),
    url: parsed.toString(),
  };
}

function sanitizeUsageLimitDetails(
  details: SessionRuntimeUsageLimitDetailsV1,
): SessionRuntimeUsageLimitDetailsV1 {
  const {
    providerLimitId: _providerLimitId,
    planType: _planType,
    action: _action,
    ...rest
  } = details;
  const providerLimitId = sanitizeProviderDiagnosticString(details.providerLimitId);
  const planType = details.planType === undefined
    ? undefined
    : details.planType === null
      ? null
      : sanitizeProviderDiagnosticString(details.planType);
  const action = sanitizeUsageLimitAction(details.action);

  return {
    ...rest,
    ...(details.providerLimitId === undefined ? {} : providerLimitId ? { providerLimitId } : {}),
    ...(details.planType === undefined ? {} : { planType }),
    ...(details.action === undefined ? {} : action ? { action } : {}),
  };
}

export function sanitizeSessionRuntimeIssueV1(value: unknown): SessionRuntimeIssueV1 | null {
  const parsed = SessionRuntimeIssueV1Schema.safeParse(value);
  if (!parsed.success) return null;
  const issue = parsed.data;
  return {
    ...issue,
    ...(issue.usageLimit ? { usageLimit: sanitizeUsageLimitDetails(issue.usageLimit) } : {}),
  };
}
