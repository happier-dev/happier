import { createProviderErrorV1, ProviderErrorCodeV1Schema, type ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { readCodexAppServerErrorPayload, type CodexAppServerErrorPayload } from './errorPayload.js';
import { readCodexAppServerPrimaryFailure } from '../startupFailure.js';
export { readCodexAppServerPrimaryFailure } from '../startupFailure.js';
import { classifyJsonRpcSubmissionFailure, readJsonRpcApplicationRejection, type JsonRpcApplicationRejectionDetails, type JsonRpcApplicationError } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import { SESSION_RUNTIME_ISSUE_PREVIEW_MAX_LENGTH, RunnerDaemonPluginServicesPreparationCauseV1Schema, SessionRuntimeFailureCauseV1Schema, sanitizeSessionRuntimeIssueV1, readAgentStartupFailureCode, readAgentStartupFailureDetails, readSessionPreparationFailureCode, readSessionStartupFailurePreview, type SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { ProviderBrokerAdmissionFailureCodeV1Schema } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { readCodexNativeTransportStartupFailure, readCodexSharedAppServerStartupFailure, type CodexSharedAppServerStartupFailure } from '../sharedServer.js';

import { redactBugReportSensitiveText } from '@happier-dev/plugin-sdk';
import { classifyProviderLimitEvidence } from '@happier-dev/plugin-sdk/first-party/connected-accounts';

import { classifyCodexConnectedServiceAuthFailure, isCodexWorkspaceRoutingUnauthorizedFailure } from '../../../auth/services/runtime/auth/failure.js';
import {
    readRecord,
    trimStringValue,
} from '../wire/fields.js';

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
const CODEX_APP_SERVER_DIAGNOSTIC_ERROR_CODES = new Set([
    'ContextWindowExceeded', 'UsageLimitExceeded', 'Unauthorized', 'Other', 'HttpConnectionFailed',
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
const CODEX_APP_SERVER_RUNTIME_AUTH_KINDS: ReadonlySet<string> = new Set(CODEX_APP_SERVER_RUNTIME_AUTH_KIND_VALUES);

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
    readonly providerError: ProviderErrorV1 | null;
    readonly retryable: boolean;
    readonly inputNotDispatched: boolean;
    readonly failureReason: CodexTurnFailureReason;
    declare readonly providerErrorCode?: string | number;
    declare readonly httpStatus?: number;
    readonly isAuthAccountChanged: boolean;
    readonly contextWindowExhaustionEvidence: 'structured' | 'message' | null;
    readonly isTemporaryRecoverableTurnFailure: boolean;
    readonly runtimeAuthClassification: unknown | null;
    readonly isWorkspaceRoutingUnauthorized: boolean;
    readonly isRejectedStartModelEntitlement: boolean;
    readonly startRejection: CodexAppServerStartRejection | null;

    constructor(message: string, options: Readonly<{
        providerError?: ProviderErrorV1 | null;
        inputNotDispatched?: boolean;
        retryable?: boolean;
        code?: string;
        phase?: CodexFailureCause['phase'];
        isAuthAccountChanged: boolean;
        contextWindowExhaustionEvidence: 'structured' | 'message' | null;
        isTemporaryRecoverableTurnFailure: boolean;
        runtimeAuthClassification: unknown | null;
        isWorkspaceRoutingUnauthorized: boolean;
        isRejectedStartModelEntitlement: boolean;
        startRejection: CodexAppServerStartRejection | null;
        providerErrorCode?: string | number;
        httpStatus?: number;
    }>) {
        super(message);
        this.name = 'CodexAppServerTurnFailure';
        this.failurePhase = options.phase ?? 'turn';
        this.providerError = options.providerError ?? null;
        this.retryable = options.retryable === true;
        this.inputNotDispatched = options.inputNotDispatched === true;
        if (options.code) this.code = options.code;
        this.isAuthAccountChanged = options.isAuthAccountChanged;
        this.contextWindowExhaustionEvidence = options.contextWindowExhaustionEvidence;
        this.isTemporaryRecoverableTurnFailure = options.isTemporaryRecoverableTurnFailure;
        this.runtimeAuthClassification = options.runtimeAuthClassification;
        this.isWorkspaceRoutingUnauthorized = options.isWorkspaceRoutingUnauthorized;
        this.isRejectedStartModelEntitlement = options.isRejectedStartModelEntitlement;
        this.startRejection = options.startRejection;
        const classification = readRecord(options.runtimeAuthClassification);
        this.failureReason = options.isWorkspaceRoutingUnauthorized ? 'workspace_routing_unauthorized'
            : options.contextWindowExhaustionEvidence === 'structured' ? 'context_window_exceeded'
                : options.isAuthAccountChanged ? 'auth_account_changed'
                    : CODEX_APP_SERVER_RUNTIME_AUTH_KIND_VALUES.find(kind => kind === classification?.kind) ?? 'unclassified_provider_error';
        if (options.providerErrorCode !== undefined) this.providerErrorCode = options.providerErrorCode;
        if (this.providerError) this.code = this.providerError.code;
        else if (options.providerErrorCode === 'model_not_found') this.code = 'provider_model_not_found';
        if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    }
}

export function readCodexAppServerTurnFailureDiagnostic(error: unknown): Readonly<{
    failureReason: CodexTurnFailureReason;
    providerErrorCode?: string | number;
    httpStatus?: number;
}> {
    return error instanceof CodexAppServerTurnFailure
        ? {
            failureReason: error.failureReason,
            ...(error.providerErrorCode === undefined ? {} : { providerErrorCode: error.providerErrorCode }),
            ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
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

function readRedactedProviderErrorMessage(error: unknown): string | undefined {
  // Only a correlated provider response admits prose; native/transport errors do not.
  if (!(error instanceof Error) || !readJsonRpcApplicationRejection(error)) return undefined;
  return redactBugReportSensitiveText(error.message).trim().slice(0, SESSION_RUNTIME_ISSUE_PREVIEW_MAX_LENGTH) || undefined;
}

export function readCodexAppServerFailureCause(
  error: unknown,
): CodexFailureCause {
  if (error instanceof CodexAppServerTurnFailure && error.details?.failureCause)
    return error.details.failureCause;
  const retained = readRetainedFailureCause(error);
  if (retained) return retained;
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
    readCodexAppServerFailureCode(error);
  return SessionRuntimeFailureCauseV1Schema.parse({
    ...(code ? { code } : {}),
    phase:
      error instanceof CodexAppServerTurnFailure ? error.failurePhase : 'turn',
    ...diagnostic,
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

export function readCodexAppServerRuntimeIssueSource(
  error: unknown,
): SessionRuntimeIssueV1['source'] {
  const projected = sanitizeSessionRuntimeIssueV1(
    readRecord(error)?.runtimeIssueV1,
  );
  if (projected) return projected.source;
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

function readBoundedString(value: unknown, maxLength = 256): string | null {
    const normalized = trimStringValue(value);
    return normalized && normalized.length <= maxLength ? normalized : null;
}

function readEnumValue(value: unknown, allowed: ReadonlySet<string>): string | null {
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
    const kind = readEnumValue(classification?.kind, CODEX_APP_SERVER_RUNTIME_AUTH_KINDS);
    const source = readEnumValue(classification?.source, CODEX_APP_SERVER_RUNTIME_AUTH_SOURCES);
    if (!classification || !kind || !source) return null;

    const limitCategory = readEnumValue(
        classification.limitCategory,
        CODEX_APP_SERVER_RUNTIME_AUTH_LIMIT_CATEGORIES,
    );
    const serviceId = classification.serviceId === 'openai-codex' ? 'openai-codex' : null;
    const profileId = readBoundedString(classification.profileId);
    const groupId = readBoundedString(classification.groupId);
    const resetsAtMs = readNonNegativeInteger(classification.resetsAtMs);
    const retryAfterMs = readNonNegativeInteger(classification.retryAfterMs);
    const planType = readEnumValue(classification.planType, CODEX_APP_SERVER_SAFE_PLAN_TYPES);
    const providerLimitId = readBoundedString(classification.providerLimitId);
    const sourceProviderAccountId = readBoundedString(classification.sourceProviderAccountId);
    const sourceAccountLabel = readBoundedString(classification.sourceAccountLabel);
    const failingAccessTokenFingerprint = readBoundedString(classification.failingAccessTokenFingerprint, 64);
    const groupGeneration = readNonNegativeInteger(classification.groupGeneration);
    const expectedCredentialRevision = readBoundedString(classification.expectedCredentialRevision, 64);
    const recoveryAction = readRecord(classification.recoveryAction);
    const recoveryActionKind = recoveryAction?.kind === 'provider_state_sharing_required'
        || recoveryAction?.kind === 'quota_recovery_required'
        ? recoveryAction.kind
        : null;

    return {
        kind,
        ...(limitCategory ? { limitCategory } : {}),
        ...(serviceId ? { serviceId } : {}),
        ...(classification.profileId === null ? { profileId: null } : profileId ? { profileId } : {}),
        ...(classification.groupId === null ? { groupId: null } : groupId ? { groupId } : {}),
        ...(classification.resetsAtMs === null ? { resetsAtMs: null } : resetsAtMs === null ? {} : { resetsAtMs }),
        ...(classification.retryAfterMs === null ? { retryAfterMs: null } : retryAfterMs === null ? {} : { retryAfterMs }),
        ...(classification.connectedServiceRecovery === 'available'
            ? { connectedServiceRecovery: 'available' }
            : {}),
        ...(classification.quotaScope === 'provider' || classification.quotaScope === 'model'
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
        ...(recoveryActionKind ? { recoveryAction: { kind: recoveryActionKind } } : {}),
    };
}

function isCodexAppServerAuthAccountChangedPayload(payload: CodexAppServerErrorPayload): boolean {
    const codexErrorInfo = payload.codexErrorInfo?.toLowerCase() ?? null;
    const hasAuthAccountChangedMessage = [payload.message, payload.additionalDetails].some((value) =>
        value?.includes(CODEX_APP_SERVER_AUTH_ACCOUNT_CHANGED_MESSAGE),
    );
    return hasAuthAccountChangedMessage && (!codexErrorInfo || codexErrorInfo === 'unauthorized');
}

export function isCodexAppServerAuthAccountChangedError(error: unknown): boolean {
    if (error instanceof CodexAppServerTurnFailure) {
        return error.isAuthAccountChanged;
    }
    if (!(error instanceof Error)) return false;
    return error.message.includes(CODEX_APP_SERVER_AUTH_ACCOUNT_CHANGED_MESSAGE);
}

function normalizeCodexErrorInfo(value: string | null): string | null {
    return value ? value.replace(/[_\-\s]/g, '').toLowerCase() : null;
}

function textMatchesCodexContextWindowExhaustedMessage(value: string | null): boolean {
    const normalized = value?.toLowerCase() ?? '';
    return CODEX_APP_SERVER_CONTEXT_WINDOW_EXHAUSTED_MESSAGE_MARKERS.every((marker) => normalized.includes(marker));
}

function readCodexAppServerContextWindowExhaustionEvidence(
    payload: CodexAppServerErrorPayload,
): 'structured' | 'message' | null {
    if (normalizeCodexErrorInfo(payload.codexErrorInfo) === 'contextwindowexceeded') return 'structured';
    return [payload.message, payload.additionalDetails].some(textMatchesCodexContextWindowExhaustedMessage)
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

export function isCodexAppServerTemporaryRecoverableTurnFailureError(error: unknown): boolean {
    if (error instanceof CodexAppServerTurnFailure) {
        return error.isTemporaryRecoverableTurnFailure;
    }
    if (!(error instanceof Error)) return false;
    return classifyProviderLimitEvidence(error).category === 'capacity';
}

export function shouldDeferCodexAppServerTurnFailureToPromptLoop(error: unknown): boolean {
    return isCodexAppServerAuthAccountChangedError(error)
        || isCodexAppServerContextWindowExhaustedError(error)
        || isCodexAppServerTemporaryRecoverableTurnFailureError(error);
}

export function createCodexAppServerTurnFailure(params: Readonly<{
    value: unknown;
    providerConnectionId?: string | null;
    inputNotDispatched?: boolean;
    phase?: CodexFailureCause['phase'];
    authContext?: CodexAppServerTurnFailureAuthContext | null;
    sourceAccountIdentity?: CodexAppServerTurnFailureSourceAccountIdentity | null;
    /** The native request owner proved application rejection before any provider work. */
    providerStartRejected?: 'thread/start' | 'turn/start';
}>): Error {
    const primary = readCodexAppServerPrimaryFailure(params.value);
    if (primary !== params.value) return createCodexAppServerTurnFailure({ ...params, value: primary });
    if (params.value instanceof CodexAppServerTurnFailure) return params.value;
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
    const retainedCause = readRetainedFailureCause(params.value);
    const providerErrorMessage = readRedactedProviderErrorMessage(params.value);
    const phase = retainedCause?.phase ?? params.phase;
    const startupFailure = readCodexAppServerStartupFailure(params.value);
    const rawCode = readRecord(params.value)?.code;
    const knownCode = readAgentStartupFailureCode(rawCode) ?? readSessionPreparationFailureCode(rawCode);
    const phaseCode = phase === 'client_start' || phase === 'thread_open' || phase === 'authentication'
        ? params.value instanceof Error && params.value.name === 'JsonRpcApplicationError' && typeof rawCode === 'number'
            ? 'agent_startup_rpc_rejected' : params.value instanceof TypeError ? 'agent_startup_invalid_state'
                : startupFailure ? 'agent_startup_transport_failed' : 'agent_startup_failed'
        : undefined;
    const code = knownCode ?? phaseCode;
    const daemonPreparationCause = RunnerDaemonPluginServicesPreparationCauseV1Schema.safeParse(
        readRecord(readRecord(params.value)?.details)?.cause);
    const preparationCause = retainedCause?.preparationCause
        ?? (daemonPreparationCause.success ? daemonPreparationCause.data : undefined);
    const payload = readCodexAppServerErrorPayload(params.value);
    const providerCode = ProviderErrorCodeV1Schema.safeParse(rawCode);
  // The same structured native HTTP evidence targets the admitted model source.
  // A forbidden response alone does not prove that its credential is invalid.
  const providerError = params.providerConnectionId
    ? payload?.httpStatus === 401
      ? createProviderErrorV1('provider_endpoint_unauthorized', { connectionId: params.providerConnectionId })
      : payload?.transportFailureWithoutResponse && !payload.providerErrorCode && !providerCode.success
        ? createProviderErrorV1('provider_endpoint_unreachable', { connectionId: params.providerConnectionId })
        : null
    : null;

    const authContext = params.authContext ?? {
        profileId: params.sourceAccountIdentity?.profileId ?? null,
        groupId: params.sourceAccountIdentity?.groupId ?? null,
    };
    // A precise model-unavailable code must not become account/plan recovery
    // merely because its private message happens to match an auth phrase.
    const runtimeAuthClassification = payload && !payload.providerErrorCode
        ? classifyCodexConnectedServiceAuthFailure({
            providerErrorPath: true,
            error: params.value,
            serviceId: 'openai-codex',
            profileId: authContext.profileId,
            groupId: authContext.groupId,
            sourceAccountIdentity: params.sourceAccountIdentity
                ? {
                    providerAccountId: params.sourceAccountIdentity.providerAccountId,
                    accountLabel: params.sourceAccountIdentity.accountLabel,
                    groupGeneration: params.sourceAccountIdentity.generation,
                    credentialRevision: params.sourceAccountIdentity.credentialRevision,
                    credentialFingerprint: params.sourceAccountIdentity.credentialFingerprint,
                }
                : null,
        })
        : null;
    const sanitizedClassification = sanitizeCodexAppServerRuntimeAuthClassification(runtimeAuthClassification);
    const providerErrorCode = payload?.providerErrorCode ?? [...CODEX_APP_SERVER_DIAGNOSTIC_ERROR_CODES].find(code =>
        normalizeCodexErrorInfo(code) === normalizeCodexErrorInfo(payload?.codexErrorInfo ?? null))
        ?? readJsonRpcApplicationRejection(params.value)?.providerErrorCode;
    const failure = new CodexAppServerTurnFailure(
        readSessionStartupFailurePreview(code) ?? CODEX_APP_SERVER_TURN_FAILURE_MESSAGE,
        {
            ...(code ? { code } : {}),
            phase,
            providerError,
            retryable: providerError?.retryable,
            inputNotDispatched: params.inputNotDispatched,
            isAuthAccountChanged: payload ? isCodexAppServerAuthAccountChangedPayload(payload) : false,
            contextWindowExhaustionEvidence: payload ? readCodexAppServerContextWindowExhaustionEvidence(payload) : null,
            isTemporaryRecoverableTurnFailure: runtimeAuthClassification?.kind === 'capacity',
            runtimeAuthClassification: providerError ? null : sanitizedClassification,
            isWorkspaceRoutingUnauthorized: isCodexWorkspaceRoutingUnauthorizedFailure(params.value),
            startRejection,
            isRejectedStartModelEntitlement: params.providerStartRejected !== undefined
                && sanitizedClassification?.kind === 'plan'
                && sanitizedClassification.limitCategory === 'plan_invalid'
                && sanitizedClassification.quotaScope === 'model'
                && typeof sanitizedClassification.providerLimitId === 'string',
            ...(providerErrorCode ? { providerErrorCode } : {}),
            ...(payload?.httpStatus === undefined ? {} : { httpStatus: payload.httpStatus }),
        },
    );
    if (startupFailure) Object.assign(failure, { startupFailure });
    const startupDetails = readAgentStartupFailureDetails(params.value);
    if (startupDetails) Object.assign(failure, { reason: startupDetails.reason });
    Object.assign(failure, { details: {
        ...(providerError ? { providerError } : {}),
        v: 1, agentId: 'codex', source: readCodexAppServerRuntimeIssueSource(failure), ...startupDetails,
        failureCause: { ...readCodexAppServerFailureCause(failure), ...retainedCause,
            ...(providerErrorMessage ? { providerErrorMessage } : {}),
            ...(preparationCause ? { preparationCause } : {}) },
    } });
    if (readRecord(params.value)?.happierNativeResumeIdentityMismatch === true) {
        Object.assign(failure, { happierNativeResumeIdentityMismatch: true });
    }
    return failure;
}

export function isCodexAppServerRejectedStartModelEntitlementError(error: unknown): error is Error {
    return error instanceof CodexAppServerTurnFailure && error.isRejectedStartModelEntitlement;
}

export function readCodexAppServerStartRejection(
  error: unknown,
): CodexAppServerStartRejection | null {
  return error instanceof CodexAppServerTurnFailure
    ? error.startRejection
    : null;
}

export function isCodexAppServerWorkspaceRoutingUnauthorizedError(error: unknown): boolean {
    return error instanceof CodexAppServerTurnFailure && error.isWorkspaceRoutingUnauthorized;
}

export function formatCodexAppServerErrorForUi(error: Error): string {
    const message = redactBugReportSensitiveText(error.message).trim();
    if (!message) return 'Codex error';
    return /^error[:\s]/i.test(message) ? message : `Error: ${message}`;
}
