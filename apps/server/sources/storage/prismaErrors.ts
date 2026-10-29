export function isPrismaErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
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
    if (!env.HAPPIER_STACK_SHARED_DB_SOURCE_STACK?.trim()) return null;
    if (!isPrismaErrorCode(error, 'P2021') && !isPrismaErrorCode(error, 'P2022')) return null;
    return {
        error: 'shared_qa_schema_mismatch',
        message: "This QA snapshot cannot query the current shared dev schema; reload a newer snapshot.",
    };
}
