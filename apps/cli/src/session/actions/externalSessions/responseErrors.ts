import type {
    ActionExecuteResult,
    ExternalSessionTakeoverPersistResponse,
} from '@happier-dev/protocol';
import { SPAWN_SESSION_ERROR_DETAIL_KINDS, SpawnSessionErrorCodeSchema } from '@happier-dev/protocol/spawnSession';
import { ExternalSessionTakeoverResultV1Schema } from '@happier-dev/protocol/sessions/external/takeoverV1';
import type { ExternalSessionTakeoverErrorCodeV1, ExternalSessionTakeoverResultV1, ExternalSessionsRpcErrorCode } from '@happier-dev/protocol/sessions';

import { logger } from '@/ui/logger';
import {
    isExternalSessionFollowFailureError,
    type ExternalSessionFollowFailureKind,
} from '@/session/external/externalSessionFollowFailure';
import { isExternalSessionProviderFailureError } from '@/session/external/providerOps';
import { isAgentExternalSessionsFailureCode } from '@happier-dev/plugin-sdk/sessions/external';
import { ExternalSessionPersistedTakeoverPreflightError } from './persistedTakeoverPreflightError';
import { classifyServerEndpointError, isNetworkConnectionErrorCode, readNormalizedConnectionErrorCode } from '@/api/client/classifyServerEndpointError';

const TAKEOVER_ADMISSION_INVARIANT_CODES = [
    'persisted_takeover_admission_invalid_metadataVersion',
    'persisted_takeover_admission_invalid_seq',
    'persisted_takeover_admission_publication_missing',
    'persisted_takeover_admission_authority_mismatch',
    'persisted_takeover_admission_follow_not_suspended',
    'persisted_takeover_retry_hosted_target_mismatch',
    'external_linked_takeover_admission_authority_mismatch',
] as const;

export class ExternalSessionTakeoverAdmissionInvariantError extends Error {
    constructor(readonly code: typeof TAKEOVER_ADMISSION_INVARIANT_CODES[number]) {
        super(code);
        this.name = 'ExternalSessionTakeoverAdmissionInvariantError';
    }
}

export type ExternalSessionsErrorCode = ExternalSessionsRpcErrorCode;

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

/**
 * Contribution failure codes that name a malformed request rather than an
 * unavailable Agent. Every other code the SDK admits is an Agent-side failure.
 */
const AGENT_FAILURE_CODES_ANSWERED_AS_INVALID_REQUEST: ReadonlySet<string> = new Set([
    'invalid_request',
    'source_invalid',
    'candidate_not_found',
]);

/**
 * A timeout and an Agent fault each keep their own outward class: a person
 * retries the first and inspects the session or Agent for the second, and
 * neither means the Agent is missing. The remaining Agent-side codes say the
 * Agent cannot serve this request on this machine. Anything else — a
 * host-internal condition such as `conflict`, or a code no owner recognizes —
 * is a genuine internal error. Answering `agent_unavailable` there sends a
 * person to look at their Agent for a fault that is not theirs.
 */
function mapProviderFailureCodeToExternalSessionsErrorCode(code: string): ExternalSessionsErrorCode {
    if (AGENT_FAILURE_CODES_ANSWERED_AS_INVALID_REQUEST.has(code)) return 'invalid_request';
    if (code === 'timeout') return 'agent_timeout';
    if (code === 'agent_error') return 'agent_error';
    if (isAgentExternalSessionsFailureCode(code)) return 'agent_unavailable';
    return 'internal_error';
}

function readExternalSessionsSafeDiagnostic(message: string) {
    // Only exact host-recognized reasons may cross this diagnostic boundary.
    // Arbitrary Agent messages can contain transcript text or private paths.
    const diagnostics: Readonly<Record<string, Readonly<{ failureClass: string; reason: string }>>> = {
        external_sessions_native_cursor_too_large: { failureClass: 'result_admission', reason: 'native_cursor_too_large' },
        external_sessions_failure_byte_budget: { failureClass: 'result_admission', reason: 'failure_byte_budget' },
        external_sessions_result_envelope: { failureClass: 'result_admission', reason: 'result_envelope' },
        external_sessions_result_value: { failureClass: 'result_admission', reason: 'result_value' },
        external_sessions_result_byte_budget: { failureClass: 'result_admission', reason: 'result_byte_budget' },
        external_sessions_transcript_page_envelope: { failureClass: 'result_admission', reason: 'transcript_page_envelope' },
        external_sessions_transcript_page_item: { failureClass: 'result_admission', reason: 'transcript_page_item' },
        external_sessions_transcript_page_continuation: { failureClass: 'result_admission', reason: 'transcript_page_continuation' },
        external_sessions_transcript_page_diagnostics: { failureClass: 'result_admission', reason: 'transcript_page_diagnostics' },
        external_sessions_transcript_item_count_budget: { failureClass: 'result_admission', reason: 'transcript_item_count_budget' },
        external_sessions_transcript_item_byte_budget: { failureClass: 'result_admission', reason: 'transcript_item_byte_budget' },
        external_sessions_transcript_page_byte_budget: { failureClass: 'result_admission', reason: 'transcript_page_byte_budget' },
        external_sessions_transcript_item_json: { failureClass: 'result_admission', reason: 'transcript_item_json' },
        external_sessions_transcript_cursor_invalid: { failureClass: 'source_validity', reason: 'transcript_cursor_invalid' },
        external_sessions_transcript_read_failed: { failureClass: 'source_read', reason: 'transcript_read_failed' },
        external_sessions_transcript_request_invalid: { failureClass: 'request_admission', reason: 'transcript_request_invalid' },
        external_sessions_transcript_source_validation: { failureClass: 'source_validity', reason: 'transcript_source_validation' },
        external_sessions_transcript_page_unsupported: { failureClass: 'availability', reason: 'transcript_page_unsupported' },
        external_sessions_operation_type_error: { failureClass: 'TypeError', reason: 'operation_rejected' },
        external_sessions_operation_range_error: { failureClass: 'RangeError', reason: 'operation_rejected' },
        external_sessions_operation_syntax_error: { failureClass: 'SyntaxError', reason: 'operation_rejected' },
        external_sessions_operation_rejected: { failureClass: 'unknown', reason: 'operation_rejected' },
        external_sessions_source_identity_changed: { failureClass: 'source_validity', reason: 'source_identity_changed' },
        external_sessions_source_identity_unavailable: { failureClass: 'source_validity', reason: 'source_identity_unavailable' },
        external_sessions_unfinished_file_missing: { failureClass: 'source_validity', reason: 'unfinished_file_missing' },
        external_sessions_path_authority: { failureClass: 'source_validity', reason: 'path_authority' },
        external_sessions_frontier_anchor: { failureClass: 'source_validity', reason: 'frontier_anchor' },
        external_sessions_content_cursor_invalid: { failureClass: 'source_validity', reason: 'content_cursor_invalid' },
        external_sessions_exact_id_source_changed: { failureClass: 'source_validity', reason: 'exact_id_source_changed' },
        external_sessions_source_kind_mismatch: { failureClass: 'source_validity', reason: 'source_kind_mismatch' },
        external_sessions_source_validation: { failureClass: 'source_validity', reason: 'source_validation' },
        external_sessions_transcript_unsupported_record: { failureClass: 'source_validity', reason: 'transcript_unsupported_record' },
        external_sessions_transcript_record_limit: { failureClass: 'source_validity', reason: 'transcript_record_limit' },
        unsupported_record_skipped: { failureClass: 'source_validity', reason: 'transcript_unsupported_record' },
    };
    return Object.hasOwn(diagnostics, message) ? diagnostics[message] : null;
}

export function logExternalSessionSourceDiscontinuity(diagnostics: readonly Readonly<{ code: string }>[] = []): void {
    const diagnostic = diagnostics.map(value => readExternalSessionsSafeDiagnostic(value.code))
        .find(value => value?.failureClass === 'source_validity');
    logger.debug('[externalSessions][agent_failure]', {
        code: 'source_discontinuity',
        ...(diagnostic ?? { failureClass: 'source_validity', reason: 'transcript_truncated' }),
    });
}

/** A represented codec mismatch is visible item loss, not a source discontinuity. */
export function logExternalSessionUnsupportedTranscriptRecord(diagnostics: readonly Readonly<{ code: string }>[] = []): void {
    const diagnostic = diagnostics.map(value => readExternalSessionsSafeDiagnostic(value.code))
        .find(value => value?.reason === 'transcript_unsupported_record');
    if (!diagnostic) return;
    logger.debug('[externalSessions][agent_failure]', { code: 'unsupported_record', ...diagnostic });
}

export function mapExternalSessionProviderFailureToExternalSessionsError(
    error: unknown,
): { ok: false; errorCode: ExternalSessionsErrorCode; error: string; retryable: boolean } | null {
    if (!isExternalSessionProviderFailureError(error)) return null;
    const errorCode = mapProviderFailureCodeToExternalSessionsErrorCode(error.code);
    const diagnostic = readExternalSessionsSafeDiagnostic(error.message)
        ?? (error.code === 'source_invalid' ? { failureClass: 'source_validity', reason: 'source_validation' }
            : error.operation === 'pageTranscript' ? { failureClass: 'agent_failure', reason: 'transcript_agent_failure' } : {});
    logger.debug('[externalSessions][agent_failure]', {
        code: isAgentExternalSessionsFailureCode(error.code) ? error.code : 'unrecognized',
        errorCode,
        retryable: error.retryable,
        ...diagnostic,
    });
    return {
        ...externalSessionsError(errorCode),
        retryable: error.retryable,
    };
}

/** Host-owned page branches use the same closed safe-token diagnostic owner. */
export function logExternalSessionTranscriptPageFailure(token: string): void {
    const diagnostic = readExternalSessionsSafeDiagnostic(token)
        ?? { failureClass: 'agent_failure', reason: 'transcript_agent_failure' };
    logger.debug('[externalSessions][agent_failure]', { code: 'transcript_page_failure', ...diagnostic });
}

/**
 * Outward answers for the host-owned follow failures. The detail strings are
 * authored here — never taken from a failure message — so a typed failure stays
 * as safe as the opaque internal-error envelope it replaces.
 */
const EXTERNAL_SESSION_FOLLOW_FAILURE_RESPONSES: Readonly<Record<
    ExternalSessionFollowFailureKind,
    Readonly<{ errorCode: ExternalSessionsErrorCode; error: string; retryable: boolean }>
>> = {
    agent_unavailable: {
        errorCode: 'agent_unavailable',
        error: 'external_session_agent_unavailable',
        retryable: true,
    },
    source_changed: {
        errorCode: 'agent_unavailable',
        error: 'external_session_source_changed',
        retryable: true,
    },
    follow_unavailable: {
        errorCode: 'agent_unavailable',
        error: 'external_session_follow_unavailable',
        retryable: false,
    },
    daemon_unavailable: {
        errorCode: 'agent_unavailable',
        error: 'external_session_daemon_unavailable',
        retryable: true,
    },
};

/**
 * Single classifier for a thrown External Sessions corridor failure. Agent
 * failures keep the provider mapping; host-owned follow failures and viewer
 * capacity exhaustion answer with their own typed code. Anything unrecognized
 * returns `null` so its caller keeps reporting a genuine `internal_error`.
 */
export function mapExternalSessionCorridorFailureToExternalSessionsError(
    error: unknown,
): { ok: false; errorCode: ExternalSessionsErrorCode; error: string; retryable?: boolean } | null {
    if (error instanceof Error && 'code' in error && error.code === 'outcome_unknown') {
        logExternalSessionsInternalError('external_session.outcome_unknown', error);
        // A lost create/rejoin receipt cannot establish rollback. Keep the
        // released failure class, but do not flatten its outcome to a generic
        // link failure or mislabel the Home transport as an Agent timeout.
        return externalSessionsError('internal_error', 'external_session_outcome_unknown');
    }
    const providerFailure = mapExternalSessionProviderFailureToExternalSessionsError(error);
    if (providerFailure) return providerFailure;
    if (isExternalSessionFollowFailureError(error)) {
        const response = EXTERNAL_SESSION_FOLLOW_FAILURE_RESPONSES[error.kind];
        return {
            ...externalSessionsError(response.errorCode, response.error),
            retryable: response.retryable,
        };
    }
    return null;
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

export function mapExternalTakeoverResultToDirectTakeoverPersistResponse(
    value: unknown,
): ExternalSessionTakeoverPersistResponse {
    const parsed = ExternalSessionTakeoverResultV1Schema.safeParse(value);
    if (!parsed.success) return externalSessionsError('internal_error', 'takeover_action_result_invalid') satisfies ExternalSessionTakeoverPersistResponse;
    if (!parsed.data.ok) return mapExternalTakeoverFailureToExternalSessionsError(parsed.data) satisfies ExternalSessionTakeoverPersistResponse;
    return { ok: true, converted: parsed.data.converted } satisfies ExternalSessionTakeoverPersistResponse;
}

const MAX_LOGGED_STACK_FRAMES = 8;

/**
 * Locates a plain `Error` without its message: the message and any fields can
 * carry paths, transcript text or tokens, while the constructor name, a
 * symbol-shaped `code` and the stack frames below the message header only
 * name code locations.
 */
function describeErrorLocation(error: Error): Readonly<{
    errorName: string;
    code?: string;
    frames: readonly string[];
}> {
    const name = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(error.name) ? error.name : 'Error';
    const rawCode = (error as { code?: unknown }).code;
    const code = typeof rawCode === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/u.test(rawCode)
        ? rawCode
        : undefined;
    const header = String(error);
    const stack = typeof error.stack === 'string' && error.stack.startsWith(header)
        ? error.stack.slice(header.length)
        : '';
    const frames = stack
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('at '))
        .slice(0, MAX_LOGGED_STACK_FRAMES);
    return { errorName: name, ...(code ? { code } : {}), frames };
}

function sanitizeExternalSessionsLogContext(context: string): string {
    return /^[a-z][a-z0-9_.:-]{0,127}$/u.test(context)
        ? context
        : 'external_session.internal_error';
}

export function logExternalSessionsInternalError(context: string, error: unknown): void {
    const safeContext = sanitizeExternalSessionsLogContext(context);
    if (typeof error === 'object' && error !== null
        && 'type' in error && error.type === 'error' && 'errorCode' in error) {
        const errorCode = SpawnSessionErrorCodeSchema.safeParse(error.errorCode);
        if (errorCode.success) {
            const detail = 'errorDetail' in error ? error.errorDetail : null;
            const detailKind = typeof detail === 'object' && detail !== null && 'kind' in detail
                ? Object.values(SPAWN_SESSION_ERROR_DETAIL_KINDS).find((kind) => kind === detail.kind)
                : undefined;
            logger.debug('[externalSessions][internal_error]', {
                context: safeContext,
                errorCode: errorCode.data,
                errorKind: 'spawn_failure',
                ...(detailKind ? { detailKind } : {}),
            });
            return;
        }
    }
    if (error instanceof ExternalSessionTakeoverAdmissionInvariantError
        && TAKEOVER_ADMISSION_INVARIANT_CODES.includes(error.code)) {
        logger.debug('[externalSessions][internal_error]', {
            context: safeContext,
            errorCode: error.code,
            errorKind: 'takeover_admission_invariant',
        });
        return;
    }
    if (error instanceof ExternalSessionPersistedTakeoverPreflightError
        && (error.actionCode === 'source_unavailable'
            || error.actionCode === 'not_allowed'
            || error.actionCode === 'reconciliation_required')) {
        logger.debug('[externalSessions][internal_error]', {
            context: safeContext,
            errorCode: error.actionCode,
            errorKind: 'takeover_preflight',
        });
        return;
    }
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
        const cause = 'cause' in error ? error.cause : undefined;
        const causeCode = readNormalizedConnectionErrorCode(cause);
        const creationOutcomeUnknown = 'code' in error && error.code === 'outcome_unknown';
        logger.debug('[externalSessions][internal_error]', {
            context: safeContext,
            errorCode: 'internal_error',
            errorKind: 'error',
            ...describeErrorLocation(error),
            ...(creationOutcomeUnknown ? {
                transportKind: causeCode === 'ERR_CANCELED' ? 'cancelled' : classifyServerEndpointError(cause).kind,
                ...(causeCode === 'ERR_CANCELED' || isNetworkConnectionErrorCode(causeCode) ? { causeCode } : {}),
            } : {}),
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
