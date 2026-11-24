export const DATABASE_EXECUTION_ID_ATTRIBUTE = 'happier.db.execution_id';

/** Instrumentation emits a fresh UUID per execution alongside the database span's context. */
export function readDatabaseExecutionId(value: unknown): string | undefined {
    return typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(value) ? value : undefined;
}

export type SqlCommenterExecutionIdentity = Readonly<{ traceId: string; spanId: string; executionIdentity: string }>;

/** Called only for block comments recognized by the PostgreSQL lexer. */
export function readSqlCommenterExecutionIdentity(comment: string): SqlCommenterExecutionIdentity | undefined {
    const text = comment.trim();
    let traceContext: string | undefined;
    let execution: string | undefined;
    let end = 0;
    for (const field of text.matchAll(/([\w.%]+)='([^']*)'(,(?=.)|$)/gy)) {
        end = field.index + field[0].length;
        const [, key, value] = field;
        if (key === 'traceparent') {
            if (traceContext !== undefined) return;
            traceContext = value;
        } else if (key === DATABASE_EXECUTION_ID_ATTRIBUTE) {
            if (execution !== undefined) return;
            execution = value;
        }
    }
    if (end !== text.length) return;
    const traceparent = /^00-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/.exec(traceContext ?? '');
    const traceId = traceparent?.[1];
    const spanId = traceparent?.[2];
    const executionIdentity = readDatabaseExecutionId(execution);
    if (traceId && spanId && !/^0+$/.test(traceId) && !/^0+$/.test(spanId) && executionIdentity) return { traceId, spanId, executionIdentity };
}
