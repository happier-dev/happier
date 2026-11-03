import { SessionRuntimeFailureCauseV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { readSessionStartupFailurePreview } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { resolveAgentDisplayTitle } from '@/agent/catalog/agentDisplayTitle';
import type {
  SessionRuntimeTeamCredentialDenialDetailsV1,
  SessionRuntimeTemporaryThrottleDetailsV1,
  SessionRuntimeUsageLimitDetailsV1,
  SessionRuntimeIssueSourceV1,
  SessionRuntimeIssueV1,
} from '@happier-dev/protocol';
import { readBuiltInLegacyConnectedAccountServiceKeyIngress } from '@happier-dev/protocol/connect/connected-service-bindings';
import { readConnectedServiceLimitCategoryV1 } from '@happier-dev/protocol/connect/connected-service-limit-category';
import { ProviderBrokerAdmissionFailureCodeV1Schema } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { ProviderErrorCodeV1Schema } from '@happier-dev/protocol/providers/errors';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';
import { PromptStackPreparationError } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';
import { HomeTargetResolutionError } from '@happier-dev/cli-common/homeTarget';
import { AGENT_STARTUP_FAILURE_PREVIEWS, readAgentStartupFailureCode, readSessionPreparationFailureCode, SESSION_PREPARATION_FAILURE_PREVIEWS, TEAM_CREDENTIAL_FAILURE_PREVIEW, SessionRuntimeIssueSourceV1Schema, SessionRuntimeTeamCredentialDenialDetailsV1Schema, SessionRuntimeUsageLimitDetailsV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { sanitizeConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/sanitizeConnectedServiceRuntimeFailureClassification';
import { hasConnectedServiceRuntimeAuthRecoveryContext } from './connectedServiceRuntimeAuthRecoveryContext';
import { AGENT_CLI_MISSING_PREVIEW } from '@/packagedRuntime/managedTools/agentCliNotFoundError';
import { inspectOwnErrorCodeDataProperty } from '@/agent/runtime/session/process/agentRuntimeBridgeError';
import { classifyProviderLimitEvidence, parseProviderResetAt } from '@/daemon/connectedServices/quotas/normalization';
import { classifyProviderOutputFailure } from '@/agent/runtime/classifyProviderOutputFailure';
import { AgentRuntimeDiagnosticDataV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';
import axios from 'axios';
import { HttpStatusError } from '@/api/client/httpStatusError';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { isRetryableAccountEncryptionCurrentnessError } from '@/api/client/accountEncryptionCurrentness';
import { isRetryableMcpServerCatalogUnavailableError } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import {
  DAEMON_PLUGIN_TOOL_CATALOG_UNAVAILABLE_CODE,
  DAEMON_PLUGIN_TOOL_CATALOG_UNAVAILABLE_PREVIEW,
} from '@/mcp/pluginToolCatalogError';

export type PrimarySessionRuntimeIssueCause =
  | 'status_error'
  | 'process_exit'
  | 'session_error'
  | 'usage_limit'
  | 'auth_error'
  | 'stream_error'
  | 'permission_blocked'
  | 'unknown';

export type ClassifyPrimarySessionRuntimeIssueInput = Readonly<{
  provider?: string | null;
  agentTurnId?: string | null;
  sessionSeq?: number | null;
  cause?: PrimarySessionRuntimeIssueCause | null;
  error?: unknown;
  occurredAt?: number | null;
  /** Closed host evidence from this exact Session turn, independent of Agent error formatting. */
  teamCredentialDenial?: SessionRuntimeTeamCredentialDenialDetailsV1 | null;
}>;

const causeSourceMap = {
  status_error: 'agent_status_error',
  process_exit: 'agent_process_exit',
  session_error: 'agent_session_error',
  usage_limit: 'usage_limit',
  auth_error: 'auth_error',
  stream_error: 'stream_error',
  permission_blocked: 'permission_blocked',
  unknown: 'unknown',
} as const satisfies Record<PrimarySessionRuntimeIssueCause, SessionRuntimeIssueSourceV1>;

const sanitizedPreviewBySource = {
  agent_status_error: 'Provider reported an error',
  agent_process_exit: 'Provider process exited',
  agent_process_exit_after_switch: 'Provider process exited after connected-service switch',
  agent_session_error: 'Provider session failed',
  usage_limit: 'Usage limit reached',
  team_credential: TEAM_CREDENTIAL_FAILURE_PREVIEW,
  auth_error: 'Authentication failed',
  dependency_failure: 'Provider dependency failed',
  stream_error: 'Provider stream failed',
  permission_blocked: 'Permission blocked',
  unknown: 'Session runtime failed',
} as const satisfies Record<SessionRuntimeIssueSourceV1, string>;

/** File diagnostics retain closed preparation facts before public issue classification.
 * Never copy messages, stacks, references, arbitrary codes or accessor values. */
export function readSessionPreparationFailureDiagnostic(error: unknown): Readonly<{
  originalCode: string; reason: string; contextSource: string;
  failureCause?: NonNullable<SessionRuntimeIssueV1['failureCause']>;
}> {
  const readDataField = (value: unknown, key: string): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && 'value' in descriptor ? descriptor.value : undefined;
    } catch { return undefined; }
  };
  const readClosedField = (value: unknown, key: string, allowed: ReadonlySet<string>) => {
    const field = readDataField(value, key);
    return typeof field === 'string' && allowed.has(field) ? field : 'unknown';
  };
  const readDataRecord = (value: unknown): Record<string, unknown> | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Object.values(descriptors).some(descriptor => !('value' in descriptor))) return undefined;
      return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
    } catch { return undefined; }
  };
  const cause = readDataRecord(readDataField(readDataField(error, 'details'), 'failureCause'));
  const parsedCause = SessionRuntimeFailureCauseV1Schema.safeParse(cause && {
    ...cause,
    ...(Object.hasOwn(cause, 'preparationCause')
      ? { preparationCause: readDataRecord(cause.preparationCause) ?? null }
      : {}),
  });
  const originalCode = readClosedField(error, 'code', preparationDiagnosticCodes);
  const reason = readClosedField(error, 'reason', preparationDiagnosticReasons);
  return {
    originalCode,
    reason: reason === 'unknown' && originalCode === 'agent_isolation_unavailable' ? originalCode : reason,
    contextSource: readClosedField(error, 'contextSource', preparationDiagnosticSources),
    ...(parsedCause.success ? { failureCause: parsedCause.data } : {}),
  };
}

const preparationDiagnosticCodes = new Set([
  ...Object.keys(SESSION_PREPARATION_FAILURE_PREVIEWS),
  ...Object.keys(AGENT_STARTUP_FAILURE_PREVIEWS),
  ...ProviderErrorCodeV1Schema.options,
  ...ProviderBrokerAdmissionFailureCodeV1Schema.options,
  'account_role_overrides_unavailable',
  'context_source_unavailable', 'role_overrides_unavailable', 'role_source_incomplete',
  'role_target_unavailable', 'role_policy_unenforceable', 'preparation_pending', 'attachment_unavailable',
  'profile_missing', 'invalid_target', 'identity_unobserved', 'identity_mismatch',
  'project_requester_credentials_unavailable',
  'metadata_tuple_ambiguous',
  DAEMON_PLUGIN_TOOL_CATALOG_UNAVAILABLE_CODE,
]);
const preparationDiagnosticSources = new Set([
  'account_lifetime', 'account_prompt_inventory', 'profile_prompt_inventory', 'project_association',
]);
const preparationDiagnosticReasons = new Set([
  'credentials-unavailable', 'account-mismatch', 'not-current',
  'loading', 'account-not-found', 'account-inconsistent', 'source-version-conflict', 'authority-not-confirmed',
  'not_found', 'wrong_kind', 'malformed', 'locked', 'unavailable',
  'scope-unavailable', 'scope-retired', 'catalog-unobserved', 'source-unavailable', 'invalid-stored-content',
  'profile-target-unavailable', 'profile-catalog-incomplete', 'unreachable', 'unauthorized', 'forbidden',
  'unsupported', 'account-mode-mismatch', 'encryption-material-unavailable', 'cancelled',
  'plan-unprepared', 'account-lifetime-changed', 'prepared-settings-changed', 'profile-selection-changed',
  ...['active', 'captured'].flatMap(prefix => ['account-snapshot-unavailable', 'account-scope-changed',
    'account-availability-changed', 'account-settings-changed', 'account-keys-changed', 'account-profile-changed']
    .map(reason => `${prefix}-${reason}`)),
]);

function extractErrorTextParts(error: unknown): string[] {
  if (typeof error === 'string') return [error];
  if (error instanceof Error) return [error.message];
  if (!error || typeof error !== 'object') return [];
  const record = error as Record<string, unknown>;
  const data = readRecord(record.data);
  return [record.message, data?.message, record.detail, record.error, record.code, record.status]
    .filter((part): part is string => typeof part === 'string');
}

function extractErrorText(error: unknown): string {
  return extractErrorTextParts(error)
    .join(' ');
}

function readDeclaredRuntimeIssueSource(error: unknown): SessionRuntimeIssueSourceV1 | null {
  const details = readRecord(readRecord(error)?.details);
  if (details?.v !== 1) return null;
  const parsed = SessionRuntimeIssueSourceV1Schema.safeParse(details.source);
  return parsed.success ? parsed.data : null;
}

function readProviderLimitCategory(error: unknown) {
  const data = readRecord(readRecord(error)?.data);
  return readConnectedServiceLimitCategoryV1(data?.limitCategory)
    ?? classifyProviderLimitEvidence([error, data]).category;
}

function refineProviderFailureSource(
  input: ClassifyPrimarySessionRuntimeIssueInput,
  fallback: SessionRuntimeIssueSourceV1,
): SessionRuntimeIssueSourceV1 {
  const text = extractErrorText(input.error).toLowerCase();
  if (/\btemporar(?:y|ily)\s+limiting\s+requests\b/u.test(text) && /\bnot\s+your\s+usage\s+limit\b/u.test(text)) {
    return 'agent_status_error';
  }
  if (classifyProviderOutputFailure(text).authenticationError) return 'auth_error';
  if (/\b(permission denied|permission blocked|blocked by policy|not allowed|access denied)\b/u.test(text)) {
    return 'permission_blocked';
  }
  const category = readProviderLimitCategory(input.error);
  if (category === 'usage_limit' || category === 'rate_limit') return 'usage_limit';
  return category === 'unknown' ? fallback : 'agent_status_error';
}

function normalizeNonEmptyString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

function normalizeNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : null;
}

function normalizeNullableString(value: unknown, maxLength: number): string | null {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) return null;
  return normalized.length <= maxLength ? normalized : null;
}

function normalizeStateMode(value: unknown): 'shared' | 'isolated' | null {
  if (value === 'shared' || value === 'isolated') return value;
  return null;
}

function readProviderProcessExitAfterSwitchDetails(
  error: unknown,
): SessionRuntimeIssueV1['agentProcessExitAfterSwitch'] {
  const details = readRecord(readRecord(error)?.agentProcessExitAfterSwitch);
  if (!details) return undefined;
  const exitCode = normalizeNonNegativeInteger(details.exitCode);
  const signal = normalizeNullableString(details.signal, 128);
  const lastStderrLine = normalizeNullableString(details.lastStderrLine, 2_000);
  const vendorResumeId = normalizeNullableString(details.vendorResumeId, 512);
  const materializationRoot = normalizeNullableString(details.materializationRoot, 2_000);
  const effectiveStateMode = normalizeStateMode(details.effectiveStateMode);
  if (
    exitCode === null
    && signal === null
    && lastStderrLine === null
    && vendorResumeId === null
    && materializationRoot === null
    && effectiveStateMode === null
  ) {
    return undefined;
  }
  return {
    exitCode,
    signal,
    lastStderrLine,
    vendorResumeId,
    materializationRoot,
    effectiveStateMode,
  };
}

function normalizeRetryAfterMs(value: unknown): number | null {
  const direct = normalizeNonNegativeInteger(value);
  if (direct !== null) return direct;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.trunc(numeric);
  const parsedDate = Date.parse(trimmed);
  if (!Number.isFinite(parsedDate)) return null;
  const deltaMs = parsedDate - Date.now();
  return deltaMs >= 0 ? Math.trunc(deltaMs) : null;
}

function readRetryAfterMs(error: unknown): number | null {
  const record = readRecord(error);
  const data = readRecord(record?.data);
  const headers = readRecord(record?.headers);
  const dataHeaders = readRecord(data?.headers);
  return normalizeRetryAfterMs(record?.retryAfterMs)
    ?? normalizeRetryAfterMs(record?.['retry-after-ms'])
    ?? normalizeRetryAfterMs(record?.retryAfter)
    ?? normalizeRetryAfterMs(record?.['retry-after'])
    ?? normalizeRetryAfterMs(headers?.['retry-after-ms'])
    ?? normalizeRetryAfterMs(headers?.['retry-after'])
    ?? normalizeRetryAfterMs(data?.retryAfterMs)
    ?? normalizeRetryAfterMs(data?.['retry-after-ms'])
    ?? normalizeRetryAfterMs(data?.retryAfter)
    ?? normalizeRetryAfterMs(data?.['retry-after'])
    ?? normalizeRetryAfterMs(dataHeaders?.['retry-after-ms'])
    ?? normalizeRetryAfterMs(dataHeaders?.['retry-after']);
}

function isTemporaryThrottleError(error: unknown): boolean {
  const text = extractErrorText(error).toLowerCase();
  return /\btemporar(?:y|ily)\s+limiting\s+requests\b/u.test(text)
    && /\bnot\s+your\s+usage\s+limit\b/u.test(text);
}

function buildTemporaryThrottleDetails(
  error: unknown,
): SessionRuntimeTemporaryThrottleDetailsV1 | null {
  if (!isTemporaryThrottleError(error)) return null;
  return {
    v: 1,
    retryAfterMs: readRetryAfterMs(error),
    recoverability: 'retry',
  };
}

function buildSafeModelNotFoundPreview(error: unknown): string | null {
  const match = extractErrorTextParts(error)
    .map((part) => /^model\s+not\s+found:\s*([^/\s]+)\/([^\s]+)\.?$/iu.exec(part.trim()))
    .find((candidate): candidate is RegExpExecArray => candidate !== null);
  if (!match) return null;

  const provider = match[1]?.trim() ?? '';
  const model = (match[2]?.trim() ?? '').replace(/\.+$/u, '');
  if (!/^[a-z0-9_.-]+$/iu.test(provider)) return null;
  if (!/^[a-z0-9_.:@/+~-]+$/iu.test(model)) return null;

  const modelRef = `${provider}/${model}`;
  if (modelRef.length > 180) return null;
  return `Model not found: ${modelRef}`;
}

function normalizeUrl(value: unknown): string | null {
  const raw = normalizeNonEmptyString(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function buildUsageLimitDetailsFromProviderFailure(
  error: unknown,
  nowMs: number,
): SessionRuntimeUsageLimitDetailsV1 {
  const details = readRecord(readRecord(error)?.details);
  const declared = SessionRuntimeUsageLimitDetailsV1Schema.safeParse(details?.usageLimit);
  if (declared.success) return declared.data;
  const record = readRecord(error);
  const data = readRecord(record?.data);
  const timing = parseProviderResetAt({ body: data ?? error, headers: record?.headers ?? data?.headers, nowMs });
  const limitCategory = readProviderLimitCategory(error);
  return {
    v: 1,
    resetAtMs: normalizeNonNegativeInteger(record?.resetAtMs ?? data?.resetAtMs) ?? timing.resetAtMs,
    retryAfterMs: normalizeNonNegativeInteger(record?.retryAfterMs ?? data?.retryAfterMs) ?? timing.retryAfterMs,
    quotaScope: 'unknown',
    recoverability: 'wait',
    ...(limitCategory === 'usage_limit' || limitCategory === 'rate_limit' ? { limitCategory } : {}),
  };
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

function readRuntimeAuthClassification(error: unknown): Readonly<Record<string, unknown>> | null {
  const record = readRecord(error);
  return sanitizeConnectedServiceRuntimeFailureClassification(record?.runtimeAuthClassification
    ?? readRecord(record?.details)?.runtimeAuthClassification);
}

function buildUsageLimitDetailsFromRuntimeAuthClassification(
  classification: Readonly<Record<string, unknown>> | null,
): SessionRuntimeUsageLimitDetailsV1 | null {
  if (!classification) return null;
  const kind = normalizeNonEmptyString(classification.kind);
  if (![
    'usage_limit',
    'rate_limit',
    'capacity',
    'auth_expired',
    'refresh_failed',
    'plan',
    'validation',
    'account_disabled',
  ].includes(kind ?? '')) return null;
  const serviceId = readBuiltInLegacyConnectedAccountServiceKeyIngress(classification.serviceId);
  if (!serviceId) return null;
  const groupId = normalizeNonEmptyString(classification.groupId);
  const profileId = normalizeNonEmptyString(classification.profileId);
  const hasConnectedServiceRecovery = hasConnectedServiceRuntimeAuthRecoveryContext(classification);
  const rateLimits = readRecord(classification.rateLimits);
  const providerLimitId = normalizeNonEmptyString(classification.providerLimitId ?? rateLimits?.providerLimitId);
  const limitCategory = readConnectedServiceLimitCategoryV1(classification.limitCategory ?? rateLimits?.limitCategory);
  const quotaScope = normalizeNonEmptyString(classification.quotaScope ?? rateLimits?.quotaScope);
  const action = readRecord(classification.action) ?? readRecord(rateLimits?.action);
  const actionKind = normalizeNonEmptyString(action?.kind);
  const actionUrl = actionKind === 'open_url' ? normalizeUrl(action?.url) : null;
  return {
    v: 1,
    resetAtMs: normalizeNonNegativeInteger(classification.resetsAtMs),
    retryAfterMs: normalizeNonNegativeInteger(classification.retryAfterMs),
    quotaScope: quotaScope === 'workspace' || quotaScope === 'organization' || quotaScope === 'model' || quotaScope === 'provider' || quotaScope === 'unknown'
      ? quotaScope
      : 'account',
    recoverability: groupId && hasConnectedServiceRecovery ? 'switch_account' : 'wait',
    ...(limitCategory ? { limitCategory } : {}),
    ...(providerLimitId ? { providerLimitId } : {}),
    planType: normalizeNonEmptyString(classification.planType),
    ...(actionKind === 'open_url' && actionUrl ? { action: { kind: 'open_url', url: actionUrl } } : {}),
    ...(hasConnectedServiceRecovery ? {
      connectedService: {
        serviceId,
        profileId,
        groupId,
      },
    } : {}),
  };
}

function refineRuntimeAuthClassificationSource(
  classification: Readonly<Record<string, unknown>> | null,
): SessionRuntimeIssueSourceV1 | null {
  const kind = normalizeNonEmptyString(classification?.kind);
  switch (kind) {
    case 'usage_limit':
    case 'rate_limit':
      return 'usage_limit';
    case 'auth_expired':
    case 'refresh_failed':
      return 'auth_error';
    case 'capacity':
    case 'plan':
    case 'validation':
    case 'account_disabled':
      return 'agent_status_error';
    case 'dependency_failure':
      return 'dependency_failure';
    default:
      return null;
  }
}

/**
 * The Team-credential broker answers a refused request with a typed 403 whose
 * body deliberately mirrors a Provider error envelope, so an Agent relays it
 * either as a structured error object or as text it pasted into its message.
 * Both are read here, and the body is only believed when its admission code is
 * one this protocol defines — an upstream Provider's own `permission_error`
 * stays an ordinary Agent failure.
 */
type TeamCredentialDenial = Readonly<{
  /** The refusal is this broker's; the details may still be partial. */
  details: SessionRuntimeTeamCredentialDenialDetailsV1 | null;
}>;

function readTeamCredentialDenialEnvelope(value: unknown): TeamCredentialDenial | null {
  const envelope = readRecord(readRecord(value)?.error);
  if (!envelope || envelope.type !== 'permission_error') return null;
  // The admission code is the discriminator: an upstream Provider's own
  // `permission_error` never carries one of these.
  if (!ProviderBrokerAdmissionFailureCodeV1Schema.safeParse(envelope.code).success) return null;
  const parsed = SessionRuntimeTeamCredentialDenialDetailsV1Schema.safeParse({
    v: 1,
    resourceId: envelope.resourceId,
    reasonCode: envelope.code,
    ...(envelope.usageLimit === undefined ? {} : { usageLimit: envelope.usageLimit }),
  });
  // An older custodian daemon names no resource. The refusal is still a Team
  // credential refusal; only its attribution detail is missing.
  return { details: parsed.success ? parsed.data : null };
}

/** Index just past the object that starts at `start`, or -1 when it never closes. */
function jsonObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function readEmbeddedTeamCredentialDenial(text: string): TeamCredentialDenial | null {
  const start = text.indexOf('{"type":"error"');
  if (start < 0) return null;
  const end = jsonObjectEnd(text, start);
  if (end < 0) return null;
  try {
    return readTeamCredentialDenialEnvelope(JSON.parse(text.slice(start, end)));
  } catch {
    return null;
  }
}

function readTeamCredentialDenial(error: unknown): TeamCredentialDenial | null {
  const record = readRecord(error);
  const direct = readTeamCredentialDenialEnvelope(record)
    ?? readTeamCredentialDenialEnvelope(readRecord(record?.data))
    ?? readTeamCredentialDenialEnvelope(readRecord(record?.body))
    ?? readTeamCredentialDenialEnvelope(readRecord(record?.details));
  if (direct) return direct;
  for (const part of extractErrorTextParts(error)) {
    const embedded = readEmbeddedTeamCredentialDenial(part);
    if (embedded) return embedded;
  }
  return null;
}

export function classifyPrimarySessionRuntimeIssue(
  input: ClassifyPrimarySessionRuntimeIssueInput,
): SessionRuntimeIssueV1 {
  const diagnostic = input.cause === 'session_error'
    ? AgentRuntimeDiagnosticDataV1Schema.safeParse(input.error)
    : null;
  const typedDiagnostic = diagnostic?.success ? diagnostic.data : null;
  const diagnosticDetails = readRecord(typedDiagnostic?.details);
  const failureCause = SessionRuntimeFailureCauseV1Schema.safeParse(diagnosticDetails?.failureCause
    ?? readRecord(readRecord(input.error)?.details)?.failureCause);
  const requestErrorCode = typeof diagnosticDetails?.requestErrorCode === 'number'
    && Number.isSafeInteger(diagnosticDetails.requestErrorCode) ? diagnosticDetails.requestErrorCode : null;
  // Reuse SessionRuntimeIssueV1.sanitizedPreview's existing 2,000-code-unit boundary.
  const diagnosticPreview = typedDiagnostic?.message?.trim()
    ? redactBugReportSensitiveText(`${requestErrorCode === null ? '' : `ACP ${requestErrorCode}: `}${typedDiagnostic.message}`).slice(0, 2_000)
    : null;
  const errorCode = inspectOwnErrorCodeDataProperty(input.error);
  // Home adapters preserve only their status; machine bootstrap can also throw
  // Axios' original error. Require Home provenance before applying its existing
  // endpoint policy, so an Agent's own HTTP failure stays an Agent failure.
  const homeError = input.error instanceof Error && input.error.cause instanceof HttpStatusError
    ? input.error.cause : input.error;
  const homeHttpFailure = input.cause === 'session_error' && (isRetryableAccountEncryptionCurrentnessError(input.error)
    || isRetryableMcpServerCatalogUnavailableError(input.error) || (() => {
    if (homeError instanceof HttpStatusError) return true;
    if (!axios.isAxiosError(homeError) || !homeError.config?.url) return false;
    try {
      const homeBase = `${resolveServerHttpBaseUrl()}/`;
      return new URL(homeError.config.url, homeError.config.baseURL ?? homeBase).href.startsWith(homeBase);
    } catch { return false; }
  })() && ['server_error', 'timeout', 'network'].includes(classifyServerEndpointError(homeError).kind));
  const runtimeAuthClassification = readRuntimeAuthClassification(input.error);
  const runtimeAuthUsageLimit = buildUsageLimitDetailsFromRuntimeAuthClassification(
    runtimeAuthClassification,
  );
  const runtimeAuthSource = refineRuntimeAuthClassificationSource(runtimeAuthClassification);
  const declaredSource = input.cause === 'session_error'
    ? readDeclaredRuntimeIssueSource(input.error)
    : null;
  const brokerCode = errorCode.kind === 'string'
    ? ProviderBrokerAdmissionFailureCodeV1Schema.safeParse(errorCode.value) : null;
  const brokerStartupCode = brokerCode?.success && declaredSource === 'team_credential' ? brokerCode.data : null;
  const agentProcessExitAfterSwitch = readProviderProcessExitAfterSwitchDetails(input.error);
  // A shared Team credential refusing the request is the fact the member has to
  // act on, so it outranks the Agent-shaped cause that carried it.
  const teamCredentialDenial = input.teamCredentialDenial
    ? { details: input.teamCredentialDenial } : readTeamCredentialDenial(input.error);
  const teamCredential = teamCredentialDenial?.details ?? null;
  const startupFailureCode = !teamCredentialDenial && input.cause === 'session_error'
    && errorCode.kind === 'string' ? readAgentStartupFailureCode(errorCode.value) : null;
  const sessionPreparationFailureCode = !teamCredentialDenial && input.cause === 'session_error'
    && errorCode.kind === 'string' ? brokerStartupCode
      ?? (brokerCode?.success ? null : readSessionPreparationFailureCode(errorCode.value)) : null;
  const missingCli = !teamCredentialDenial
    && errorCode.kind === 'string'
    && errorCode.value === SPAWN_SESSION_ERROR_CODES.AGENT_CLI_MISSING;
  const catalogUnavailable = !teamCredentialDenial
    && errorCode.kind === 'string'
    && errorCode.value === DAEMON_PLUGIN_TOOL_CATALOG_UNAVAILABLE_CODE;
  const metadataPrivacyUpgradeRequired = !teamCredentialDenial
    && errorCode.kind === 'string'
    && errorCode.value === 'metadata_privacy_upgrade_required';
  // Host turn publication reclassifies its typed diagnostic, not the original Error instance.
  const promptPreparationCode = teamCredentialDenial ? null
    : homeHttpFailure ? 'preparation_pending'
    : input.error instanceof PromptStackPreparationError
      ? input.error.cause instanceof HomeTargetResolutionError ? input.error.cause.code : input.error.code
    : input.cause === 'session_error' && errorCode.kind === 'string'
      && (errorCode.value === 'context_source_unavailable' || errorCode.value === 'role_overrides_unavailable'
        || errorCode.value === 'role_source_incomplete'
        || errorCode.value === 'metadata_tuple_ambiguous'
        || errorCode.value === 'project_requester_credentials_unavailable') ? 'preparation_pending'
    : declaredSource === 'dependency_failure' && errorCode.kind === 'string'
      && (errorCode.value === 'preparation_pending' || errorCode.value === 'attachment_unavailable'
        || errorCode.value === 'profile_missing' || errorCode.value === 'invalid_target'
        || errorCode.value === 'identity_unobserved' || errorCode.value === 'identity_mismatch')
    ? errorCode.value : null;
  const source = missingCli || catalogUnavailable || metadataPrivacyUpgradeRequired || promptPreparationCode
    || sessionPreparationFailureCode === 'agent_cli_not_runnable'
    ? 'dependency_failure' as const
    : teamCredentialDenial || brokerStartupCode
    ? 'team_credential' as const
    : runtimeAuthSource
    ? runtimeAuthSource
    : declaredSource
    ? declaredSource
    : input.cause === 'process_exit' && agentProcessExitAfterSwitch
    ? 'agent_process_exit_after_switch'
    : input.cause === 'status_error'
    ? refineProviderFailureSource(input, causeSourceMap[input.cause])
    : causeSourceMap[input.cause ?? 'unknown'] ?? 'unknown';
  const occurredAt = normalizeNonNegativeInteger(input.occurredAt) ?? Date.now();
  const usageLimit = runtimeAuthUsageLimit ?? (source === 'usage_limit'
    ? buildUsageLimitDetailsFromProviderFailure(input.error, occurredAt)
    : null);
  const temporaryThrottle = source === 'agent_status_error'
    ? buildTemporaryThrottleDetails(input.error)
    : null;
  const agentId = normalizeNonEmptyString(input.provider);
  const agentTurnId = normalizeNonEmptyString(input.agentTurnId);
  const sessionSeq = normalizeNonNegativeInteger(input.sessionSeq);

  return {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: missingCli ? SPAWN_SESSION_ERROR_CODES.AGENT_CLI_MISSING
      : catalogUnavailable ? DAEMON_PLUGIN_TOOL_CATALOG_UNAVAILABLE_CODE
      : metadataPrivacyUpgradeRequired ? 'metadata_privacy_upgrade_required'
      : promptPreparationCode ?? startupFailureCode ?? sessionPreparationFailureCode ?? (temporaryThrottle ? 'provider_temporary_throttle'
        : source === 'agent_session_error' ? typedDiagnostic?.code ?? source : source),
    source,
    occurredAt,
    ...(sessionSeq === null ? {} : { sessionSeq }),
    ...(agentId === null ? {} : { agentId }),
    ...(agentTurnId === null ? {} : { agentTurnId }),
    sanitizedPreview: (missingCli ? AGENT_CLI_MISSING_PREVIEW : null)
      ?? (catalogUnavailable ? DAEMON_PLUGIN_TOOL_CATALOG_UNAVAILABLE_PREVIEW : null)
      ?? (metadataPrivacyUpgradeRequired ? 'Session startup needs a compatible Home. Update or reconnect, then retry the Session.' : null)
      ?? (errorCode.kind === 'string' && errorCode.value === 'metadata_tuple_ambiguous'
        ? 'Session state could not be confirmed. Check the Home connection, then retry the Session.' : null)
      ?? (homeHttpFailure ? 'Session startup could not reach a ready Home. Check the Home connection, then retry the Session.' : null)
      ?? (promptPreparationCode ? 'Prompt context could not be prepared. Check the selected documents and Home connection, then retry the Session.' : null)
      ?? (sessionPreparationFailureCode === 'agent_cli_not_runnable'
        ? readSessionStartupFailurePreview(sessionPreparationFailureCode, agentId ? resolveAgentDisplayTitle(agentId) : null) : null)
      ?? (startupFailureCode ? AGENT_STARTUP_FAILURE_PREVIEWS[startupFailureCode] : null)
      ?? (sessionPreparationFailureCode ? SESSION_PREPARATION_FAILURE_PREVIEWS[sessionPreparationFailureCode] : null)
      ?? buildSafeModelNotFoundPreview(input.error)
      ?? (temporaryThrottle ? 'Provider is temporarily limiting requests'
        : source === 'agent_session_error' ? diagnosticPreview ?? sanitizedPreviewBySource[source] : sanitizedPreviewBySource[source]),
    ...(usageLimit === null ? {} : { usageLimit }),
    ...(teamCredential === null ? {} : { teamCredential }),
    ...(temporaryThrottle === null ? {} : { temporaryThrottle }),
    ...(failureCause.success ? { failureCause: failureCause.data } : {}),
    ...(agentProcessExitAfterSwitch === undefined ? {} : { agentProcessExitAfterSwitch }),
  };
}
