import { classifyProviderLimitEvidence } from '@happier-dev/plugin-sdk/experimental/cloud/auth';
import { redactBugReportSensitiveText } from '@happier-dev/plugin-sdk/experimental/diagnostics';

import { classifyCodexConnectedServiceAuthFailure } from '../../../auth/services/runtime/auth/failure.js';
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
const CODEX_APP_SERVER_RUNTIME_AUTH_KINDS = new Set([
    'usage_limit',
    'rate_limit',
    'temporary_throttle',
    'capacity',
    'auth_expired',
    'account_changed',
    'refresh_failed',
    'permission_denied',
    'unknown',
]);
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

type CodexAppServerErrorPayload = Readonly<{
    message: string | null;
    additionalDetails: string | null;
    codexErrorInfo: string | null;
    resetsAt: unknown;
    retryAfterMs: unknown;
    retryAfter: unknown;
    planType: unknown;
    rateLimits: unknown;
}>;

class CodexAppServerTurnFailure extends Error {
    readonly isAuthAccountChanged: boolean;
    readonly isContextWindowExhausted: boolean;
    readonly isTemporaryRecoverableTurnFailure: boolean;
    readonly runtimeAuthClassification: unknown | null;

    constructor(message: string, options: Readonly<{
        isAuthAccountChanged: boolean;
        isContextWindowExhausted: boolean;
        isTemporaryRecoverableTurnFailure: boolean;
        runtimeAuthClassification: unknown | null;
    }>) {
        super(message);
        this.name = 'CodexAppServerTurnFailure';
        this.isAuthAccountChanged = options.isAuthAccountChanged;
        this.isContextWindowExhausted = options.isContextWindowExhausted;
        this.isTemporaryRecoverableTurnFailure = options.isTemporaryRecoverableTurnFailure;
        this.runtimeAuthClassification = options.runtimeAuthClassification;
    }
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
        ...(classification.quotaScope === 'provider' ? { quotaScope: 'provider' } : {}),
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

function readCodexAppServerErrorPayload(value: unknown): CodexAppServerErrorPayload | null {
    const record = readRecord(value);
    if (!record) return null;

    const directError = readRecord(record.error);
    const turn = readRecord(record.turn);
    const turnError = readRecord(turn?.error);
    const error = directError ?? turnError;
    if (!error) return null;

    return {
        message: trimStringValue(error.message),
        additionalDetails: trimStringValue(error.additionalDetails ?? error.additional_details),
        codexErrorInfo: trimStringValue(error.codexErrorInfo ?? error.codex_error_info),
        resetsAt: error.resetsAt ?? error.resets_at,
        retryAfterMs: error.retryAfterMs ?? error.retry_after_ms,
        retryAfter: error.retryAfter ?? error.retry_after ?? error['retry-after'],
        planType: error.planType ?? error.plan_type,
        rateLimits: error.rateLimits ?? error.rate_limits,
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

function isCodexAppServerContextWindowExhaustedPayload(payload: CodexAppServerErrorPayload): boolean {
    return normalizeCodexErrorInfo(payload.codexErrorInfo) === 'contextwindowexceeded'
        || [payload.message, payload.additionalDetails].some(textMatchesCodexContextWindowExhaustedMessage);
}

export function isCodexAppServerContextWindowExhaustedError(error: unknown): boolean {
    if (error instanceof CodexAppServerTurnFailure) {
        return error.isContextWindowExhausted;
    }
    if (!(error instanceof Error)) return false;
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
    authContext?: CodexAppServerTurnFailureAuthContext | null;
    sourceAccountIdentity?: CodexAppServerTurnFailureSourceAccountIdentity | null;
}>): Error {
    const payload = readCodexAppServerErrorPayload(params.value);
    const authContext = params.authContext ?? {
        profileId: params.sourceAccountIdentity?.profileId ?? null,
        groupId: params.sourceAccountIdentity?.groupId ?? null,
    };
    const runtimeAuthClassification = payload
        ? classifyCodexConnectedServiceAuthFailure({
            providerErrorPath: true,
            error: {
                error: {
                    message: payload.message,
                    additionalDetails: payload.additionalDetails,
                    codexErrorInfo: payload.codexErrorInfo,
                    resetsAt: payload.resetsAt,
                    retryAfterMs: payload.retryAfterMs,
                    retryAfter: payload.retryAfter,
                    planType: payload.planType,
                    rateLimits: payload.rateLimits,
                },
            },
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
    return new CodexAppServerTurnFailure(
        CODEX_APP_SERVER_TURN_FAILURE_MESSAGE,
        {
            isAuthAccountChanged: payload ? isCodexAppServerAuthAccountChangedPayload(payload) : false,
            isContextWindowExhausted: payload ? isCodexAppServerContextWindowExhaustedPayload(payload) : false,
            isTemporaryRecoverableTurnFailure: runtimeAuthClassification?.kind === 'capacity',
            runtimeAuthClassification: sanitizeCodexAppServerRuntimeAuthClassification(runtimeAuthClassification),
        },
    );
}

export function formatCodexAppServerErrorForUi(error: Error): string {
    const message = redactBugReportSensitiveText(error.message).trim();
    if (!message) return 'Codex error';
    return /^error[:\s]/i.test(message) ? message : `Error: ${message}`;
}
