import type {
    ActionExecuteResult,
    DirectSessionTakeoverPersistResponse,
    DirectSessionTakeoverResponse,
} from '@happier-dev/protocol';
import {
    ExternalSessionTakeoverResultV1Schema,
    type ExternalSessionTakeoverErrorCodeV1,
    type ExternalSessionTakeoverResultV1,
} from '@happier-dev/protocol/sessions';

import { logger } from '@/ui/logger';

export type DirectSessionsErrorCode = 'invalid_request' | 'machine_offline' | 'provider_unavailable' | 'internal_error';

export function directSessionsError(
    errorCode: DirectSessionsErrorCode,
    error?: string,
): { ok: false; errorCode: DirectSessionsErrorCode; error: string } {
    return { ok: false, errorCode, error: typeof error === 'string' && error.trim() ? error : errorCode };
}

export function mapActionFailureToDirectSessionsError(
    result: Extract<ActionExecuteResult, { ok: false }>,
): { ok: false; errorCode: DirectSessionsErrorCode; error: string } {
    const errorCode = result.errorCode === 'machine_offline'
        ? 'machine_offline'
        : result.errorCode === 'provider_unavailable'
            ? 'provider_unavailable'
            : result.errorCode === 'invalid_request' || result.errorCode === 'invalid_parameters'
                ? 'invalid_request'
                : 'internal_error';
    return directSessionsError(errorCode, result.error);
}

function mapExternalTakeoverErrorCodeToDirectSessionsErrorCode(
    errorCode: ExternalSessionTakeoverErrorCodeV1,
    error?: string,
): DirectSessionsErrorCode {
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

function mapExternalTakeoverFailureToDirectSessionsError(
    result: Extract<ExternalSessionTakeoverResultV1, { ok: false }>,
): { ok: false; errorCode: DirectSessionsErrorCode; error: string } {
    return directSessionsError(mapExternalTakeoverErrorCodeToDirectSessionsErrorCode(result.errorCode, result.error), result.error);
}

export function mapExternalTakeoverResultToDirectTakeoverResponse(
    value: unknown,
): DirectSessionTakeoverResponse {
    const parsed = ExternalSessionTakeoverResultV1Schema.safeParse(value);
    if (!parsed.success) return directSessionsError('internal_error', 'takeover_action_result_invalid') satisfies DirectSessionTakeoverResponse;
    if (!parsed.data.ok) return mapExternalTakeoverFailureToDirectSessionsError(parsed.data) satisfies DirectSessionTakeoverResponse;
    return { ok: true } satisfies DirectSessionTakeoverResponse;
}

export function mapExternalTakeoverResultToDirectTakeoverPersistResponse(
    value: unknown,
): DirectSessionTakeoverPersistResponse {
    const parsed = ExternalSessionTakeoverResultV1Schema.safeParse(value);
    if (!parsed.success) return directSessionsError('internal_error', 'takeover_action_result_invalid') satisfies DirectSessionTakeoverPersistResponse;
    if (!parsed.data.ok) return mapExternalTakeoverFailureToDirectSessionsError(parsed.data) satisfies DirectSessionTakeoverPersistResponse;
    return { ok: true, converted: parsed.data.converted } satisfies DirectSessionTakeoverPersistResponse;
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

export function logDirectSessionsInternalError(context: string, error: unknown): void {
    if (process.env.DEBUG) {
        if (error instanceof Error) {
            logger.debug('[directSessions][internal_error]', {
                context,
                name: error.name,
                stack: stripErrorMessageFromStack(error.stack),
            });
            return;
        }
        logger.debug('[directSessions][internal_error]', { context, errorType: typeof error, error });
        return;
    }

    if (error instanceof Error) {
        logger.debug('[directSessions][internal_error]', { context, name: error.name });
        return;
    }
    logger.debug('[directSessions][internal_error]', { context, errorType: typeof error });
}

export function internalErrorResponse(
    context: string,
    error: unknown,
    safeError: string,
): { ok: false; errorCode: DirectSessionsErrorCode; error: string } {
    logDirectSessionsInternalError(context, error);
    return directSessionsError('internal_error', safeError);
}
