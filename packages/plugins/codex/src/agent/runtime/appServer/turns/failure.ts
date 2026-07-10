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
}>;

const CODEX_APP_SERVER_AUTH_ACCOUNT_CHANGED_MESSAGE =
    'Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.';
const CODEX_APP_SERVER_CONTEXT_WINDOW_EXHAUSTED_MESSAGE_MARKERS = [
    'codex ran out of room',
    'context window',
] as const;

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

function formatCodexAppServerErrorPayloadMessage(payload: CodexAppServerErrorPayload): string | null {
    if (payload.message && payload.additionalDetails) {
        return `${payload.message}\n\n${payload.additionalDetails}`;
    }
    return payload.message ?? payload.additionalDetails;
}

export function readCodexAppServerErrorMessage(value: unknown): string | null {
    const payload = readCodexAppServerErrorPayload(value);
    return payload ? formatCodexAppServerErrorPayloadMessage(payload) : null;
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

function textMatchesCodexTemporaryRecoverableTurnFailureMessage(value: string | null): boolean {
    const normalized = value?.toLowerCase() ?? '';
    return normalized.includes('selected model is at capacity')
        || (normalized.includes('model is at capacity') && normalized.includes('try a different model'));
}

function isCodexAppServerTemporaryRecoverableTurnFailurePayload(payload: CodexAppServerErrorPayload): boolean {
    return [payload.message, payload.additionalDetails].some(textMatchesCodexTemporaryRecoverableTurnFailureMessage);
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
    return textMatchesCodexTemporaryRecoverableTurnFailureMessage(error.message);
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
    return new CodexAppServerTurnFailure(
        payload ? formatCodexAppServerErrorPayloadMessage(payload) ?? 'Codex app-server turn failed' : 'Codex app-server turn failed',
        {
            isAuthAccountChanged: payload ? isCodexAppServerAuthAccountChangedPayload(payload) : false,
            isContextWindowExhausted: payload ? isCodexAppServerContextWindowExhaustedPayload(payload) : false,
            isTemporaryRecoverableTurnFailure: payload ? isCodexAppServerTemporaryRecoverableTurnFailurePayload(payload) : false,
            runtimeAuthClassification: payload
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
                        }
                        : null,
                })
                : null,
        },
    );
}

export function formatCodexAppServerErrorForUi(error: Error): string {
    const message = error.message.trim();
    if (!message) return 'Codex error';
    return /^error[:\s]/i.test(message) ? message : `Error: ${message}`;
}
