import { isPrismaErrorCode } from "@/storage/prismaErrors";

/** Recovery exhausted after the transaction owner established rollback. */
export class TransactionConflictExhaustedError extends Error {
    readonly code = "database_transaction_conflict_exhausted";

    constructor(readonly cause: unknown) {
        super("Database transaction conflict recovery is exhausted");
        this.name = "TransactionConflictExhaustedError";
    }
}

export function isTransactionConflictExhaustedError(error: unknown): error is TransactionConflictExhaustedError {
    return error instanceof TransactionConflictExhaustedError;
}

export class TransactionAcquisitionUnavailableError extends Error {
    readonly code = "P2028";
    readonly cause: unknown;

    constructor(cause: unknown) {
        super("Database transaction acquisition is temporarily unavailable");
        this.name = "TransactionAcquisitionUnavailableError";
        this.cause = cause;
    }
}

export class TransactionDeadlineExceededError extends Error {
    readonly code = "database_transaction_timeout";

    constructor(readonly cause: unknown, readonly transactionClass?: string) {
        super("Database transaction deadline expired");
        this.name = "TransactionDeadlineExceededError";
    }
}

export function isTransactionDeadlineExceededError(error: unknown): error is TransactionDeadlineExceededError {
    return error instanceof TransactionDeadlineExceededError;
}

export function isTransactionAcquisitionUnavailableError(
    error: unknown,
): error is TransactionAcquisitionUnavailableError {
    return error instanceof TransactionAcquisitionUnavailableError;
}

/** Typed terminal transaction refusals only. Raw transport failures do not establish rollback,
 * and a deadline retains its original cause without certifying a commit outcome. */
export function isTransactionStorageError(error: unknown): error is TransactionConflictExhaustedError
    | TransactionAcquisitionUnavailableError | TransactionDeadlineExceededError {
    return isTransactionConflictExhaustedError(error)
        || isTransactionAcquisitionUnavailableError(error) || isTransactionDeadlineExceededError(error);
}

/** Shared by global and route-local handlers; each transport retains its own envelope. */
export function readDatabaseErrorCode(error: unknown): 'database_transaction_conflict_exhausted' | 'database_transaction_timeout' | 'database_connection_unavailable' | null {
    if (isTransactionConflictExhaustedError(error)) {
        return error.code;
    }
    if (isTransactionDeadlineExceededError(error)) {
        return error.code;
    }
    // Availability is not proof of rollback: connection loss must never opt
    // an unknown transaction outcome into the confirmed-no-effect replay path.
    if (['P1001', 'P1002', 'P1017', 'P2024'].some(code => isPrismaErrorCode(error, code)) || isTransactionAcquisitionUnavailableError(error)) {
        return 'database_connection_unavailable';
    }
    return null;
}

