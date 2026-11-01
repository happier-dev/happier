import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { isUnsafeTelemetryDataKey } from '../../common/sensitiveKeys.js';
import {
  ConnectedServiceAuthGroupIdSchema,
  ConnectedServiceProfileIdSchema,
} from '../../connect/connectedServiceSchemas.js';
import { ConnectedAccountServiceKeyIngressSchema } from '../../connect/connectedServiceBindings.js';
import { ConnectedServiceLimitCategoryV1Schema } from '../../connect/connectedServiceLimitCategory.js';
import { AgentIdV1Schema } from '../../agents/agentIdV1.js';
import { NonBlankOpaqueIdentifierSchema } from '../../strings/opaqueIdentifier.js';
import { ProviderBrokerAdmissionFailureCodeV1Schema, type ProviderBrokerAdmissionFailureCodeV1 } from '../../providers/brokerRouteGrantV1.js';
import { TeamCredentialUsageLimitDenialV1Schema } from '../../teams/credentials/usageV1.js';

export const TurnTerminalStatusV1Schema = lazyZodSchema(() => z.enum(['completed', 'cancelled', 'failed']));
export type TurnTerminalStatusV1 = z.infer<typeof TurnTerminalStatusV1Schema>;

export const PrimaryTurnStatusV1Schema = lazyZodSchema(() => z.union([
  z.literal('in_progress'),
  z.literal('waiting'),
  TurnTerminalStatusV1Schema,
]));
export type PrimaryTurnStatusV1 = z.infer<typeof PrimaryTurnStatusV1Schema>;

export const SessionRuntimeIssueSourceV1Schema = lazyZodSchema(() => z.enum([
  'agent_status_error',
  'agent_process_exit',
  'agent_process_exit_after_switch',
  'agent_session_error',
  'usage_limit',
  /** A shared Team credential refused the request at the Home broker. */
  'team_credential',
  'auth_error',
  'dependency_failure',
  'stream_error',
  'permission_blocked',
  'unknown',
]));
export type SessionRuntimeIssueSourceV1 = z.infer<typeof SessionRuntimeIssueSourceV1Schema>;

/** Closed startup diagnostics shared by Agent adapters and the host issue projector. */
export const AGENT_STARTUP_FAILURE_PREVIEWS = {
  agent_startup_rpc_rejected: 'Agent startup was rejected by its native API',
  agent_startup_transport_failed: 'Agent startup transport failed',
  agent_startup_invalid_state: 'Agent startup encountered invalid local runtime state',
  agent_startup_failed: 'Agent startup failed',
  AGENT_RESUME_PROVIDER_STATE_MISSING: 'The native agent state needed to resume is missing',
  codex_refresh_free_auth_unsupported: 'Agent startup authentication is unavailable',
  plugin_services_managed_provider_authority_unavailable: 'Access to the shared provider is unavailable. Check the Gateway and its machine connection, then retry the session.',
  provider_endpoint_unavailable: 'The provider endpoint is unavailable. Check the Gateway and its machine connection, then retry the session.',
} as const;
export type AgentStartupFailureCode = keyof typeof AGENT_STARTUP_FAILURE_PREVIEWS;

export function readAgentStartupFailureCode(value: unknown): AgentStartupFailureCode | null {
  return typeof value === 'string' && Object.hasOwn(AGENT_STARTUP_FAILURE_PREVIEWS, value)
    ? value as AgentStartupFailureCode
    : null;
}

export const TEAM_CREDENTIAL_FAILURE_PREVIEW = 'Shared Team credential refused the request';

/** Code-only failures returned by daemon preparation and skill delivery.
 * PluginError accepts arbitrary plugin strings; only these host-owned codes
 * may cross startup diagnostic and launch-result boundaries. */
export const SESSION_PREPARATION_FAILURE_PREVIEWS = {
  ...Object.fromEntries(ProviderBrokerAdmissionFailureCodeV1Schema.options.map(code => [code, TEAM_CREDENTIAL_FAILURE_PREVIEW])) as Record<ProviderBrokerAdmissionFailureCodeV1, string>,
  plugin_disabled: 'This Agent plugin is disabled. Re-enable it in Plugins to resume this Session.',
  plugin_mcp_preparation_unavailable: 'Plugin MCP preparation is unavailable. Check the target machine, then retry the session.',
  agent_runtime_daemon_service_generation_not_current: 'The runner agent generation is no longer current. Retry the session on the target machine.',
  native_agent_privileged_effect_authority_unavailable: 'Runner daemon authority is unavailable. Check the target machine, then retry the session.',
  native_agent_privileged_effect_outcome_unknown: 'Runner daemon preparation could not be confirmed. Check the session and target machine before retrying.',
  daemon_draining: 'The target machine is temporarily pausing new work. Retry the session when it is ready.',
  daemon_shutting_down: 'Happier is shutting down on the target machine. Restart it there, then retry the session.',
  skills_unavailable: 'Skill delivery is unavailable. Check the target machine, then retry the session.',
  team_credential_provider_selection_not_current: 'The selected Team provider is unavailable. Review the Team model selection, then retry the session.',
} as const;
export type SessionPreparationFailureCode = keyof typeof SESSION_PREPARATION_FAILURE_PREVIEWS;

export function readSessionPreparationFailureCode(value: unknown): SessionPreparationFailureCode | null {
  return typeof value === 'string' && Object.hasOwn(SESSION_PREPARATION_FAILURE_PREVIEWS, value)
    ? value as SessionPreparationFailureCode : null;
}

/** The person-facing cause of a closed startup failure, or null when the code names no startup failure. */
export function readSessionStartupFailurePreview(value: unknown): string | null {
  const preparation = readSessionPreparationFailureCode(value);
  if (preparation) return SESSION_PREPARATION_FAILURE_PREVIEWS[preparation];
  const startup = readAgentStartupFailureCode(value);
  return startup ? AGENT_STARTUP_FAILURE_PREVIEWS[startup] : null;
}

const SessionRuntimeAgentProcessExitAfterSwitchDetailsV1Schema = lazyZodSchema(() => z.strictObject({
    exitCode: z.nullable(z.number().check(z.int())),
    signal: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
    lastStderrLine: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000))),
    vendorResumeId: z.nullable(NonBlankOpaqueIdentifierSchema.check(z.maxLength(512))),
    materializationRoot: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000))),
    effectiveStateMode: z.nullable(z.enum(['shared', 'isolated'])),
  }));

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

const SessionRuntimeUsageLimitActionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('open_url'),
    labelKey: z.optional(z.string().check(z.trim(), z.minLength(1))),
    url: z.string().check(z.url()),
  }),
  z.strictObject({
    kind: z.literal('settings'),
  }),
  z.strictObject({
    kind: z.literal('none'),
  }),
]));

const SessionRuntimeQuotaSnapshotRefV1Schema = lazyZodSchema(() => z.strictObject({
    serviceId: ConnectedAccountServiceKeyIngressSchema,
    profileId: z.optional(ConnectedServiceProfileIdSchema),
    groupId: z.optional(ConnectedServiceAuthGroupIdSchema),
    fetchedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  }));

const SessionRuntimeUsageLimitWindowV1Schema = lazyZodSchema(() => z.strictObject({
    meterId: z.string().check(z.trim(), z.minLength(1)),
    scope: z.optional(z.string().check(z.trim(), z.minLength(1))),
    remainingPct: z.optional(z.number().check(z.minimum(0), z.maximum(100))),
    resetAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
    status: z.optional(z.string().check(z.trim(), z.minLength(1))),
  }));

export const SessionRuntimeUsageLimitDetailsV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    resetAtMs: z.nullable(z.number().check(z.int(), z.nonnegative())),
    retryAfterMs: z.nullable(z.number().check(z.int(), z.nonnegative())),
    quotaScope: z.enum(['account', 'workspace', 'organization', 'model', 'provider', 'unknown']),
    recoverability: z.enum(['wait', 'switch_account', 'manual', 'unknown']),
    providerLimitId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    planType: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
    utilization: z.optional(z.nullable(z.number().check(z.minimum(0), z.maximum(100)))),
    limitCategory: z.optional(ConnectedServiceLimitCategoryV1Schema),
    quotaSnapshotRef: z.optional(SessionRuntimeQuotaSnapshotRefV1Schema),
    effectiveMeterId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    effectiveRemainingPct: z.optional(z.number().check(z.minimum(0), z.maximum(100))),
    allWindows: z.optional(z.array(SessionRuntimeUsageLimitWindowV1Schema)),
    recoveryDecision: z.optional(z
      .enum(['switching', 'waiting_for_reset', 'manual_intervention', 'not_recoverable'])),
    overage: z.optional(z.nullable(z.strictObject({
        status: z.enum(['allowed', 'allowed_warning', 'rejected', 'unknown']),
        resetAtMs: z.nullable(z.number().check(z.int(), z.nonnegative())),
        disabledReason: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
      }))),
    action: z.optional(z.nullable(SessionRuntimeUsageLimitActionV1Schema)),
    connectedService: z.optional(z.nullable(z.strictObject({
        serviceId: ConnectedAccountServiceKeyIngressSchema,
        profileId: z.nullable(ConnectedServiceProfileIdSchema),
        groupId: z.nullable(ConnectedServiceAuthGroupIdSchema),
        groupExhausted: z.optional(z.boolean()),
      }))),
  }));

export type SessionRuntimeUsageLimitDetailsV1 = z.infer<typeof SessionRuntimeUsageLimitDetailsV1Schema>;

/**
 * Recipient-safe facts of a Team credential broker refusal: the closed
 * admission code, the resource the requester selected, and, for an exhausted
 * ceiling, the metric and reset needed to recover. Limit identity, audience
 * and other members' use stay manager-private.
 */
export const SessionRuntimeTeamCredentialDenialDetailsV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    resourceId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    reasonCode: ProviderBrokerAdmissionFailureCodeV1Schema,
    usageLimit: z.optional(TeamCredentialUsageLimitDenialV1Schema),
  }));

export type SessionRuntimeTeamCredentialDenialDetailsV1 =
  z.infer<typeof SessionRuntimeTeamCredentialDenialDetailsV1Schema>;

export const SessionRuntimeTemporaryThrottleDetailsV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    retryAfterMs: z.nullable(z.number().check(z.int(), z.nonnegative())),
    recoverability: z.enum(['retry', 'manual', 'wait', 'unknown']),
  }));

export type SessionRuntimeTemporaryThrottleDetailsV1 =
  z.infer<typeof SessionRuntimeTemporaryThrottleDetailsV1Schema>;

export const SessionRuntimeIssueV1Schema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(normalizeLegacyRuntimeIssueV1), z.readonly(z.object({
    v: z.literal(1),
    scope: z.literal('primary_session'),
    status: z.literal('failed'),
    code: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    source: SessionRuntimeIssueSourceV1Schema,
    occurredAt: z.number().check(z.int(), z.nonnegative()),
    sessionSeq: z.optional(z.number().check(z.int(), z.nonnegative())),
    agentId: z.optional(AgentIdV1Schema),
    agentTurnId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    sanitizedPreview: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000))),
    usageLimit: z.optional(SessionRuntimeUsageLimitDetailsV1Schema),
    teamCredential: z.optional(SessionRuntimeTeamCredentialDenialDetailsV1Schema),
    temporaryThrottle: z.optional(SessionRuntimeTemporaryThrottleDetailsV1Schema),
    agentProcessExitAfterSwitch: z.optional(SessionRuntimeAgentProcessExitAfterSwitchDetailsV1Schema),
  }))));
export type SessionRuntimeIssueV1 = z.infer<typeof SessionRuntimeIssueV1Schema>;

export type SessionRuntimeIssueSignInRecovery = Readonly<{
  kind: 'agent_sign_in'; machineId: string; agentId: string;
}>;

/** A client-side recovery projection; persisted runtime issue shapes stay unchanged. */
export function resolveSessionRuntimeIssueSignInRecovery(
  issue: SessionRuntimeIssueV1 | null | undefined,
  machineId: string | null | undefined,
): SessionRuntimeIssueSignInRecovery | null {
  if (issue?.source !== 'auth_error' || !issue.agentId || !machineId?.trim()) return null;
  return { kind: 'agent_sign_in', machineId: machineId.trim(), agentId: issue.agentId };
}

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
