import { readPluginActionFailureAuthorPayload } from '@happier-dev/protocol/plugins/actions/invocation';
import { isActionOutcomeUnknownErrorCodeV1, isPluginError } from '@happier-dev/plugin-sdk/errors';
import { readPluginErrorRequestIdV1 } from '@happier-dev/plugin-sdk';
import type { TriageTaskWriteResultV1 } from '@happier-dev/triage-protocol/v1';

/** Translate only failures received from the host Action transport, which owns dispatch evidence. */
export function triageTaskWriteInvocationFailureV1(error: unknown): TriageTaskWriteResultV1 {
    if (!isPluginError(error)) return { kind: 'uncertain' };
    const requestId = readPluginErrorRequestIdV1(error);
    const details = error.details;
    const effectAttempted = error.data.effectAttempted ?? (
        details !== null && typeof details === 'object' && 'effectAttempted' in details && details.effectAttempted === true
    );
    if (!isActionOutcomeUnknownErrorCodeV1(error.code) && !effectAttempted) {
        return { kind: 'refused', reason: error.code,
            ...(error.data.message === undefined ? {} : { message: error.data.message }),
            details: { ...readPluginActionFailureAuthorPayload(error.data) }, retryable: error.retryable,
            ...(requestId === undefined ? {} : { requestId }) };
    }
    return { kind: 'uncertain', failure: { class: 'unknown', code: error.code, ...(requestId === undefined ? {} : { requestId }) } };
}
