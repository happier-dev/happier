import { DatabaseStatsObservationV1Schema, type DatabaseStatsIntervalBasisV1, type DatabaseStatsObservationV1, type DatabaseStatsReadV1, type DatabaseStatsReasonV1, type DatabaseTargetV1 } from '@happier-dev/database-protocol';

export type DatabaseStatsSqlStatementV1 = Readonly<{ sql: string; parameters: readonly (string | number)[] }>;
export type DatabaseStatsDecodeContextV1 = Readonly<{
    target: DatabaseTargetV1; observedAtMs: number; database: string; intervalBasis: DatabaseStatsIntervalBasisV1;
}>;
export type DatabaseStatsNativeRowV1 = Readonly<Record<string, unknown>>;
export type DatabaseStatsSqlPlanV1 = Readonly<{
    status: 'compiled'; statements: readonly DatabaseStatsSqlStatementV1[];
    decode(resultSets: readonly (readonly DatabaseStatsNativeRowV1[])[], context: DatabaseStatsDecodeContextV1): DatabaseStatsObservationV1;
}> | Readonly<{ status: 'unavailable'; reason: DatabaseStatsReasonV1 }>;

/** Stats queries have unique aliases and integer casts; native adapters preserve text. */
export function statsText(row: DatabaseStatsNativeRowV1, key: string): string | undefined {
    const value = row[key];
    return value === null || value === undefined ? undefined : String(value);
}
export function statsCounter(row: DatabaseStatsNativeRowV1, key: string): string | undefined {
    const value = row[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) throw new Error('invalid_database_stats_counter');
    const text = String(value);
    if (!/^\d+$/u.test(text)) throw new Error('invalid_database_stats_counter');
    return text;
}
export function statsNumber(row: DatabaseStatsNativeRowV1, key: string): number | undefined {
    const value = row[key];
    if (value === undefined || value === null) return undefined;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) throw new Error('invalid_database_stats_duration');
    return number;
}
export function statsBoolean(row: DatabaseStatsNativeRowV1, key: string): boolean {
    return row[key] === true || row[key] === 't' || row[key] === 1 || row[key] === '1';
}
export function statsJsonArray(value: unknown): readonly unknown[] {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    if (parsed === null || parsed === undefined) return [];
    if (!Array.isArray(parsed)) throw new Error('invalid_database_stats_array');
    return parsed;
}
export function statsJsonObject(value: unknown): DatabaseStatsNativeRowV1 {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_database_stats_object');
    return parsed as Record<string, unknown>;
}
export function statsOptional(key: string, value: unknown): Record<string, unknown> {
    return value === undefined ? {} : { [key]: value };
}
export function statsScope(operation: DatabaseStatsReadV1, database: string) {
    return { database, ...('relation' in operation.selection && operation.selection.relation ? { relation: operation.selection.relation } : {}) };
}
/** No output text until the dialect's own diagnostic normalizer accepts it. */
export function statsShape(sql: string | undefined, normalize?: (sql: string) => Readonly<{ shape: string }>): Readonly<{ shape: string }> | Readonly<{ omittedTextReason: string }> {
    if (sql && normalize) {
        try { const result = normalize(sql); if (result.shape) return { shape: result.shape }; } catch { /* Unsupported syntax has no safe text. */ }
    }
    return { omittedTextReason: 'normalization_unavailable' };
}

export function statsSqlPlan(engineId: string, operation: DatabaseStatsReadV1, statement: DatabaseStatsSqlStatementV1,
    decode: (rows: readonly DatabaseStatsNativeRowV1[]) => unknown,
    reasons: readonly DatabaseStatsReasonV1[] = []): DatabaseStatsSqlPlanV1 {
    return { status: 'compiled', statements: [statement], decode(resultSets, context) {
        const rows = resultSets[0] ?? [];
        const first = rows[0] ?? {};
        const intervalBasis = { ...context.intervalBasis,
            ...statsOptional('engineStartedAt', statsText(first, 'engine_started_at')),
            ...statsOptional('statsResetAt', statsText(first, 'extension_stats_reset') ?? statsText(first, 'stats_reset')),
            ...statsOptional('extensionVersion', statsText(first, 'extension_version')),
            ...statsOptional('deallocated', statsCounter(first, 'deallocated')) };
        const visible = rows.filter(row => row.key !== null);
        const coverageReasons = [...reasons];
        if (rows.some(row => row.visibility_restricted === true || row.visibility_restricted === 't')) coverageReasons.push('visibility_restricted');
        if (rows.some(row => row.digest_overflow === true || row.digest_overflow === 1)) coverageReasons.push('digest_overflow');
        const selection = operation.selection;
        if (rows.some(row => row.instrumentation_enabled === false || row.instrumentation_enabled === 0 || row.instrumentation_enabled === '0')) {
            return { v: 1, status: 'unavailable', group: operation.group, engineId, observedAtMs: context.observedAtMs,
                scope: statsScope(operation, context.database), intervalBasis, reason: 'instrumentation_disabled' };
        }
        const demanded = 'page' in selection ? selection.page : undefined;
        const hasNext = demanded !== undefined && visible.length > demanded.rows;
        const retained = hasNext ? visible.slice(0, demanded.rows) : visible;
        const rowResetMarkers = Object.fromEntries(retained.flatMap(row => {
            const key = statsText(row, 'key'); const marker = statsText(row, 'stats_started_at');
            return key && marker ? [[key, marker]] : [];
        }));
        return DatabaseStatsObservationV1Schema.parse({ v: 1, status: 'available', engineId, group: operation.group,
            observedAtMs: context.observedAtMs, scope: statsScope(operation, context.database),
            intervalBasis: { ...intervalBasis, ...(Object.keys(rowResetMarkers).length ? { rowResetMarkers } : {}) },
            coverage: coverageReasons.length ? { status: 'partial', reasons: [...new Set(coverageReasons)] } : { status: 'complete' },
            completeness: hasNext && demanded ? { complete: false, reason: 'page', continuation: {
                kind: 'stats', input: { operation: 'stats.read', target: context.target, request: operation }, offset: (demanded.offset ?? 0) + demanded.rows,
            } } : { complete: true },
            data: decode(retained) });
    } };
}

export function statsRelation(row: DatabaseStatsNativeRowV1) {
    return { schema: statsText(row, 'schema_name'), name: statsText(row, 'relation_name') };
}
export function statsSize(row: DatabaseStatsNativeRowV1, measurement: 'database_bytes' | 'table_bytes_estimate' | 'page_allocation') {
    return { bytes: statsCounter(row, 'size_bytes'), measurement,
        ...statsOptional('relationBytes', statsCounter(row, 'relation_bytes')),
        ...statsOptional('tableBytes', statsCounter(row, 'table_bytes')),
        ...statsOptional('indexBytes', statsCounter(row, 'index_bytes')),
        ...statsOptional('freeBytes', statsCounter(row, 'free_bytes')) };
}
