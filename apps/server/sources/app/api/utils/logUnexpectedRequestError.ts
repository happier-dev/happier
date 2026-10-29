import { isTransactionStorageError } from '@/storage/transactionErrors';
import { log } from '@/utils/logging/log';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readPrismaQueryValidationDiagnostic } from '@/storage/prismaErrors';
import { readPostgresTransactionSqlState } from '@/storage/inTx';

/** Shared transport exception diagnostic: allowlisted class/code and source pointers only. */
export function logUnexpectedRequestError(error: unknown, correlation: Readonly<{
    module: 'external-action-error' | 'fastify-error';
    httpRequestId: string;
    requestId?: string;
    actionId?: string;
    phase?: 'action_request' | 'managed_admission';
}> | Readonly<{
    module: 'websocket';
    socketId: string;
    sessionId?: string;
    event: 'pending-materialization-failed';
    phase: 'admission' | 'materialization';
}>): void {
    try {
        const diagnostic = readUnexpectedActionErrorDiagnosticV1(error);
        // Transaction wrappers establish outcome certainty, not the originating
        // database code. Preserve both without retaining a driver message or SQL.
        const storageError = isTransactionStorageError(error)
            ? error.cause : error;
        const storageCode = readUnexpectedActionErrorDiagnosticV1(storageError).errorCode;
        const prismaCode = storageCode && /^P\d{4}$/u.test(storageCode) ? storageCode : undefined;
        const sqlState = readPostgresTransactionSqlState(storageError);
        const prismaValidation = readPrismaQueryValidationDiagnostic(storageError);
        log({ ...correlation, level: 'error', ...diagnostic, ...(prismaCode ? { prismaCode } : {}),
            ...prismaValidation,
            ...(sqlState ? { sqlState } : {}) },
            correlation.module === 'websocket' ? 'Unexpected socket request error' : 'Unexpected HTTP request error');
    } catch { /* Diagnostics are best effort and never change the public error. */ }
}
