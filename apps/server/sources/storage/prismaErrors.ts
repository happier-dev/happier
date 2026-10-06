export function isPrismaErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
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
