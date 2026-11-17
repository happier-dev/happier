import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionPendingEnqueueByMachineResponseV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import type { SessionAccessProjectionRow } from '@/app/session/access/sessionAccess';
import { createRouteTestBuilder } from '@/app/api/testkit/routeTestBuilder';
import { TransactionDeadlineExceededError } from '@/storage/inTx';

const database = vi.hoisted(() => ({ transaction: vi.fn() }));
const logging = vi.hoisted(() => ({ warn: vi.fn() }));
// Capture the diagnostic output boundary without replacing storage classification.
vi.mock('@/utils/logging/log', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/logging/log')>(), warn: logging.warn,
}));
const ownerSession = {
    id: 'session', accountId: 'account', account: { status: 'active' }, primaryTeamId: null,
    seq: 0, currentStorageState: 'hosted', acceptedThroughServerSeq: null,
    materializationPublicationId: null, materializedThroughSourceAt: null, publishedThroughServerSeq: null,
    grants: [],  
} satisfies SessionAccessProjectionRow;
// The database transaction boundary fails before any admission can commit.
// Admission, transaction retry classification and result projection stay real.
vi.mock('@/storage/db', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/storage/db')>(),
    db: { $transaction: database.transaction, session: { findUnique: async () => ownerSession },
        sessionPendingMessage: { findUnique: async () => ({ status: 'queued', deliveryState: 'blocked',
            deliveryBlockedReason: 'runtime_config_blocked', providerAction: null,
            requestedAction: { v: 1, kind: 'enqueue' }, inputAdmissionReceipt: null,
            updatedAt: new Date(0), messageRole: 'user', authorAccountId: 'account' }) },
    },
}));

import { enqueuePendingMessage, enqueuePendingMessageByAuthenticatedMachine, resolveAcceptedPendingDelivery, restorePendingMessage } from './pendingMessageService';
import { materializeNextPendingMessage } from './materializeNextPendingMessage';
import { sessionPendingRoutes } from '@/app/api/routes/session/pendingRoutes';

describe('Machine input admission transaction failures', () => {
    afterEach(() => { vi.unstubAllEnvs(); database.transaction.mockReset(); logging.warn.mockClear(); });

    it.each([
        { failure: new TransactionDeadlineExceededError(null, 'pending-action'), status: 503, runId: undefined },
        { failure: Object.assign(new Error('Transaction rolled back'), { code: 'P2034' }), status: 503, runId: undefined },
        { failure: new TransactionDeadlineExceededError(null, 'pending-action'), status: 503, runId: 'run_delivery_retry' },
        { failure: new Error('Private driver query and input'), status: 500, runId: undefined },
    ])('preserves the pending-action retry cause ($status, $runId)', async ({ failure, status, runId }) => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        database.transaction.mockRejectedValue(failure);
        const route = createRouteTestBuilder({
            method: 'PATCH', path: runId
                ? '/v2/sessions/:sessionId/execution-runs/:runId/pending/:localId/action'
                : '/v2/sessions/:sessionId/pending/:localId/action',
            registerRoutes(app) {
                sessionPendingRoutes(app as unknown as Parameters<typeof sessionPendingRoutes>[0]);
            },
        });
        const { reply, response } = await route.invoke({ userId: 'account', authAuthority: 'present_user',
            params: { sessionId: 'session', localId: 'retained-input', ...(runId ? { runId } : {}) },
            body: { requestedAction: { v: 1, kind: 'enqueue' } },
        });
        expect(reply.statusCode).toBe(status);
        expect(response).toEqual(status === 503
            ? { error: 'transaction-unavailable', retryAfterMs: 1_000 } : { error: 'internal' });
        if (status === 503) expect(reply.headers['Retry-After'] ?? reply.headers['retry-after']).toBe('1');
        expect(logging.warn.mock.calls[0]?.[0]).toMatchObject({
            operation: 'requested-action', err: { errorClass: status === 503
                ? (failure instanceof TransactionDeadlineExceededError ? 'TransactionDeadlineExceededError' : 'TransactionConflictExhaustedError')
                : 'Error', errorCode: status === 503
                ? (failure instanceof TransactionDeadlineExceededError ? 'database_transaction_timeout' : 'database_transaction_conflict_exhausted')
                : null },
        });
        expect(JSON.stringify(logging.warn.mock.calls)).not.toContain('Private driver query and input');
    });

    it('preserves a storage deadline across enqueue, provider acceptance and restore envelopes', async () => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        const timeout = new TransactionDeadlineExceededError(null, 'pending-timeout');
        database.transaction.mockRejectedValue(timeout);
        const authentication = { env: process.env, authority: 'present_user' as const, authenticationEvidence: undefined };
        await expect(enqueuePendingMessage({ actorUserId: 'account', sessionId: 'session', localId: 'timed-out-input',
            content: { t: 'encrypted', c: 'opaque-input' }, requestedAction: { v: 1, kind: 'enqueue' }, authentication,
        })).resolves.toMatchObject({ ok: false, error: 'transaction-unavailable', retryAfterMs: 1_000 });
        await expect(resolveAcceptedPendingDelivery({ actorUserId: 'account', sessionId: 'session', localId: 'timed-out-input',
            publisherAuthority: { accountId: 'account', machineId: 'machine', sessionId: 'session', committedFence: new Date(0) },
        })).resolves.toMatchObject({ ok: false, error: 'transaction-unavailable', retryAfterMs: 1_000 });
        await expect(restorePendingMessage({ actorUserId: 'account', sessionId: 'session', localId: 'timed-out-input', authentication,
        })).resolves.toEqual({ ok: false, error: 'transaction-unavailable', retryAfterMs: 1_000 });
    });

    it.each([
        { code: 'P2034', message: 'Transaction failed due to a write conflict or a deadlock.' },
        { code: 'P2010', message: 'Raw query failed. Code: 40001. could not serialize access due to concurrent update' },
        { code: 'P2028', message: 'Unable to start a transaction in the given time.' },
        { code: 'P2028', message: 'Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 15000 ms, however 15048 ms passed since the start of the transaction.' },
    ])('reports $code as a definite rejection after the transaction owner exhausts recovery', async (failure) => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        database.transaction.mockRejectedValue(Object.assign(new Error(failure.message), {
            code: failure.code, meta: { error: failure.message, ...(failure.code === 'P2010'
                ? { driverAdapterError: { cause: { kind: 'TransactionWriteConflict', originalCode: '40001' } } } : {}) },
        }));
        const result = await enqueuePendingMessageByAuthenticatedMachine({
            accountId: 'account', sourceMachineId: 'machine', targetMachineId: 'machine',
            sessionId: 'session', localId: 'first-input', content: { t: 'encrypted', c: 'opaque-input' },
            requestedAction: { v: 1, kind: 'enqueue' },
        });
        expect(SessionPendingEnqueueByMachineResponseV1Schema.parse({ v: 1, result }).result)
            .toEqual({ status: 'rejected', code: 'session_input_storage_unavailable' });
    });

    it('does not claim rejection when the database outcome is indeterminate', async () => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        database.transaction.mockRejectedValue(new Error('Connection lost while awaiting commit'));
        await expect(enqueuePendingMessageByAuthenticatedMachine({
            accountId: 'account', sourceMachineId: 'machine', targetMachineId: 'machine',
            sessionId: 'session', localId: 'first-input', content: { t: 'encrypted', c: 'opaque-input' },
            requestedAction: { v: 1, kind: 'enqueue' },
        })).resolves.toEqual({
            status: 'outcomeUnknown', localId: 'first-input', code: 'session_input_admission_outcome_unknown',
        });
    });

    it('keeps a pending input unmaterialized when conflict recovery is exhausted', async () => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        database.transaction.mockRejectedValue(Object.assign(new Error('Rolled back'), { code: 'P2034' }));
        await expect(materializeNextPendingMessage({
            actorUserId: 'account', sessionId: 'session', deliveryState: 'provider',
            deliveryTiming: 'after_foreground_ready', foregroundState: 'ready',
            publisherAuthority: { accountId: 'account', machineId: 'machine', sessionId: 'session', committedFence: new Date(0) },
        })).resolves.toEqual({ ok: false, error: 'transaction-unavailable', retryAfterMs: 1_000 });
    });

    it('keeps restore retryable when its storage transaction rolls back', async () => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        database.transaction.mockRejectedValue(Object.assign(new Error('Rolled back'), { code: 'P2034' }));
        await expect(restorePendingMessage({ actorUserId: 'account', sessionId: 'session', localId: 'retained-input',
            authentication: { env: process.env, authority: 'present_user', authenticationEvidence: undefined },
        })).resolves.toEqual({ ok: false, error: 'transaction-unavailable', retryAfterMs: 1_000 });
    });

    it('projects a rolled-back restore through the real pending route as retryable 503', async () => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        database.transaction.mockRejectedValue(Object.assign(new Error('Rolled back'), { code: 'P2034' }));
        const route = createRouteTestBuilder({
            method: 'POST', path: '/v2/sessions/:sessionId/pending/:localId/restore',
            defaultRequest: { authAuthority: 'present_user' },
            registerRoutes(app) {
                // The canonical route harness supplies the Fastify methods used by route registration.
                sessionPendingRoutes(app as unknown as Parameters<typeof sessionPendingRoutes>[0]);
            },
        });
        const { reply, response } = await route.invoke({ userId: 'account', authAuthority: 'present_user',
            params: { sessionId: 'session', localId: 'retained-input' },
        });
        expect(reply.statusCode).toBe(503);
        expect(response).toEqual({ error: 'transaction-unavailable', retryAfterMs: 1_000 });
        expect(reply.headers['Retry-After'] ?? reply.headers['retry-after']).toBe('1');
    });

    it('reports provider-acceptance storage refusal without claiming the external provider rejected input', async () => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        database.transaction.mockRejectedValue(Object.assign(new Error('Rolled back'), { code: 'P2034' }));
        await expect(resolveAcceptedPendingDelivery({ actorUserId: 'account', sessionId: 'session', localId: 'accepted-input',
            publisherAuthority: { accountId: 'account', machineId: 'machine', sessionId: 'session', committedFence: new Date(0) },
            diagnosticCorrelationId: 'acceptance-conflict',
        })).resolves.toEqual({ ok: false, error: 'transaction-unavailable', retryAfterMs: 1_000, correlationId: 'acceptance-conflict' });
    });

    it('keeps an exhausted SQLite socket timeout outcome unknown', async () => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'sqlite');
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        database.transaction.mockRejectedValue(Object.assign(new Error('Socket timeout'), { code: 'P1008' }));
        await expect(enqueuePendingMessageByAuthenticatedMachine({ accountId: 'account', sourceMachineId: 'machine',
            targetMachineId: 'machine', sessionId: 'session', localId: 'ambiguous-input', content: { t: 'encrypted', c: 'opaque-input' },
            requestedAction: { v: 1, kind: 'enqueue' },
        })).resolves.toEqual({ status: 'outcomeUnknown', localId: 'ambiguous-input', code: 'session_input_admission_outcome_unknown' });
    });

    it('retains an ambiguous SQLite admission when the last acquisition attempt fails', async () => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'sqlite');
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '1');
        database.transaction
            .mockRejectedValueOnce(Object.assign(new Error('Socket timeout'), { code: 'P1008' }))
            .mockRejectedValueOnce(Object.assign(new Error('Unable to start a transaction in the given time.'), { code: 'P2028' }));
        await expect(enqueuePendingMessageByAuthenticatedMachine({ accountId: 'account', sourceMachineId: 'machine',
            targetMachineId: 'machine', sessionId: 'session', localId: 'ambiguous-input', content: { t: 'encrypted', c: 'opaque-input' },
            requestedAction: { v: 1, kind: 'enqueue' },
        })).resolves.toEqual({ status: 'outcomeUnknown', localId: 'ambiguous-input', code: 'session_input_admission_outcome_unknown' });
    });

    it('reports conflict refusal without passing private driver diagnostics to logging', async () => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        database.transaction.mockRejectedValue(Object.assign(new Error('private input inside driver query'), { code: 'P2034' }));
        await enqueuePendingMessageByAuthenticatedMachine({
            accountId: 'account', sourceMachineId: 'machine', targetMachineId: 'machine',
            sessionId: 'session', localId: 'first-input', content: { t: 'encrypted', c: 'opaque-input' },
            requestedAction: { v: 1, kind: 'enqueue' },
        });
        expect(logging.warn).toHaveBeenCalled();
        const diagnostics = JSON.stringify(logging.warn.mock.calls, (_key, value) => value instanceof Error
            ? { message: value.message, cause: value.cause } : value);
        expect(diagnostics).not.toContain('private input inside driver query');
    });

    it.each([
        { code: 'P2034', message: 'Transaction rolled back after write conflict' },
        { code: 'P2010', message: 'Raw query failed. Code: 40001. could not serialize access due to concurrent update' },
    ])('returns the retryable refusal consumed by HTTP when $code recovery is exhausted', async (failure) => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        database.transaction.mockRejectedValue(Object.assign(new Error(failure.message), {
            code: failure.code,
            ...(failure.code === 'P2010' ? { meta: { driverAdapterError: { cause: { kind: 'TransactionWriteConflict', originalCode: '40001' } } } } : {}),
        }));
        await expect(enqueuePendingMessage({
            actorUserId: 'account', sessionId: 'session', localId: 'retained-input',
            content: { t: 'encrypted', c: 'opaque-input' }, diagnosticCorrelationId: 'enqueue-conflict',
            requestedAction: { v: 1, kind: 'enqueue' },
            authentication: { env: process.env, authority: 'present_user', authenticationEvidence: undefined },
        })).resolves.toMatchObject({
            ok: false, error: 'transaction-unavailable', retryAfterMs: 1_000,
            correlationId: 'enqueue-conflict',
        });
    });
});
