import { isPluginError, redactBugReportSensitiveText } from '@happier-dev/plugin-sdk';
import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { classifyProviderLimitEvidence } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  classifyJsonRpcSubmissionFailure,
  readJsonRpcApplicationRejection,
  type JsonRpcApplicationRejectionDetails,
  type JsonRpcApplicationError,
} from '@happier-dev/plugin-sdk/exec/protocol-clients';
import {
  RunnerDaemonPluginServicesPreparationCauseV1Schema,
  SESSION_RUNTIME_ISSUE_PREVIEW_MAX_LENGTH,
  SessionRuntimeFailureCauseV1Schema,
  sanitizeSessionRuntimeIssueV1,
  readAgentStartupFailureCode,
  readAgentStartupFailureDetails,
  readSessionPreparationFailureCode,
  readSessionRuntimeIssueCode,
  readSessionStartupFailurePreview,
  type AgentStartupFailureDetails,
  type SessionRuntimeIssueV1,
} from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import {
  createProviderErrorV1,
  ProviderErrorCodeV1Schema,
  type ProviderErrorV1,
} from '@happier-dev/protocol/providers/errors';
import { ProviderBrokerAdmissionFailureCodeV1Schema } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import {
  CodexSharedAppServerStartupError,
  readCodexNativeTransportStartupFailure,
  readCodexSharedAppServerStartupFailure,
  type CodexSharedAppServerStartupFailure,
} from '../sharedServer.js';

import {
  classifyCodexConnectedServiceAuthFailure,
  isCodexWorkspaceRoutingUnauthorizedFailure,
  type CodexConnectedServiceRuntimeFailureClassification,
} from '../../../auth/services/runtime/auth/failure.js';
import { readRecord, trimStringValue } from '../wire/fields.js';
import { readCodexAppServerErrorPayload, type CodexAppServerErrorPayload } from './errorPayload.js';
import { readCodexAppServerPrimaryFailure } from '../startupFailure.js';
export { readCodexAppServerPrimaryFailure } from '../startupFailure.js';

export type CodexAppServerTurnFailureAuthContext = Readonly<{
  profileId: string | null;
  groupId: string | null;
}>;

export type CodexAppServerTurnFailureSourceAccountIdentity = Readonly<{
  providerAccountId?: string | null;
  accountLabel?: string | null;
  profileId?: string | null;
  groupId?: string | null;
  generation?: string | number | null;
  credentialRevision?: string | null;
  credentialFingerprint?: string | null;
}>;

const CODEX_APP_SERVER_AUTH_ACCOUNT_CHANGED_MESSAGE =
  'Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.';
const CODEX_APP_SERVER_CONTEXT_WINDOW_EXHAUSTED_MESSAGE_MARKERS = [
  'codex ran out of room',
  'context window',
] as const;
const CODEX_APP_SERVER_TURN_FAILURE_MESSAGE = 'Codex app-server turn failed.';
const STARTUP_AUTHENTICATION_FAILURES = {
  refresh_bridge_unavailable: { source: 'dependency_failure', preview: 'Agent authentication is unavailable on this machine. Reconnect the machine or update Happier.' },
  provider_account_identity_unavailable: { source: 'auth_error', preview: 'The selected account could not be identified. Sign in again or reconnect the account.' },
  experimental_api_unavailable: { source: 'dependency_failure', preview: 'This Agent version cannot sign in with the selected account. Update the Agent on this machine.' },
  workspace_incompatible: { source: 'auth_error', preview: 'The selected account does not match this workspace. Sign in with the required account.' },
  credential_family_mismatch: { source: 'auth_error', preview: 'The selected account does not support this sign-in method. Sign in again with a supported account.' },
  live_hot_auth_failed: { source: 'auth_error', preview: 'The Agent could not sign in with the selected account. Sign in again or reconnect the account.' },
} as const satisfies Record<AgentStartupFailureDetails['reason'], { source: SessionRuntimeIssueV1['source']; preview: string }>;
const CODEX_APP_SERVER_TOOL_RESTRICTION_FAILURE_CODES = [
  'codex_tool_restriction_unsupported_runtime',
  'codex_tool_restriction_unsupported_model',
  'codex_tool_restriction_unsupported_auth',
  'codex_tool_restriction_catalog_unavailable',
] as const;
const CODEX_APP_SERVER_LOCAL_FAILURE_CODES: ReadonlySet<string> = new Set([
  'codex_collaboration_mode_unavailable',
  'codex_app_server_unexpected_exit',
  'codex_app_server_turn_in_flight',
  ...CODEX_APP_SERVER_TOOL_RESTRICTION_FAILURE_CODES,
]);
const CODEX_APP_SERVER_DIAGNOSTIC_ERROR_CODES = new Set([
  'ContextWindowExceeded',
  'UsageLimitExceeded',
  'Unauthorized',
  'Other',
  'HttpConnectionFailed',
]);
const CODEX_APP_SERVER_RUNTIME_AUTH_KIND_VALUES = [
  'usage_limit',
  'rate_limit',
  'temporary_throttle',
  'capacity',
  'auth_expired',
  'account_changed',
  'refresh_failed',
  'permission_denied',
  'plan',
  'unknown',
] as const;
const CODEX_APP_SERVER_RUNTIME_AUTH_KINDS: ReadonlySet<string> = new Set(
  CODEX_APP_SERVER_RUNTIME_AUTH_KIND_VALUES,
);

type CodexFailureCause = NonNullable<SessionRuntimeIssueV1['failureCause']>;
type CodexTurnFailureReason = CodexFailureCause['failureReason'];
const CODEX_APP_SERVER_RUNTIME_AUTH_LIMIT_CATEGORIES = new Set([
  'usage_limit',
  'rate_limit',
  'capacity',
  'auth_invalid',
  'plan_invalid',
]);
const CODEX_APP_SERVER_RUNTIME_AUTH_SOURCES = new Set([
  'structured_provider_error',
  'stable_provider_message',
  'provider_runtime_marker',
]);
const CODEX_APP_SERVER_SAFE_PLAN_TYPES = new Set([
  'free',
  'go',
  'plus',
  'pro',
  'team',
  'business',
  'enterprise',
  'edu',
]);

type CodexAppServerStartRejection = JsonRpcApplicationRejectionDetails &
  Readonly<{
    inputTooLarge?: Readonly<{ maxChars?: number; actualChars?: number }>;
  }>;

class CodexAppServerTurnFailure extends Error {
  declare readonly code?: string;
  declare readonly details?: Readonly<{ failureCause?: CodexFailureCause }>;
  readonly failurePhase: CodexFailureCause['phase'];
  inputNotDispatched: boolean;
  readonly retryable: boolean;
  readonly failureReason: CodexTurnFailureReason;
  declare readonly providerErrorCode?: string | number;
  declare readonly httpStatus?: number;
  readonly isAuthAccountChanged: boolean;
  readonly contextWindowExhaustionEvidence: 'structured' | 'message' | null;
  readonly isTemporaryRecoverableTurnFailure: boolean;
  readonly runtimeAuthClassification: unknown | null;
  readonly providerError: ProviderErrorV1 | null;
  readonly isWorkspaceRoutingUnauthorized: boolean;
  readonly isRejectedStartModelEntitlement: boolean;
  readonly startRejection: CodexAppServerStartRejection | null;

  constructor(
    message: string,
    options: Readonly<{
      isAuthAccountChanged: boolean;
      contextWindowExhaustionEvidence: 'structured' | 'message' | null;
      isTemporaryRecoverableTurnFailure: boolean;
      runtimeAuthClassification: unknown | null;
      isWorkspaceRoutingUnauthorized: boolean;
      isRejectedStartModelEntitlement: boolean;
      startRejection: CodexAppServerStartRejection | null;
      nativeAuthenticationRequired: boolean;
      providerError?: ProviderErrorV1 | null;
      phase?: CodexFailureCause['phase'];
      code?: string;
      inputNotDispatched?: boolean;
      retryable?: boolean;
      providerErrorCode?: string | number;
      httpStatus?: number;
    }>,
  ) {
    super(message);
    this.name = 'CodexAppServerTurnFailure';
    this.failurePhase = options.phase ?? 'turn';
    this.inputNotDispatched = options.inputNotDispatched === true;
    this.retryable = options.retryable === true;
    if (options.code) this.code = options.code;
    this.isAuthAccountChanged = options.isAuthAccountChanged;
    this.contextWindowExhaustionEvidence =
      options.contextWindowExhaustionEvidence;
    this.isTemporaryRecoverableTurnFailure =
      options.isTemporaryRecoverableTurnFailure;
    this.runtimeAuthClassification = options.runtimeAuthClassification;
    this.providerError = options.providerError ?? null;
    this.isWorkspaceRoutingUnauthorized =
      options.isWorkspaceRoutingUnauthorized;
    this.isRejectedStartModelEntitlement =
      options.isRejectedStartModelEntitlement;
    this.startRejection = options.startRejection;
    const classification = readRecord(options.runtimeAuthClassification);
    this.failureReason = options.isWorkspaceRoutingUnauthorized
      ? 'workspace_routing_unauthorized'
      : options.contextWindowExhaustionEvidence === 'structured'
        ? 'context_window_exceeded'
        : options.isAuthAccountChanged
          ? 'auth_account_changed'
          : options.nativeAuthenticationRequired
            ? 'authentication_required'
            : (CODEX_APP_SERVER_RUNTIME_AUTH_KIND_VALUES.find(
                (kind) => kind === classification?.kind,
              ) ?? 'unclassified_provider_error');
    if (options.providerErrorCode !== undefined)
      this.providerErrorCode = options.providerErrorCode;
    if (this.providerError)
      this.code = this.providerError.code;
    else if (options.providerErrorCode === 'model_not_found')
      this.code = 'provider_model_not_found';
    else if (options.nativeAuthenticationRequired)
      this.code = 'provider_endpoint_auth_required';
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
  }
}

export function readCodexAppServerTurnFailureDiagnostic(
  error: unknown,
): Readonly<{
  failureReason: CodexTurnFailureReason;
  providerErrorCode?: string | number;
  httpStatus?: number;
}> {
  return error instanceof CodexAppServerTurnFailure
    ? {
        failureReason: error.failureReason,
        ...(error.providerErrorCode === undefined
          ? {}
          : { providerErrorCode: error.providerErrorCode }),
        ...(error.httpStatus === undefined
          ? {}
          : { httpStatus: error.httpStatus }),
      }
    : { failureReason: 'unclassified_provider_error' };
}

function readRetainedFailureCause(error: unknown): CodexFailureCause | null {
  const candidate =
    readRecord(readRecord(error)?.details)?.failureCause ??
    readRecord(readRecord(error)?.runtimeIssueV1)?.failureCause;
  const retained = SessionRuntimeFailureCauseV1Schema.safeParse(candidate);
  return retained.success ? retained.data : null;
}

function readRedactedProviderErrorMessage(error: unknown, nativeStartup = false, nativeProviderMessage?: string | null): string | undefined {
  const startupDetails = readAgentStartupFailureDetails(error);
  if (startupDetails) return STARTUP_AUTHENTICATION_FAILURES[startupDetails.reason].preview;
  // Native host PluginErrors already carry their owner's failure message.
  // Retain it under the same redaction and preview budget as native output.
  let message = nativeProviderMessage;
  if (!message && error instanceof Error) {
    const preview = readRecord(error)?.stderrPreview;
    const nativeError = error instanceof CodexSharedAppServerStartupError && error.cause instanceof Error
      ? error.cause : error;
    message = readJsonRpcApplicationRejection(error) ? error.message
      : typeof preview === 'string' ? preview
        : nativeStartup && (!readSessionRuntimeIssueCode(readRecord(nativeError)?.code)
          || (isPluginError(nativeError)
            && !readAgentStartupFailureCode(nativeError.code)
            && !readSessionPreparationFailureCode(nativeError.code))
          || readCodexNativeTransportStartupFailure(nativeError)) ? nativeError.message : undefined;
  }
  return message ? redactBugReportSensitiveText(message).trim().slice(0, SESSION_RUNTIME_ISSUE_PREVIEW_MAX_LENGTH) || undefined : undefined;
}

export function readCodexAppServerFailureCause(
  error: unknown,
): CodexFailureCause {
  if (error instanceof CodexAppServerTurnFailure && error.details?.failureCause)
    return error.details.failureCause;
  const retained = readRetainedFailureCause(error);
  if (retained) {
    const startupDetails = readAgentStartupFailureDetails(error);
    return startupDetails
      ? { ...retained, providerErrorMessage: STARTUP_AUTHENTICATION_FAILURES[startupDetails.reason].preview }
      : retained;
  }
  const diagnostic = readCodexAppServerTurnFailureDiagnostic(error);
  const rejection =
    readCodexAppServerStartRejection(error) ??
    readJsonRpcApplicationRejection(error);
  const nativeStartup = readCodexAppServerStartupFailure(error);
  const providerErrorMessage = readRedactedProviderErrorMessage(error);
  const code =
    // This reader already admits only closed OS identities. Keep the cause
    // beneath the public startup category, never native prose or paths.
    (nativeStartup?.phase === 'native_system_error' ? nativeStartup.errnoCode : null) ??
    readCodexAppServerFailureCode(error) ??
    readCodexAppServerSafeErrorCode(error);
  return SessionRuntimeFailureCauseV1Schema.parse({
    ...(code ? { code } : {}),
    phase:
      error instanceof CodexAppServerTurnFailure ? error.failurePhase : 'turn',
    ...diagnostic,
    ...(error instanceof CodexAppServerTurnFailure ? { retryable: error.retryable } : {}),
    ...readAgentStartupFailureDetails(error),
    ...(rejection ? { providerErrorCode: rejection.providerErrorCode } : {}),
    ...(providerErrorMessage ? { providerErrorMessage } : {}),
  });
}

export function readCodexAppServerFailureCode(error: unknown): string | null {
  return error instanceof CodexAppServerTurnFailure
    ? (error.code ?? null)
    : null;
}

export function readCodexAppServerProviderError(error: unknown): ProviderErrorV1 | null {
  return error instanceof CodexAppServerTurnFailure ? error.providerError : null;
}

/** Error codes are non-content identifiers; the issue owner supplies their bound. */
export function readCodexAppServerSafeErrorCode(error: unknown): string | null {
  return readSessionRuntimeIssueCode(readRecord(error)?.code);
}

export function readCodexAppServerRuntimeIssueSource(
  error: unknown,
): SessionRuntimeIssueV1['source'] {
  const projected = sanitizeSessionRuntimeIssueV1(
    readRecord(error)?.runtimeIssueV1,
  );
  if (projected) return projected.source;
  const startupDetails = readAgentStartupFailureDetails(error);
  if (startupDetails) return STARTUP_AUTHENTICATION_FAILURES[startupDetails.reason].source;
  if (
    ProviderBrokerAdmissionFailureCodeV1Schema.safeParse(
      readRecord(error)?.code,
    ).success
  )
    return 'team_credential';
  const kind = trimStringValue(
    readRecord(readRecord(error)?.runtimeAuthClassification)?.kind,
  );
  switch (kind) {
    case 'usage_limit':
    case 'rate_limit':
      return 'usage_limit';
    case 'auth_expired':
    case 'account_changed':
    case 'refresh_failed':
      return 'auth_error';
    case 'temporary_throttle':
    case 'permission_denied':
      return 'agent_status_error';
    default:
      return 'agent_session_error';
  }
}

/** Only the input-dispatch owner may establish this pre-effect proof. */
export function isCodexAppServerPreTurnFailure(
  error: unknown,
): error is Error & { code: string; retryable: boolean } {
  return (
    error instanceof CodexAppServerTurnFailure &&
    error.inputNotDispatched &&
    typeof error.code === 'string'
  );
}

function readBoundedString(value: unknown, maxLength = 256): string | null {
  const normalized = trimStringValue(value);
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function readEnumValue(
  value: unknown,
  allowed: ReadonlySet<string>,
): string | null {
  const normalized = readBoundedString(value, 64);
  return normalized && allowed.has(normalized) ? normalized : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

export function sanitizeCodexAppServerRuntimeAuthClassification(
  value: unknown,
): Readonly<Record<string, unknown>> | null {
  const classification = readRecord(value);
  const kind = readEnumValue(
    classification?.kind,
    CODEX_APP_SERVER_RUNTIME_AUTH_KINDS,
  );
  const source = readEnumValue(
    classification?.source,
    CODEX_APP_SERVER_RUNTIME_AUTH_SOURCES,
  );
  if (!classification || !kind || !source) return null;

  const limitCategory = readEnumValue(
    classification.limitCategory,
    CODEX_APP_SERVER_RUNTIME_AUTH_LIMIT_CATEGORIES,
  );
  const serviceId =
    classification.serviceId === 'openai-codex' ? 'openai-codex' : null;
  const profileId = readBoundedString(classification.profileId);
  const groupId = readBoundedString(classification.groupId);
  const resetsAtMs = readNonNegativeInteger(classification.resetsAtMs);
  const retryAfterMs = readNonNegativeInteger(classification.retryAfterMs);
  const planType = readEnumValue(
    classification.planType,
    CODEX_APP_SERVER_SAFE_PLAN_TYPES,
  );
  const providerLimitId = readBoundedString(classification.providerLimitId);
  const sourceProviderAccountId = readBoundedString(
    classification.sourceProviderAccountId,
  );
  const sourceAccountLabel = readBoundedString(
    classification.sourceAccountLabel,
  );
  const failingAccessTokenFingerprint = readBoundedString(
    classification.failingAccessTokenFingerprint,
    64,
  );
  const groupGeneration = readNonNegativeInteger(
    classification.groupGeneration,
  );
  const expectedCredentialRevision = readBoundedString(
    classification.expectedCredentialRevision,
    64,
  );
  const recoveryAction = readRecord(classification.recoveryAction);
  const recoveryActionKind =
    recoveryAction?.kind === 'provider_state_sharing_required' ||
    recoveryAction?.kind === 'quota_recovery_required'
      ? recoveryAction.kind
      : null;

  return {
    kind,
    ...(limitCategory ? { limitCategory } : {}),
    ...(serviceId ? { serviceId } : {}),
    ...(classification.profileId === null
      ? { profileId: null }
      : profileId
        ? { profileId }
        : {}),
    ...(classification.groupId === null
      ? { groupId: null }
      : groupId
        ? { groupId }
        : {}),
    ...(classification.resetsAtMs === null
      ? { resetsAtMs: null }
      : resetsAtMs === null
        ? {}
        : { resetsAtMs }),
    ...(classification.retryAfterMs === null
      ? { retryAfterMs: null }
      : retryAfterMs === null
        ? {}
        : { retryAfterMs }),
    ...(classification.connectedServiceRecovery === 'available'
      ? { connectedServiceRecovery: 'available' }
      : {}),
    ...(classification.quotaScope === 'provider' ||
    classification.quotaScope === 'model'
      ? { quotaScope: classification.quotaScope }
      : {}),
    ...(providerLimitId ? { providerLimitId } : {}),
    ...(planType ? { planType } : {}),
    ...(sourceProviderAccountId ? { sourceProviderAccountId } : {}),
    ...(sourceAccountLabel ? { sourceAccountLabel } : {}),
    ...(failingAccessTokenFingerprint ? { failingAccessTokenFingerprint } : {}),
    ...(groupGeneration === null ? {} : { groupGeneration }),
    ...(expectedCredentialRevision ? { expectedCredentialRevision } : {}),
    source,
    ...(recoveryActionKind
      ? { recoveryAction: { kind: recoveryActionKind } }
      : {}),
  };
}

export function readCodexAppServerRetryReason(
  value: unknown,
): NonNullable<
  Extract<AgentSessionRuntimeEvent, { kind: 'turn-progress' }>['retry']
>['reason'] {
  const payload = readCodexAppServerErrorPayload(value);
  if (payload?.httpStatus === 429) return 'rate_limited';
  if (payload?.httpStatus !== undefined && payload.httpStatus >= 500)
    return 'server_error';
  switch (normalizeCodexErrorInfo(payload?.codexErrorInfo ?? null)) {
    case 'ratelimitexceeded':
      return 'rate_limited';
    case 'serveroverloaded':
    case 'internalservererror':
      return 'server_error';
    case 'httpconnectionfailed':
    case 'responsestreamconnectionfailed':
    case 'responsestreamdisconnected':
      return 'connection_failed';
    default:
      return 'unknown';
  }
}

function isCodexAppServerAuthAccountChangedPayload(
  payload: CodexAppServerErrorPayload,
): boolean {
  const codexErrorInfo = payload.codexErrorInfo?.toLowerCase() ?? null;
  const hasAuthAccountChangedMessage = [
    payload.message,
    payload.additionalDetails,
  ].some((value) =>
    value?.includes(CODEX_APP_SERVER_AUTH_ACCOUNT_CHANGED_MESSAGE),
  );
  return (
    hasAuthAccountChangedMessage &&
    (!codexErrorInfo || codexErrorInfo === 'unauthorized')
  );
}

export function isCodexAppServerAuthAccountChangedError(
  error: unknown,
): boolean {
  if (error instanceof CodexAppServerTurnFailure) {
    return error.isAuthAccountChanged;
  }
  if (!(error instanceof Error)) return false;
  return error.message.includes(CODEX_APP_SERVER_AUTH_ACCOUNT_CHANGED_MESSAGE);
}

function normalizeCodexErrorInfo(value: string | null): string | null {
  return value ? value.replace(/[_\-\s]/g, '').toLowerCase() : null;
}

function textMatchesCodexContextWindowExhaustedMessage(
  value: string | null,
): boolean {
  const normalized = value?.toLowerCase() ?? '';
  return CODEX_APP_SERVER_CONTEXT_WINDOW_EXHAUSTED_MESSAGE_MARKERS.every(
    (marker) => normalized.includes(marker),
  );
}

function readCodexAppServerContextWindowExhaustionEvidence(
  payload: CodexAppServerErrorPayload,
): 'structured' | 'message' | null {
  if (
    normalizeCodexErrorInfo(payload.codexErrorInfo) === 'contextwindowexceeded'
  )
    return 'structured';
  return [payload.message, payload.additionalDetails].some(
    textMatchesCodexContextWindowExhaustedMessage,
  )
    ? 'message'
    : null;
}

export function isCodexAppServerContextWindowExhaustedError(
  error: unknown,
  options?: Readonly<{ structuredOnly: boolean }>,
): boolean {
  if (error instanceof CodexAppServerTurnFailure) {
    return options?.structuredOnly
      ? error.contextWindowExhaustionEvidence === 'structured'
      : error.contextWindowExhaustionEvidence !== null;
  }
  if (options?.structuredOnly || !(error instanceof Error)) return false;
  return textMatchesCodexContextWindowExhaustedMessage(error.message);
}

export function isCodexAppServerTemporaryRecoverableTurnFailureError(
  error: unknown,
): boolean {
  if (error instanceof CodexAppServerTurnFailure) {
    return error.isTemporaryRecoverableTurnFailure;
  }
  if (!(error instanceof Error)) return false;
  return classifyProviderLimitEvidence(error).category === 'capacity';
}

export function shouldDeferCodexAppServerTurnFailureToPromptLoop(
  error: unknown,
): boolean {
  return (
    isCodexAppServerAuthAccountChangedError(error) ||
    isCodexAppServerContextWindowExhaustedError(error) ||
    isCodexAppServerTemporaryRecoverableTurnFailureError(error)
  );
}

export function readCodexAppServerStartupFailure(
  error: unknown,
): CodexSharedAppServerStartupFailure | null {
  const primary = readCodexAppServerPrimaryFailure(error);
  return (
    readCodexSharedAppServerStartupFailure(
      readRecord(primary)?.startupFailure,
    ) ?? readCodexNativeTransportStartupFailure(primary)
  );
}

export function readCodexAppServerToolRestrictionFailureCode(
  error: unknown,
): (typeof CODEX_APP_SERVER_TOOL_RESTRICTION_FAILURE_CODES)[number] | null {
  const code = readRecord(error)?.code;
  return (
    CODEX_APP_SERVER_TOOL_RESTRICTION_FAILURE_CODES.find(
      (known) => known === code,
    ) ?? null
  );
}

function readModelEntitlementClassification(
  classification: CodexConnectedServiceRuntimeFailureClassification | null,
): CodexConnectedServiceRuntimeFailureClassification | null {
  return classification?.kind === 'plan' &&
    classification.limitCategory === 'plan_invalid' &&
    classification.quotaScope === 'model' &&
    Boolean(classification.providerLimitId)
    ? classification
    : null;
}

/** The model a classified account entitlement refusal names, for a bounded user preview. */
export function readCodexAppServerRefusedModelId(
  error: unknown,
): string | null {
  const classification = sanitizeCodexAppServerRuntimeAuthClassification(
    readRecord(error)?.runtimeAuthClassification,
  );
  return classification?.kind === 'plan' &&
    classification.limitCategory === 'plan_invalid' &&
    classification.quotaScope === 'model' &&
    typeof classification.providerLimitId === 'string'
    ? classification.providerLimitId
    : null;
}

export function createCodexAppServerTurnFailure(
  params: Readonly<{
    value: unknown;
    phase?: CodexFailureCause['phase'];
    inputNotDispatched?: boolean;
    authContext?: CodexAppServerTurnFailureAuthContext | null;
    sourceAccountIdentity?: CodexAppServerTurnFailureSourceAccountIdentity | null;
    providerConnectionId?: string | null;
    /** The native request owner proved application rejection before any provider work. */
    providerStartRejected?: 'thread/start' | 'turn/start';
  }>,
): Error {
  const primary = readCodexAppServerPrimaryFailure(params.value);
  if (primary !== params.value)
    return createCodexAppServerTurnFailure({ ...params, value: primary });
  if (params.value instanceof CodexAppServerTurnFailure) {
    if (params.inputNotDispatched) params.value.inputNotDispatched = true;
    return params.value;
  }
  const submission = classifyJsonRpcSubmissionFailure(params.value, {
    method: params.providerStartRejected ?? 'turn/start',
    effectObserved: params.providerStartRejected === undefined,
  });
  let startRejection: CodexAppServerStartRejection | null = null;
  if (submission.kind === 'rejected_before_effect') {
    // Codex rust-v0.163.0 reports this structured admission error. The
    // provider owns the character limit; Happier never enforces a local cap.
    const data = readRecord((params.value as JsonRpcApplicationError).data);
    const inputTooLarge =
      submission.details.providerErrorCode === -32602 &&
      data?.input_error_code === 'input_too_large';
    startRejection = {
      ...submission.details,
      ...(inputTooLarge
        ? {
            inputTooLarge: {
              ...(Number.isSafeInteger(data.max_chars) &&
              Number(data.max_chars) >= 0
                ? { maxChars: Number(data.max_chars) }
                : {}),
              ...(Number.isSafeInteger(data.actual_chars) &&
              Number(data.actual_chars) >= 0
                ? { actualChars: Number(data.actual_chars) }
                : {}),
            },
          }
        : {}),
    };
  }
  const payload = readCodexAppServerErrorPayload(params.value);
  const rawCode = readRecord(params.value)?.code;
  const providerCode = ProviderErrorCodeV1Schema.safeParse(rawCode);
  const authContext = params.authContext ?? {
    profileId: params.sourceAccountIdentity?.profileId ?? null,
    groupId: params.sourceAccountIdentity?.groupId ?? null,
  };
  // A precise model-unavailable code must not become account/plan recovery
  // merely because its private message happens to match an auth phrase.
  const classifyAuthFailure = (error: unknown) =>
    classifyCodexConnectedServiceAuthFailure({
      providerErrorPath: true,
      error,
      serviceId: 'openai-codex',
      profileId: authContext.profileId,
      groupId: authContext.groupId,
      sourceAccountIdentity: params.sourceAccountIdentity
        ? {
            providerAccountId: params.sourceAccountIdentity.providerAccountId,
            accountLabel: params.sourceAccountIdentity.accountLabel,
            groupGeneration: params.sourceAccountIdentity.generation,
            credentialRevision: params.sourceAccountIdentity.credentialRevision,
            credentialFingerprint:
              params.sourceAccountIdentity.credentialFingerprint,
          }
        : null,
    });
  const retainedRuntimeAuth = sanitizeCodexAppServerRuntimeAuthClassification(
    readRecord(params.value)?.runtimeAuthClassification,
  );
  const runtimeAuthClassification =
    retainedRuntimeAuth ??
    (payload && !payload.providerErrorCode && !providerCode.success
      ? (classifyAuthFailure(params.value) ??
        // The app-server's structured HTTP status is authoritative even
        // when its private message contains no recognized auth marker.
        (payload.httpStatus === 401
          ? classifyAuthFailure({ error: { code: 'unauthorized' } })
          : null))
      : // A precise model refusal is pool evidence only when it proves this
        // account cannot serve the named model; other prose stays unclassified.
        payload?.providerErrorCode === 'model_not_found'
        ? readModelEntitlementClassification(classifyAuthFailure(params.value))
        : null);
  // The same structured native HTTP evidence targets the admitted model source.
  // A forbidden response alone does not prove that its credential is invalid.
  const providerError = params.providerConnectionId
    ? payload?.httpStatus === 401
      ? createProviderErrorV1('provider_endpoint_unauthorized', { connectionId: params.providerConnectionId })
      : payload?.transportFailureWithoutResponse && !payload.providerErrorCode && !providerCode.success
        ? createProviderErrorV1('provider_endpoint_unreachable', { connectionId: params.providerConnectionId })
        : null
    : null;
  const nativeAuthenticationRequired =
    !params.providerConnectionId &&
    payload?.httpStatus === 401 &&
    runtimeAuthClassification?.kind === 'auth_expired' &&
    !isCodexWorkspaceRoutingUnauthorizedFailure(params.value) &&
    !authContext.profileId &&
    !authContext.groupId;
  const sanitizedClassification =
    sanitizeCodexAppServerRuntimeAuthClassification(runtimeAuthClassification);
  const providerErrorCode =
    payload?.providerErrorCode ??
    [...CODEX_APP_SERVER_DIAGNOSTIC_ERROR_CODES].find(
      (code) =>
        normalizeCodexErrorInfo(code) ===
        normalizeCodexErrorInfo(payload?.codexErrorInfo ?? null),
    ) ??
    readJsonRpcApplicationRejection(params.value)?.providerErrorCode;
  const knownCode =
    readAgentStartupFailureCode(rawCode) ??
    readSessionPreparationFailureCode(rawCode) ??
    (providerCode.success ? providerCode.data : null) ??
    (typeof rawCode === 'string' &&
    CODEX_APP_SERVER_LOCAL_FAILURE_CODES.has(rawCode)
      ? rawCode
      : null);
  const retainedCause = readRetainedFailureCause(params.value);
  const phase = retainedCause?.phase ?? params.phase ?? 'turn';
  const nativeStartup = phase === 'client_start' || phase === 'thread_open' || phase === 'authentication';
  const providerErrorMessage = readRedactedProviderErrorMessage(params.value, nativeStartup,
    phase === 'turn' && params.providerConnectionId && payload?.codexErrorInfo ? payload.message : undefined);
  const daemonPreparationCause = RunnerDaemonPluginServicesPreparationCauseV1Schema.safeParse(
    readRecord(readRecord(params.value)?.details)?.cause,
  );
  const preparationCause = retainedCause?.preparationCause
    ?? (daemonPreparationCause.success ? daemonPreparationCause.data : undefined);
  const startupFailure = readCodexAppServerStartupFailure(params.value);
  const nativeClientFailure = rawCode === 'PLUGIN_EXEC_CLIENT_EXITED' || rawCode === 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR';
  const phaseCode =
    nativeStartup
      ? params.value instanceof Error &&
        params.value.name === 'JsonRpcApplicationError' &&
        typeof rawCode === 'number'
        ? 'agent_startup_rpc_rejected'
        : params.value instanceof TypeError
          ? 'agent_startup_invalid_state'
          : params.value instanceof Error || startupFailure || nativeClientFailure
            ? 'agent_startup_transport_failed'
            : 'agent_startup_failed'
      : undefined;
  const code =
    (nativeClientFailure && phaseCode ? phaseCode : knownCode) ??
    (startupFailure ? phaseCode : readCodexAppServerSafeErrorCode(params.value)) ??
    phaseCode;
  const failure = new CodexAppServerTurnFailure(
    nativeAuthenticationRequired
      ? 'Sign in to Codex or choose a Codex account.'
      : (readSessionStartupFailurePreview(code) ??
          CODEX_APP_SERVER_TURN_FAILURE_MESSAGE),
    {
      ...(code ? { code } : {}),
      phase,
      inputNotDispatched: params.inputNotDispatched,
      retryable: providerError?.retryable ?? (providerCode.success
        ? createProviderErrorV1(providerCode.data).retryable
        : false),
      nativeAuthenticationRequired,
      providerError,
      startRejection,
      isAuthAccountChanged: payload
        ? isCodexAppServerAuthAccountChangedPayload(payload)
        : false,
      contextWindowExhaustionEvidence: payload
        ? readCodexAppServerContextWindowExhaustionEvidence(payload)
        : null,
      isTemporaryRecoverableTurnFailure:
        runtimeAuthClassification?.kind === 'capacity',
      runtimeAuthClassification: providerError ? null : sanitizedClassification,
      isWorkspaceRoutingUnauthorized:
        isCodexWorkspaceRoutingUnauthorizedFailure(params.value),
      isRejectedStartModelEntitlement:
        params.providerStartRejected !== undefined &&
        sanitizedClassification?.kind === 'plan' &&
        sanitizedClassification.limitCategory === 'plan_invalid' &&
        sanitizedClassification.quotaScope === 'model' &&
        typeof sanitizedClassification.providerLimitId === 'string',
      ...(providerErrorCode === undefined ? {} : { providerErrorCode }),
      ...(payload?.httpStatus === undefined
        ? {}
        : { httpStatus: payload.httpStatus }),
    },
  );
  const startupDetails = readAgentStartupFailureDetails(params.value);
  if (startupDetails)
    Object.assign(failure, {
      reason: startupDetails.reason,
      details: startupDetails,
    });
  if (startupFailure) Object.assign(failure, { startupFailure });
  Object.assign(failure, {
    details: {
      v: 1,
      agentId: 'codex',
      source: readCodexAppServerRuntimeIssueSource(failure),
      ...startupDetails,
      failureCause: {
        ...readCodexAppServerFailureCause(failure),
        ...retainedCause,
        ...(payload?.requestId ? { requestId: payload.requestId } : {}),
        ...(providerErrorMessage ? { providerErrorMessage } : {}),
        ...(preparationCause ? { preparationCause } : {}),
      },
      ...(providerError ? { providerError } : {}),
    },
  });
  if (readRecord(params.value)?.happierNativeResumeIdentityMismatch === true) {
    Object.assign(failure, { happierNativeResumeIdentityMismatch: true });
  }
  return failure;
}

export function isCodexAppServerRejectedStartModelEntitlementError(
  error: unknown,
): error is Error {
  return (
    error instanceof CodexAppServerTurnFailure &&
    error.isRejectedStartModelEntitlement
  );
}

export function readCodexAppServerStartRejection(
  error: unknown,
): CodexAppServerStartRejection | null {
  return error instanceof CodexAppServerTurnFailure
    ? error.startRejection
    : null;
}

export function isCodexAppServerWorkspaceRoutingUnauthorizedError(
  error: unknown,
): boolean {
  return (
    error instanceof CodexAppServerTurnFailure &&
    error.isWorkspaceRoutingUnauthorized
  );
}

export function formatCodexAppServerErrorForUi(error: Error): string {
  const message = redactBugReportSensitiveText(error.message).trim();
  if (!message) return 'Codex error';
  return /^error[:\s]/i.test(message) ? message : `Error: ${message}`;
}
