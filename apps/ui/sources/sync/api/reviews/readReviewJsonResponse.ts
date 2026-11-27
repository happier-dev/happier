import { createActionExecuteFailureError, readActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

/** Preserve the server's refusal at the Review HTTP boundary for every Action adapter. */
export async function readReviewJsonResponse(response: Response, fallbackCode: string): Promise<unknown> {
    const payload: unknown = await response.json();
    if (response.ok) return payload;
    const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {};
    const code = typeof record.errorCode === 'string' ? record.errorCode
        : typeof record.error === 'string' ? record.error : fallbackCode;
    throw Object.assign(createActionExecuteFailureError({
        ok: false,
        errorCode: code,
        error: typeof record.message === 'string' ? record.message : typeof record.error === 'string' ? record.error : code,
        details: record.details,
        ...(typeof record.requestId === 'string' ? { requestId: record.requestId } : {}),
        ...(typeof record.effectAttempted === 'boolean' ? { effectAttempted: record.effectAttempted } : {}),
        ...(record.failureCause === undefined ? {} : { failureCause: readActionFailureCauseV1(record.failureCause) }),
    }), { status: response.status });
}
