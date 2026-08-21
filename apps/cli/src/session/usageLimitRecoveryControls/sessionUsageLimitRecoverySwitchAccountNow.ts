import {
  SessionRuntimeIssueV1Schema,
  type SessionRuntimeIssueV1,
} from '@happier-dev/protocol';

import { notifyDaemonConnectedServiceRuntimeAuthFailure } from '@/daemon/controlClient';
import type { ConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/types';
import { resolveMachineControlLocalityProof } from '@/session/machineControlLocality';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { normalizeCliSessionUsageLimitRecoveryOperationResult } from './sessionUsageLimitRecoveryOperationResult';

type SwitchAccountNowRequest = Readonly<{
  sessionId: string;
  /**
   * Backend provider id from SessionRuntimeIssueV1.provider, for example
   * "codex"; this is not the connected-service id such as "openai-codex".
   */
  provider?: string;
  resumePromptMode?: 'standard' | 'off' | 'custom';
}>;

export type NotifyRuntimeAuthFailure = (body: Readonly<{
  sessionId: string;
  switchesThisTurn?: number;
  classification: unknown;
  resumePromptMode?: 'standard' | 'off' | 'custom';
}>) => Promise<unknown>;

type RouteSessionUsageLimitRecoverySwitchAccountNowParams = Readonly<{
  /**
   * Account scope for the machine REPLACEMENT chain the locality proof reads.
   * Already supplied by the shared `routeParams` every usage-limit control
   * route receives.
   */
  token: string;
  sessionId: string;
  rawSession: RawSessionRecord;
  metadata?: Record<string, unknown> | null;
  currentMachineId?: string | null;
  currentMachineHost?: string | null;
  currentMachineHomeDir?: string | null;
  request?: SwitchAccountNowRequest;
  notifyRuntimeAuthFailure?: NotifyRuntimeAuthFailure;
}>;

function normalizeUsageLimitCategoryForRuntimeRecovery(
  value: NonNullable<SessionRuntimeIssueV1['usageLimit']>['limitCategory'],
): ConnectedServiceRuntimeFailureClassification['limitCategory'] {
  switch (value) {
    case 'usage_limit':
      return 'usage_limit';
    case 'auth_invalid':
      return 'auth_invalid';
    case 'plan_invalid':
      return 'plan_invalid';
    case 'validation_failed':
      return 'validation_failed';
    case 'disabled':
      return 'disabled';
    case 'rate_limit':
    case 'capacity':
    case 'temporary_throttle':
    case 'unknown':
      return value;
    default:
      return 'usage_limit';
  }
}

function stableError(
  errorCode: string,
  raw?: Record<string, unknown> | null,
): Readonly<{ ok: false; errorCode: string; error: string; uxDiagnostic?: unknown }> {
  return {
    ok: false,
    errorCode,
    error: errorCode,
    ...(raw && Object.prototype.hasOwnProperty.call(raw, 'uxDiagnostic') ? { uxDiagnostic: raw.uxDiagnostic } : {}),
  };
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function operationResult(
  params: Pick<RouteSessionUsageLimitRecoverySwitchAccountNowParams, 'sessionId'>,
  result: unknown,
) {
  return normalizeCliSessionUsageLimitRecoveryOperationResult({
    sessionId: params.sessionId,
    result,
  });
}

function resolveRawSessionString(rawSession: RawSessionRecord, key: 'machineId' | 'host' | 'homeDir'): string | null {
  return readString((rawSession as Partial<Record<typeof key, unknown>>)[key]);
}

function resolveSessionMachineHost(
  metadata: Record<string, unknown>,
  rawSession: RawSessionRecord,
): string | null {
  return readString(metadata.host) ?? resolveRawSessionString(rawSession, 'host');
}

function resolveSessionMachineHomeDir(
  metadata: Record<string, unknown>,
  rawSession: RawSessionRecord,
): string | null {
  return readString(metadata.homeDir) ?? resolveRawSessionString(rawSession, 'homeDir');
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

async function ensureLocalSwitchAccountControlContext(
  params: RouteSessionUsageLimitRecoverySwitchAccountNowParams,
): Promise<Readonly<
  | { ok: true }
  | { ok: false; result: ReturnType<typeof stableError> }
>> {
  const metadata = params.metadata;
  if (!metadata) {
    return { ok: false, result: stableError('session_usage_limit_recovery_control_metadata_unavailable') };
  }

  const currentMachineId = readString(params.currentMachineId);
  if (!currentMachineId) {
    return { ok: false, result: stableError('session_usage_limit_recovery_control_current_machine_unknown') };
  }

  const sessionMachineId = readString(metadata.machineId) ?? resolveRawSessionString(params.rawSession, 'machineId');
  if (!sessionMachineId) {
    return { ok: false, result: stableError('session_usage_limit_recovery_control_session_machine_unknown') };
  }
  if (
    !await resolveMachineControlLocalityProof({
      sessionMachineId,
      currentMachineId,
      sessionHost: resolveSessionMachineHost(metadata, params.rawSession),
      sessionHomeDir: resolveSessionMachineHomeDir(metadata, params.rawSession),
      currentMachineHost: params.currentMachineHost,
      currentMachineHomeDir: params.currentMachineHomeDir,
      credentials: { token: params.token },
    })
  ) {
    return { ok: false, result: stableError('session_usage_limit_recovery_control_remote_unavailable') };
  }

  return { ok: true };
}

export async function routeSessionUsageLimitRecoverySwitchAccountNow(
  params: RouteSessionUsageLimitRecoverySwitchAccountNowParams,
): Promise<unknown> {
  const issue = readLatestUsageLimitIssue(params.rawSession);
  if (!issue) {
    return operationResult(params, stableError('session_usage_limit_recovery_control_inactive'));
  }

  const requestedProvider = readString(params.request?.provider);
  if (requestedProvider && issue.provider && issue.provider !== requestedProvider) {
    return operationResult(params, stableError('session_usage_limit_recovery_control_issue_mismatch'));
  }

  const classification = buildRuntimeAuthClassificationFromUsageLimitIssue(issue);
  if (!classification) {
    return operationResult(params, stableError('session_usage_limit_recovery_control_switch_unavailable'));
  }

  const context = await ensureLocalSwitchAccountControlContext(params);
  if (!context.ok) return operationResult(params, context.result);

  try {
    const notify = params.notifyRuntimeAuthFailure ?? notifyDaemonConnectedServiceRuntimeAuthFailure;
    return operationResult(params, await notify({
      sessionId: params.sessionId,
      switchesThisTurn: 0,
      classification,
      ...(params.request?.resumePromptMode ? { resumePromptMode: params.request.resumePromptMode } : {}),
    }));
  } catch {
    return operationResult(params, stableError('session_usage_limit_recovery_control_switch_failed'));
  }
}
