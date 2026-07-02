import {
  normalizeConnectedServiceLimitCategoryV1,
  normalizeConnectedServiceUxDiagnosticV1,
  SessionRuntimeIssueV1Schema,
  type ConnectedServiceUxDiagnosticV1,
  type SessionUsageLimitRecoveryOperationResultV1,
  type SessionRuntimeIssueV1,
} from '@happier-dev/protocol';

import { reportConnectedServiceRuntimeAuthFailureToDaemon } from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import type { ConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/types';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

import {
  buildUsageLimitRecoveryOperationError,
  normalizeUsageLimitRecoveryOperationResult,
} from './sessionUsageLimitRecoveryOperationResult';

type SwitchAccountNowRequest = Readonly<{
  sessionId: string;
  /**
   * Backend provider id from SessionRuntimeIssueV1.provider, for example
   * "codex"; this is not the connected-service id such as "openai-codex".
   */
  provider?: string;
  resumePromptMode?: 'standard' | 'off' | 'custom';
}>;

type NotifyRuntimeAuthFailure = (body: Readonly<{
  sessionId: string;
  switchesThisTurn?: number;
  classification: unknown;
  resumePromptMode?: 'standard' | 'off' | 'custom';
}>) => Promise<unknown>;

type RouteSessionUsageLimitRecoverySwitchAccountNowParams = Readonly<{
  sessionId: string;
  rawSession: RawSessionRecord;
  request?: SwitchAccountNowRequest;
  notifyRuntimeAuthFailure?: NotifyRuntimeAuthFailure;
}>;

function stableError(
  errorCode: string,
  sessionId: string,
  raw?: Record<string, unknown> | null,
): SessionUsageLimitRecoveryOperationResultV1 {
  const uxDiagnostic = readUxDiagnostic(raw);
  return normalizeUsageLimitRecoveryOperationResult({
    ok: false,
    errorCode,
    error: errorCode,
    ...(uxDiagnostic ? { uxDiagnostic } : {}),
  }, { sessionId });
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readUxDiagnostic(raw: Record<string, unknown> | null | undefined): ConnectedServiceUxDiagnosticV1 | null {
  return normalizeConnectedServiceUxDiagnosticV1(raw?.uxDiagnostic);
}

function inheritUxDiagnostic(
  primary: Record<string, unknown> | null,
  fallback: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!primary) return fallback;
  if (
    Object.prototype.hasOwnProperty.call(primary, 'uxDiagnostic')
    || !fallback
    || !Object.prototype.hasOwnProperty.call(fallback, 'uxDiagnostic')
  ) {
    return primary;
  }
  return { ...primary, uxDiagnostic: fallback.uxDiagnostic };
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeUsageLimitCategoryForRuntimeRecovery(
  value: NonNullable<SessionRuntimeIssueV1['usageLimit']>['limitCategory'],
): ConnectedServiceRuntimeFailureClassification['limitCategory'] {
  return normalizeConnectedServiceLimitCategoryV1(value ?? 'usage_limit');
}

function readLatestUsageLimitIssue(rawSession: RawSessionRecord): SessionRuntimeIssueV1 | null {
  const parsed = SessionRuntimeIssueV1Schema.safeParse(
    (rawSession as Readonly<{ lastRuntimeIssue?: unknown }>).lastRuntimeIssue,
  );
  if (!parsed.success || parsed.data.source !== 'usage_limit' || !parsed.data.usageLimit) {
    return null;
  }
  return parsed.data;
}

function buildRuntimeAuthClassificationFromUsageLimitIssue(
  issue: SessionRuntimeIssueV1,
): ConnectedServiceRuntimeFailureClassification | null {
  const usageLimit = issue.usageLimit;
  const connectedService = usageLimit?.connectedService;
  if (
    !usageLimit
    || usageLimit.recoverability !== 'switch_account'
    || !connectedService?.serviceId
    || !connectedService.groupId
  ) {
    return null;
  }

  const action = usageLimit.action?.kind === 'open_url'
    ? { kind: 'open_url' as const, url: usageLimit.action.url }
    : null;

  return {
    kind: 'usage_limit',
    serviceId: connectedService.serviceId,
    profileId: connectedService.profileId ?? null,
    groupId: connectedService.groupId,
    resetsAtMs: usageLimit.resetAtMs,
    retryAfterMs: usageLimit.retryAfterMs,
    quotaScope: usageLimit.quotaScope,
    providerLimitId: usageLimit.providerLimitId ?? null,
    action,
    planType: usageLimit.planType ?? null,
    limitCategory: normalizeUsageLimitCategoryForRuntimeRecovery(usageLimit.limitCategory),
    rateLimits: null,
    source: 'provider_runtime_marker',
  };
}

function mapRuntimeAuthSwitchResult(
  response: unknown,
  sessionId: string,
): SessionUsageLimitRecoveryOperationResultV1 {
  const responseRecord = readRecord(response);
  if (!responseRecord) {
    return buildUsageLimitRecoveryOperationError({
      errorCode: 'session_usage_limit_recovery_control_switch_failed',
      status: 'malformed_response',
      sessionId,
    });
  }
  if (responseRecord.ok === false) {
    const errorCode = readString(responseRecord.errorCode)
      ?? readString(responseRecord.error)
      ?? 'session_usage_limit_recovery_control_switch_failed';
    return stableError(errorCode, sessionId, responseRecord);
  }

  const resultEnvelope = readRecord(responseRecord.report) ?? responseRecord;
  const resultEnvelopeWithDiagnostics = inheritUxDiagnostic(resultEnvelope, responseRecord);
  if (resultEnvelope.ok === false) {
    const errorCode = readString(resultEnvelope.errorCode)
      ?? readString(resultEnvelope.error)
      ?? 'session_usage_limit_recovery_control_switch_failed';
    return stableError(errorCode, sessionId, resultEnvelopeWithDiagnostics);
  }
  const result = resultEnvelope.ok === true && Object.prototype.hasOwnProperty.call(resultEnvelope, 'result')
    ? resultEnvelope.result
    : response;
  if (
    resultEnvelope.ok === true
    && Object.prototype.hasOwnProperty.call(resultEnvelope, 'result')
    && !readRecord(result)
  ) {
    return buildUsageLimitRecoveryOperationError({
      errorCode: 'session_usage_limit_recovery_control_switch_failed',
      status: 'malformed_response',
      sessionId,
      ...(readUxDiagnostic(resultEnvelopeWithDiagnostics) ? { uxDiagnostic: readUxDiagnostic(resultEnvelopeWithDiagnostics)! } : {}),
    });
  }
  const resultRecord = inheritUxDiagnostic(readRecord(result), resultEnvelopeWithDiagnostics);
  if (!resultRecord) {
    return buildUsageLimitRecoveryOperationError({
      errorCode: 'session_usage_limit_recovery_control_switch_failed',
      status: 'malformed_response',
      sessionId,
      ...(readUxDiagnostic(resultEnvelopeWithDiagnostics) ? { uxDiagnostic: readUxDiagnostic(resultEnvelopeWithDiagnostics)! } : {}),
    });
  }
  const status = readString(resultRecord?.status);
  if (
    status === 'generation_apply_failed'
    || status === 'recovery_handler_failed'
  ) {
    return buildUsageLimitRecoveryOperationError({
      errorCode: 'session_usage_limit_recovery_control_switch_failed',
      status: 'generation_apply_failed',
      sessionId,
      ...(readUxDiagnostic(resultRecord) ? { uxDiagnostic: readUxDiagnostic(resultRecord)! } : {}),
    });
  }
  return normalizeUsageLimitRecoveryOperationResult(resultRecord, { sessionId });
}

export async function routeSessionUsageLimitRecoverySwitchAccountNow(
  params: RouteSessionUsageLimitRecoverySwitchAccountNowParams,
): Promise<unknown> {
  const issue = readLatestUsageLimitIssue(params.rawSession);
  if (!issue) {
    return stableError('session_usage_limit_recovery_control_inactive', params.sessionId);
  }

  const requestedProvider = readString(params.request?.provider);
  if (requestedProvider && issue.provider && issue.provider !== requestedProvider) {
    return stableError('session_usage_limit_recovery_control_issue_mismatch', params.sessionId);
  }

  const classification = buildRuntimeAuthClassificationFromUsageLimitIssue(issue);
  if (!classification) {
    return stableError('session_usage_limit_recovery_control_switch_unavailable', params.sessionId);
  }

  try {
    const notify = params.notifyRuntimeAuthFailure ?? reportConnectedServiceRuntimeAuthFailureToDaemon;
    return mapRuntimeAuthSwitchResult(await notify({
      sessionId: params.sessionId,
      switchesThisTurn: 0,
      classification,
      ...(params.request?.resumePromptMode ? { resumePromptMode: params.request.resumePromptMode } : {}),
    }), params.sessionId);
  } catch (error) {
    return normalizeUsageLimitRecoveryOperationResult({
      ok: false,
      errorCode: 'session_usage_limit_recovery_control_switch_failed',
      error: error instanceof Error ? error.message : 'session_usage_limit_recovery_control_switch_failed',
    }, { sessionId: params.sessionId });
  }
}
