import { expect, it } from 'vitest';
import { UsageHistoryEntry, readUsageHistoryFailure } from './usageHistoryReadState';
import { SessionPartsHttpError, SessionPartsInvalidResponseError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionBatchForAuthority';
import { createSessionEncryptionUnavailableError } from '@/sync/encryption/sessionEncryptionUnavailableError';

it('keeps explicit HTTP refusal codes and unsupported-shape failures without carrying response content', () => {
    expect(readUsageHistoryFailure(new SessionPartsHttpError(503, { error: 'private server diagnostic', code: 'database_unavailable' })))
        .toEqual({ errorCode: 'database_unavailable', retryable: true, errorName: 'Error', httpStatus: 503 });
    expect(readUsageHistoryFailure(new SessionPartsHttpError(503, { error: 'database_transaction_timeout' })))
        .toEqual({ errorCode: 'database_transaction_timeout', retryable: true, errorName: 'Error', httpStatus: 503 });
    expect(readUsageHistoryFailure(new SessionPartsHttpError(503, { error: 'private server diagnostic' })))
        .toEqual({ errorCode: 'http_error', retryable: true, errorName: 'Error', httpStatus: 503 });
    expect(readUsageHistoryFailure(new SessionPartsInvalidResponseError())).toMatchObject({ errorCode: 'usage_session_evidence_read_failed', retryable: true,
        errorName: 'SessionPartsInvalidResponseError' });
    expect(readUsageHistoryFailure({ errorCode: 'invalid_response' })).toMatchObject({ errorCode: 'invalid_response', retryable: false });
    expect(readUsageHistoryFailure(new SessionPartsHttpError(403, { error: 'forbidden', code: 'operation_scope_denied' })))
        .toMatchObject({ errorCode: 'operation_scope_denied', retryable: false, httpStatus: 403 });
    expect(readUsageHistoryFailure({ code: 'usage_work_facts_mode_mismatch' })).toEqual({ errorCode: 'usage_work_facts_mode_mismatch', retryable: false });
});

it.each([
    { code: 'forbidden', error: new SessionPartsHttpError(403, { error: 'forbidden' }) },
    { code: 'scoped_session_encryption_unavailable', error: createSessionEncryptionUnavailableError('denied', 'scoped_session_encryption_unavailable') },
    { code: 'encrypted_access_pending', error: createSessionEncryptionUnavailableError('denied', 'scoped_session_encryption_unavailable', 'encrypted_access_pending') },
    // Only a known content availability replaces the code; any other thrown value keeps its own code.
    { code: 'scoped_session_encryption_unavailable', error: Object.assign(new Error('denied'), {
        code: 'scoped_session_encryption_unavailable', contentAvailability: 'ready' }) },
    { code: 'scoped_session_encryption_unavailable', error: Object.assign(new Error('denied'), {
        code: 'scoped_session_encryption_unavailable', contentAvailability: 'anything_else' }) },
])('keeps lasting Session refusals as quiet partial coverage and transient failures retryable ($code)', ({ code, error }) => {
    const history = new UsageHistoryEntry();
    history.coverage(new Set(['denied', 'unsupported', 'transient']), 0);
    let publications = 0;
    history.listeners.add(() => { publications++; });
    const failure = readUsageHistoryFailure(error);
    expect.soft(failure).toMatchObject({ errorCode: code, retryable: false });
    history.failed(failure.errorCode, 'denied', failure.retryable);
    expect.soft(history.state).toMatchObject({ status: 'partial', errorCode: code, progress: { failed: 0 } });
    const settled = history.state;
    history.failed(failure.errorCode, 'denied', failure.retryable);
    expect.soft(history.state).toBe(settled);
    expect.soft(publications, 'the same settled refusal publishes once').toBe(1);
    history.failed('invalid_response', 'unsupported');
    expect.soft(history.state.progress.failed).toBe(0);
    history.failed('http_error', 'transient');
    expect.soft(history.state).toMatchObject({ status: 'partial', errorCode: 'http_error', progress: { failed: 1 } });
    history.succeeded('transient');
    expect.soft(history.state).toMatchObject({ status: 'partial', errorCode: code, progress: { failed: 0 } });
    history.succeeded('denied');
    history.succeeded('unsupported');
    expect(history.state).toEqual({ status: 'complete', progress: { selected: 3, notRead: 0, completed: 0, failed: 0 } });
    history.failed('forbidden', 'denied');
    history.failed('http_error', 'transient');
    history.coverage(new Set(['unsupported']), 0);
    expect(history.state).toEqual({ status: 'complete', progress: { selected: 1, notRead: 0, completed: 0, failed: 0 } });
    history.failed('operation_scope_denied', 'unsupported', false);
    expect(history.state).toMatchObject({ status: 'partial', errorCode: 'operation_scope_denied', progress: { failed: 0 } });
});
