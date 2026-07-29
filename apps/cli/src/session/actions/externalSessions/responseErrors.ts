import type {
    ActionExecuteResult,
    ExternalSessionTakeoverPersistResponse,
    ExternalSessionTakeoverResponse,
} from '@happier-dev/protocol';
import {
    ExternalSessionTakeoverResultV1Schema,
    type ExternalSessionTakeoverErrorCodeV1,
    type ExternalSessionTakeoverResultV1,
} from '@happier-dev/protocol/sessions';

import { logger } from '@/ui/logger';
import { isExternalSessionProviderFailureError } from '@/session/external/providerOps';

export type ExternalSessionsErrorCode = 'invalid_request' | 'machine_offline' | 'agent_unavailable' | 'internal_error';

export function externalSessionsError(
    errorCode: ExternalSessionsErrorCode,
    error?: string,
): { ok: false; errorCode: ExternalSessionsErrorCode; error: string } {
    return { ok: false, errorCode, error: typeof error === 'string' && error.trim() ? error : errorCode };
}

export function mapActionFailureToExternalSessionsError(
    result: Extract<ActionExecuteResult, { ok: false }>,
): { ok: false; errorCode: ExternalSessionsErrorCode; error: string } {
    const errorCode = result.errorCode === 'machine_offline'
        ? 'machine_offline'
        : result.errorCode === 'agent_unavailable'
            ? 'agent_unavailable'
            : result.errorCode === 'invalid_request' || result.errorCode === 'invalid_parameters'
                ? 'invalid_request'
                : 'internal_error';
    return externalSessionsError(
        errorCode,
        result.error === 'external_session_takeover_failed'
            ? result.error
            : undefined,
    );
}

function mapProviderFailureCodeToExternalSessionsErrorCode(code: string): ExternalSessionsErrorCode {
    if (code === 'invalid_request' || code === 'source_invalid' || code === 'candidate_not_found') {
        return 'invalid_request';
    }
    if (
        code === 'agent_unavailable'
        || code === 'unavailable'
        || code === 'not_authorized'
        || code === 'provider_error'
        || code === 'timeout'
        || code === 'source_unreachable'
        || code === 'unsupported'
        || code === 'follow_not_supported'
        || code === 'takeover_not_available'
        || code === 'cancelled'
    ) {
        return 'agent_unavailable';
    }
    return 'agent_unavailable';
}

export function mapExternalSessionProviderFailureToExternalSessionsError(
    error: unknown,
): { ok: false; errorCode: ExternalSessionsErrorCode; error: string } | null {
    if (!isExternalSessionProviderFailureError(error)) return null;
    return externalSessionsError(mapProviderFailureCodeToExternalSessionsErrorCode(error.code));
}

function mapExternalTakeoverErrorCodeToExternalSessionsErrorCode(
    errorCode: ExternalSessionTakeoverErrorCodeV1,
    error?: string,
): ExternalSessionsErrorCode {
    if (errorCode === 'machine_offline') return 'machine_offline';
    if (errorCode === 'transcript_import_failed' || errorCode === 'spawn_failed') return 'internal_error';
    if (errorCode === 'capability_unsupported') {
        return 'agent_unavailable';
    }
    if (
        errorCode === 'takeover_not_available'
        && (error === 'takeover_not_supported' || error === 'not_authenticated')
    ) {
        return 'agent_unavailable';
    }
    if (errorCode === 'invalid_external_source' && error === 'session_metadata_unavailable') {
        return 'agent_unavailable';
    }
    return 'invalid_request';
}

function mapExternalTakeoverFailureToExternalSessionsError(
    result: Extract<ExternalSessionTakeoverResultV1, { ok: false }>,
): { ok: false; errorCode: ExternalSessionsErrorCode; error: string } {
    const safeDetail = result.errorCode === 'capability_unsupported'
        ? 'takeover_not_supported'
        : result.errorCode === 'takeover_not_available'
            && (result.error === 'takeover_not_supported' || result.error === 'not_authenticated')
            ? result.error
            : result.errorCode === 'invalid_external_source'
                && result.error === 'session_metadata_unavailable'
                ? result.error
                : result.errorCode;
    return externalSessionsError(
        mapExternalTakeoverErrorCodeToExternalSessionsErrorCode(result.errorCode, result.error),
        safeDetail,
    );
}

export function mapExternalTakeoverResultToDirectTakeoverResponse(
    value: unknown,
): ExternalSessionTakeoverResponse {
    const parsed = ExternalSessionTakeoverResultV1Schema.safeParse(value);
    if (!parsed.success) return externalSessionsError('internal_error', 'takeover_action_result_invalid') satisfies ExternalSessionTakeoverResponse;
    if (!parsed.data.ok) return mapExternalTakeoverFailureToExternalSessionsError(parsed.data) satisfies ExternalSessionTakeoverResponse;
    return { ok: true } satisfies ExternalSessionTakeoverResponse;
}

export function mapExternalTakeoverResultToDirectTakeoverPersistResponse(
    value: unknown,
): ExternalSessionTakeoverPersistResponse {
    const parsed = ExternalSessionTakeoverResultV1Schema.safeParse(value);
    if (!parsed.success) return externalSessionsError('internal_error', 'takeover_action_result_invalid') satisfies ExternalSessionTakeoverPersistResponse;
    if (!parsed.data.ok) return mapExternalTakeoverFailureToExternalSessionsError(parsed.data) satisfies ExternalSessionTakeoverPersistResponse;
    return { ok: true, converted: parsed.data.converted } satisfies ExternalSessionTakeoverPersistResponse;
}

function sanitizeExternalSessionsLogContext(context: string): string {
    return /^[a-z][a-z0-9_.:-]{0,127}$/u.test(context)
        ? context
        : 'external_session.internal_error';
}

export function logExternalSessionsInternalError(context: string, error: unknown): void {
    const safeContext = sanitizeExternalSessionsLogContext(context);
    if (isExternalSessionProviderFailureError(error)) {
        logger.debug('[externalSessions][internal_error]', {
            context: safeContext,
            errorCode: mapProviderFailureCodeToExternalSessionsErrorCode(error.code),
            errorKind: 'agent_failure',
            retryable: error.retryable === true,
        });
        return;
    }

    if (error instanceof Error) {
        logger.debug('[externalSessions][internal_error]', {
            context: safeContext,
            errorCode: 'internal_error',
            errorKind: 'error',
        });
        return;
    }
    logger.debug('[externalSessions][internal_error]', {
        context: safeContext,
        errorCode: 'internal_error',
        errorKind: 'non_error',
    });
}

export function internalErrorResponse(
    context: string,
    error: unknown,
    safeError: string,
): { ok: false; errorCode: ExternalSessionsErrorCode; error: string } {
    logExternalSessionsInternalError(context, error);
    return externalSessionsError('internal_error', safeError);
}
