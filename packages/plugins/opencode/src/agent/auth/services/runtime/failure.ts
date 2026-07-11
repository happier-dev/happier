import {
  classifyProviderLimitEvidence,
  type ProviderLimitCategory as RuntimeLimitCategory,
} from '@happier-dev/plugin-sdk/experimental/cloud/auth';
import { redactBugReportSensitiveText } from '@happier-dev/plugin-sdk/experimental/diagnostics';

import {
  type OpenCodeSupportedAuthServiceId,
  readOpenCodeConnectedServiceId,
} from '../selection.js';
import {
  OPEN_CODE_BROKER_SELECTIONS_ENV,
  parseOpenCodeBrokerSelections,
} from '../broker/env.js';
import { classifyOpenCodeUsageLimitError } from '../usageLimit.js';

type RuntimeAuthFailureKind =
  | 'usage_limit'
  | 'rate_limit'
  | 'capacity'
  | 'temporary_throttle'
  | 'auth_expired'
  | 'plan'
  | 'validation'
  | 'account_disabled';

type OpenCodeRuntimeAuthSelection = Readonly<{
  serviceId: OpenCodeSupportedAuthServiceId;
  profileId: string | null;
  activeProfileId: string | null;
  groupId: string | null;
}>;

type OpenCodeRuntimeFailureClassification = Readonly<{
  kind: RuntimeAuthFailureKind;
  limitCategory: Exclude<RuntimeLimitCategory, 'unknown'>;
  serviceId: OpenCodeSupportedAuthServiceId;
  profileId: string | null;
  groupId: string | null;
  resetsAtMs: number | null;
  retryAfterMs: number | null;
  planType: string | null;
  providerLimitId: string | null;
  quotaScope?: 'account' | 'workspace' | 'unknown';
  connectedServiceRecovery: 'available';
  action: Readonly<{ kind: 'open_url'; url: string }> | null;
  rateLimits: unknown | null;
  source: 'structured_provider_error' | 'stable_provider_message';
}>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = readString(value);
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function redactEvidence(value: unknown): unknown {
  if (typeof value === 'string') return redactBugReportSensitiveText(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactBugReportSensitiveText(value.message),
    };
  }
  if (Array.isArray(value)) return value.map(redactEvidence);
  const record = readRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => key !== 'stack')
      .map(([key, nested]) => [key, redactEvidence(nested)]),
  );
}

function normalizeErrorEvidence(error: unknown): unknown {
  if (error instanceof Error) {
    const record = readRecord(error);
    return {
      ...(record ?? {}),
      name: error.name,
      message: error.message,
    };
  }
  return error;
}

function mapCategoryToKind(category: RuntimeLimitCategory): RuntimeAuthFailureKind | null {
  if (category === 'usage_limit') return 'usage_limit';
  if (category === 'rate_limit') return 'rate_limit';
  if (category === 'capacity') return 'capacity';
  if (category === 'temporary_throttle') return 'temporary_throttle';
  if (category === 'auth_invalid') return 'auth_expired';
  if (category === 'plan_invalid') return 'plan';
  if (category === 'validation_failed') return 'validation';
  if (category === 'disabled') return 'account_disabled';
  return null;
}

function parseResetTiming(evidence: unknown): Readonly<{ retryAfterMs: number | null; resetAtMs: number | null }> {
  const record = readRecord(evidence);
  const retryAfterMs = readNumber(record?.retryAfterMs ?? record?.['retry-after-ms']);
  if (retryAfterMs !== null && retryAfterMs >= 0) return { retryAfterMs: Math.trunc(retryAfterMs), resetAtMs: null };
  const resetAtMs = readNumber(record?.resetAtMs ?? record?.resetAt ?? record?.resetsAt);
  if (resetAtMs !== null && resetAtMs >= 0) return { retryAfterMs: Math.max(0, Math.trunc(resetAtMs - Date.now())), resetAtMs: Math.trunc(resetAtMs) };
  return { retryAfterMs: null, resetAtMs: null };
}

function readSelection(value: unknown): OpenCodeRuntimeAuthSelection | null {
  const record = readRecord(value);
  const serviceId = readOpenCodeConnectedServiceId(record?.serviceId);
  if (!record || !serviceId) return null;
  return {
    serviceId,
    profileId: readString(record.profileId),
    activeProfileId: readString(record.activeProfileId),
    groupId: readString(record.groupId),
  };
}

function readServiceIdFromError(error: unknown): OpenCodeSupportedAuthServiceId | null {
  const record = readRecord(error);
  const data = readRecord(record?.data);
  return readOpenCodeConnectedServiceId(record?.serviceId)
    ?? readOpenCodeConnectedServiceId(data?.serviceId);
}

export function resolveOpenCodeRuntimeAuthSelection(input: Readonly<{
  env?: Readonly<Record<string, string | undefined>> | null;
  error?: unknown;
}>): unknown | null {
  const serviceId = readServiceIdFromError(input.error);
  const brokerSelections = parseOpenCodeBrokerSelections(input.env?.[OPEN_CODE_BROKER_SELECTIONS_ENV]);
  const candidates = [
    brokerSelections.openai,
    brokerSelections.anthropic,
  ].filter((selection): selection is NonNullable<typeof selection> => selection != null);
  const selected = serviceId
    ? candidates.find((selection) => selection.serviceId === serviceId)
    : candidates[0] ?? null;
  if (!selected) return null;
  return {
    serviceId: selected.serviceId,
    profileId: selected.profileId,
    activeProfileId: selected.profileId,
    planType: selected.planType,
  };
}

function quotaScopeForCategory(category: RuntimeLimitCategory): 'account' | 'unknown' | undefined {
  return category === 'usage_limit' || category === 'rate_limit' || category === 'temporary_throttle'
    ? 'account'
    : undefined;
}

function classifyOpenCodeRuntimeAuthFailure(input: Readonly<{
  error: unknown;
  selection: unknown;
}>): OpenCodeRuntimeFailureClassification | null {
  const selection = readSelection(input.selection);
  if (!selection) return null;

  const usageLimit = classifyOpenCodeUsageLimitError({
    providerErrorPath: true,
    error: input.error,
    parseResetAt: ({ body }) => parseResetTiming(body),
  });
  if (usageLimit) {
    return {
      kind: usageLimit.kind,
      limitCategory: usageLimit.limitCategory,
      serviceId: selection.serviceId,
      profileId: selection.activeProfileId ?? selection.profileId,
      groupId: selection.groupId,
      resetsAtMs: usageLimit.resetAtMs,
      retryAfterMs: usageLimit.retryAfterMs,
      planType: null,
      providerLimitId: usageLimit.providerLimitId,
      quotaScope: usageLimit.quotaScope,
      connectedServiceRecovery: 'available',
      action: usageLimit.action,
      rateLimits: redactEvidence(input.error),
      source: 'structured_provider_error',
    };
  }

  const evidence = normalizeErrorEvidence(input.error);
  const record = readRecord(evidence);
  const data = readRecord(record?.data);
  const structuredAuthError = readString(record?.name ?? data?.name) === 'ProviderAuthError';
  const category = structuredAuthError ? 'auth_invalid' : classifyProviderLimitEvidence(evidence);
  const kind = mapCategoryToKind(category);
  if (!kind || category === 'unknown') return null;
  const timing = parseResetTiming(evidence);
  const quotaScope = quotaScopeForCategory(category);
  return {
    kind,
    limitCategory: category,
    serviceId: selection.serviceId,
    profileId: selection.activeProfileId ?? selection.profileId,
    groupId: selection.groupId,
    resetsAtMs: timing.resetAtMs,
    retryAfterMs: timing.retryAfterMs,
    planType: null,
    providerLimitId: null,
    ...(quotaScope ? { quotaScope } : {}),
    connectedServiceRecovery: 'available',
    action: null,
    rateLimits: redactEvidence(evidence),
    source: structuredAuthError ? 'structured_provider_error' : 'stable_provider_message',
  };
}

const restartRequired = Object.freeze({
  supported: false,
  recovery: 'restart_rematerialize',
});

export function createOpenCodeConnectedServiceRuntimeAuthAdapter() {
  return {
    classifyRuntimeAuthFailure(input: Readonly<{
      target?: unknown;
      error: unknown;
      selection?: unknown;
    }>) {
      return classifyOpenCodeRuntimeAuthFailure({
        error: input.error,
        selection: input.selection,
      });
    },
    async materializeActiveProfile() {
      return { supported: true };
    },
    canHotApply() {
      return restartRequired;
    },
    async hotApply() {
      return { applied: false, reason: 'restart_rematerialize_required', recovery: 'restart_rematerialize' };
    },
    async recoverAfterRuntimeAuthSwitch() {
      return { recovered: false, reason: 'restart_rematerialize_required', recovery: 'restart_rematerialize' };
    },
    async verifyActiveAccount() {
      return {
        status: 'weakly_verified',
        reason: 'provider_restart_rematerialization_authoritative',
      };
    },
    async probeQuota() {
      return { status: 'unsupported' };
    },
    async refreshActiveProfile() {
      return { status: 'unsupported' };
    },
  };
}
