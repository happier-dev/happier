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

export type ExternalSessionsErrorCode = 'invalid_request' | 'machine_offline' | 'provider_unavailable' | 'internal_error';

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
        : result.errorCode === 'provider_unavailable'
            ? 'provider_unavailable'
            : result.errorCode === 'invalid_request' || result.errorCode === 'invalid_parameters'
                ? 'invalid_request'
                : 'internal_error';
    return externalSessionsError(errorCode, result.error);
}

function mapExternalTakeoverErrorCodeToExternalSessionsErrorCode(
    errorCode: ExternalSessionTakeoverErrorCodeV1,
    error?: string,
): ExternalSessionsErrorCode {
    if (errorCode === 'machine_offline') return 'machine_offline';
    if (errorCode === 'transcript_import_failed' || errorCode === 'spawn_failed') return 'internal_error';
    if (errorCode === 'capability_unsupported') {
        return 'provider_unavailable';
    }
    if (
        errorCode === 'takeover_not_available'
        && (error === 'takeover_not_supported' || error === 'not_authenticated')
    ) {
        return 'provider_unavailable';
    }
    if (errorCode === 'invalid_external_source' && error === 'session_metadata_unavailable') {
        return 'provider_unavailable';
    }
    return 'invalid_request';
}

function mapExternalTakeoverFailureToExternalSessionsError(
    result: Extract<ExternalSessionTakeoverResultV1, { ok: false }>,
): { ok: false; errorCode: ExternalSessionsErrorCode; error: string } {
    return externalSessionsError(mapExternalTakeoverErrorCodeToExternalSessionsErrorCode(result.errorCode, result.error), result.error);
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

function stripErrorMessageFromStack(stack: string | undefined): string | undefined {
    if (typeof stack !== 'string' || stack.trim().length === 0) return undefined;
    const lines = stack.split('\n');
    if (lines.length === 0) return stack;
    const first = lines[0] ?? '';
    const colon = first.indexOf(':');
    lines[0] = colon >= 0 ? first.slice(0, colon) : first;
    return lines.join('\n');
}

export function logExternalSessionsInternalError(context: string, error: unknown): void {
    if (process.env.DEBUG) {
        if (error instanceof Error) {
            logger.debug('[externalSessions][internal_error]', {
                context,
                name: error.name,
                stack: stripErrorMessageFromStack(error.stack),
            });
            return;
        }
        logger.debug('[externalSessions][internal_error]', { context, errorType: typeof error, error });
        return;
    }

    if (error instanceof Error) {
        logger.debug('[externalSessions][internal_error]', { context, name: error.name });
        return;
    }
    logger.debug('[externalSessions][internal_error]', { context, errorType: typeof error });
}

export function internalErrorResponse(
    context: string,
    error: unknown,
    safeError: string,
): { ok: false; errorCode: ExternalSessionsErrorCode; error: string } {
    logExternalSessionsInternalError(context, error);
    return externalSessionsError('internal_error', safeError);
}
