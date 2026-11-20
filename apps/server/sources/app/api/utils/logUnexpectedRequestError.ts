import { isTransactionStorageError } from '@/storage/transactionErrors';
import { log } from '@/utils/logging/log';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isPrismaErrorCode, readPrismaDriverErrorCause, readPrismaQueryValidationDiagnostic } from '@/storage/prismaErrors';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability/actions';
import { readPostgresTransactionSqlState } from '@/storage/inTx';

// Driver messages can interpolate query values. Use fixed summaries keyed by the database code.
const RAW_QUERY_FAILURE_MESSAGES: Readonly<Partial<Record<string, string>>> = {
    '23503': 'foreign key constraint violation',
    '23505': 'unique constraint violation',
    '22P02': 'invalid text representation',
    '22P05': 'character cannot be represented',
    '42P01': 'undefined table',
    '42804': 'datatype mismatch',
    '1062': 'duplicate key',
    '1146': 'table does not exist',
    '1452': 'foreign key constraint violation',
    '3140': 'invalid JSON text',
    '3141': 'invalid JSON text',
    '787': 'foreign key constraint violation',
    '1555': 'primary key constraint violation',
    '2067': 'unique constraint violation',
};

function readClaimRawQueryDiagnostic(error: unknown) {
    if (!isPrismaErrorCode(error, 'P2010')) return undefined;
    const code = readPrismaDriverErrorCause(error)?.code;
    const databaseErrorCode = code && /^(?:[0-9A-Z]{5}|[0-9]{1,4})$/u.test(code) ? code : undefined;
    return {
        databaseErrorCode,
        databaseErrorMessage: (databaseErrorCode && RAW_QUERY_FAILURE_MESSAGES[databaseErrorCode])
            || 'raw database query failed',
    };
}

/** Shared transport exception diagnostic: allowlisted class/code and source pointers only. */
export function logUnexpectedRequestError(error: unknown, correlation: Readonly<{
    module: 'external-action-error' | 'fastify-error';
    httpRequestId: string;
    requestId?: string;
    actionId?: string;
    phase?: 'action_request' | 'managed_admission';
    method?: string;
    route?: string;
    statusCode?: number;
    responseCode?: string;
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
        const claimRawQuery = correlation.module === 'fastify-error'
            && correlation.method === 'POST'
            && correlation.route === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.collectionWriters.claim']
            ? readClaimRawQueryDiagnostic(storageError) : undefined;
        log({ ...correlation, level: 'error', ...diagnostic, ...(prismaCode ? { prismaCode } : {}),
            ...prismaValidation, ...claimRawQuery,
            ...(sqlState ? { sqlState } : {}) },
            correlation.module === 'websocket' ? 'Unexpected socket request error' : 'Unexpected HTTP request error');
    } catch { /* Diagnostics are best effort and never change the public error. */ }
}
