import { isSharedDatabaseConsumer } from "@/config/sharedDatabaseConsumer";

export function isPrismaErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export interface PrismaDriverErrorCause {
    /** Driver adapter error kind (`UniqueConstraintViolation`, `postgres`, `sqlite`, ...). */
    readonly kind: string;
    /** The database's own code: PostgreSQL SQLSTATE, MySQL errno, SQLite extended result code. */
    readonly code: string | undefined;
    /** The database's own message. It may contain values; log it only through a fixed-text filter. */
    readonly message: string | undefined;
    /** The violated constraint, for constraint violations. */
    readonly constraint?: Readonly<{ fields?: readonly string[]; index?: string }>;
}

/**
 * The driver failure under a Prisma 7 error. Driver adapters attach it as
 * `meta.driverAdapterError.cause` (raw queries: P2010; model queries: the mapped P-code, or
 * P2039 for database errors Prisma does not classify). A failure Prisma does not wrap (an
 * interactive transaction's COMMIT, e.g. a serialization conflict) arrives as the adapter's own
 * `DriverAdapterError`, with the same cause directly on it.
 */
function readConstraint(value: unknown): PrismaDriverErrorCause['constraint'] | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const fields = 'fields' in value && Array.isArray(value.fields) && value.fields.every(field => typeof field === 'string')
        ? value.fields as string[] : undefined;
    const index = 'index' in value && typeof value.index === 'string' ? value.index : undefined;
    return fields || index ? { ...(fields ? { fields } : {}), ...(index ? { index } : {}) } : undefined;
}

export function readPrismaDriverErrorCause(error: unknown): PrismaDriverErrorCause | null {
    if (typeof error !== 'object' || error === null) return null;
    const adapterError = 'meta' in error
        ? (typeof error.meta === 'object' && error.meta !== null && 'driverAdapterError' in error.meta ? error.meta.driverAdapterError : null)
        : ('name' in error && error.name === 'DriverAdapterError' ? error : null);
    if (typeof adapterError !== 'object' || adapterError === null || !('cause' in adapterError)) return null;
    const cause = adapterError.cause;
    if (typeof cause !== 'object' || cause === null || !('kind' in cause) || typeof cause.kind !== 'string') return null;
    const record = cause as { kind: string; originalCode?: unknown; code?: unknown; originalMessage?: unknown; message?: unknown; constraint?: unknown };
    const code = record.originalCode ?? record.code;
    const message = record.originalMessage ?? record.message;
    const constraint = readConstraint(record.constraint);
    return {
        kind: record.kind,
        code: typeof code === 'string' || typeof code === 'number' ? String(code) : undefined,
        message: typeof message === 'string' ? message : undefined,
        ...(constraint ? { constraint } : {}),
    };
}

/** The unique constraint a violation names: column `fields` (SQLite) or its `index` name (PostgreSQL, MySQL). */
export interface PrismaUniqueConstraint {
    readonly modelName: string | undefined;
    readonly fields: readonly string[] | undefined;
    readonly index: string | undefined;
}

/**
 * The constraint behind a P2002 (or a raw-query unique violation). Prisma 7 no longer sets
 * `meta.target`; the driver cause carries `constraint`. Null when the error is not a unique
 * violation or names no constraint.
 */
export function readPrismaUniqueConstraint(error: unknown): PrismaUniqueConstraint | null {
    const cause = readPrismaDriverErrorCause(error);
    if (!isPrismaErrorCode(error, 'P2002') && cause?.kind !== 'UniqueConstraintViolation') return null;
    const constraint = cause?.constraint;
    if (!constraint) return null;
    const meta = typeof error === 'object' && error !== null && 'meta' in error ? error.meta : undefined;
    const modelName = typeof meta === 'object' && meta !== null && 'modelName' in meta && typeof meta.modelName === 'string'
        ? meta.modelName : undefined;
    return { modelName, fields: constraint.fields, index: constraint.index };
}

interface PrismaQueryValidationDiagnostic {
    readonly errorCode: 'database_query_validation_failed';
    readonly httpStatus: 500;
    readonly prismaModel: string | null;
    readonly prismaOperation: string | null;
    readonly validationSummary: readonly string[];
}

/** Project Prisma 6 validation sentences, never its invocation, values or suggestions. */
function readPrismaValidationSummary(message: string): readonly string[] {
    const summaries = new Set<string>();
    for (const line of message.replace(/\u001b\[[0-9;]*m/gu, '').split('\n')) {
        const text = line.trim();
        const unknown = /^Unknown (argument|field) `([A-Za-z_][A-Za-z0-9_]*)`(?:[ .]|$)/u.exec(text);
        if (unknown) summaries.add(`Unknown ${unknown[1]}: ${unknown[2]}`);
        const missing = /^Argument `([A-Za-z_][A-Za-z0-9_]*)` (is missing|must not be null)\./u.exec(text);
        if (missing) summaries.add(`${missing[2] === 'is missing' ? 'Missing argument' : 'Null argument'}: ${missing[1]}`);
        const invalid = /^(?:Invalid value for argument|Argument) `([A-Za-z_][A-Za-z0-9_]*)`:/u.exec(text);
        if (invalid) summaries.add(`Invalid argument value: ${invalid[1]}`);
        const required = /^Argument `([A-Za-z_][A-Za-z0-9_]*)` of type [A-Za-z_][A-Za-z0-9_]* needs at least one of (.+) arguments\./u.exec(text);
        if (required) {
            const names = [...required[2].matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/gu)].map(match => match[1]);
            summaries.add(`Missing required selection: ${required[1]}${names.length ? ` (${names.join(', ')})` : ''}`);
        }
    }
    return [...summaries];
}

class PrismaQueryValidationError extends Error {
    readonly code = 'database_query_validation_failed';
    readonly status = 500;
    readonly statusCode = 500;

    constructor(readonly diagnostic: PrismaQueryValidationDiagnostic) {
        super(`Database query validation failed${diagnostic.prismaModel ? ` (${diagnostic.prismaModel}.${diagnostic.prismaOperation})` : ''}${diagnostic.validationSummary.length ? `: ${diagnostic.validationSummary.join('; ')}` : ''}`);
        this.name = 'PrismaClientValidationError';
    }
}

export function readPrismaQueryValidationDiagnostic(error: unknown): PrismaQueryValidationDiagnostic | null {
    if (error instanceof PrismaQueryValidationError) return error.diagnostic;
    if (!(error instanceof Error) || error.name !== 'PrismaClientValidationError') return null;
    return {
        errorCode: 'database_query_validation_failed', httpStatus: 500,
        prismaModel: null, prismaOperation: null,
        validationSummary: readPrismaValidationSummary(error.message),
    };
}

/** Query-extension context is authoritative; the raw invocation is never retained. */
export function withPrismaQueryValidationDiagnostic(
    error: unknown,
    context?: Readonly<{ model?: string; operation: string }>,
): unknown {
    if (error instanceof PrismaQueryValidationError) return error;
    const diagnostic = readPrismaQueryValidationDiagnostic(error);
    return diagnostic ? new PrismaQueryValidationError({
        ...diagnostic, prismaModel: context?.model ?? null, prismaOperation: context?.operation ?? null,
    }) : error;
}

export interface SharedQaSchemaMismatchDiagnostic {
    readonly error: 'shared_qa_schema_mismatch';
    readonly message: string;
}

/** Report query-proven schema skew only for an explicitly shared-DB QA server. */
export function readSharedQaSchemaMismatchDiagnostic(
    error: unknown,
    env: NodeJS.ProcessEnv = process.env,
): SharedQaSchemaMismatchDiagnostic | null {
    if (!isSharedDatabaseConsumer(env)) return null;
    if (!isPrismaErrorCode(error, 'P2021') && !isPrismaErrorCode(error, 'P2022')) return null;
    return {
        error: 'shared_qa_schema_mismatch',
        message: "This QA snapshot cannot query the current shared dev schema; reload a newer snapshot.",
    };
}
