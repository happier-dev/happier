import type { UsageAnalyticsQueryRequest } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { Tx } from '@/storage/inTx';
import { prismaRuntime } from '@/storage/prisma';
import { TEAM_CREDENTIAL_ONLY_USAGE_SOURCES } from '../usageSourceClassifier';
import { usageEventEvidenceSelect, usageEventSelect, usageReportSelect, type UsageQueryEvent } from './loadUsageEventsForQuery';
import type { ScopedUsageEvidenceDbRow } from './scopedUsageEventRow';
import { legacyUsageReportAgentId, legacyUsageReportCanonicalOrder } from '../legacyUsageReportSchema';

export type CapturedUsageAccountingRow = ({ captureKind: 'body' } & UsageQueryEvent)
    | ({ captureKind: 'evidence' } & ScopedUsageEvidenceDbRow)
    | { captureKind: 'report'; id: string; sessionId: string | null; createdAt: Date;
        reportKey: string; reportData: unknown; reportUpdatedAt: Date };

type PackedUsageAccountingRow = { payload: string; observedAt: Date | null;
    createdAt: Date; reportUpdatedAt: Date | null };

const payloadKeys = ['captureKind', ...Object.keys(usageEventSelect)
    .filter(key => key !== 'observedAt' && key !== 'createdAt'), 'reportKey', 'reportData'];

/**
 * One statement owns the coherent mutable event/report view. SQL only selects
 * conservative body candidates; canonical metadata admission and replay happen
 * after capture. Native timestamps remain native columns, not JSON strings.
 */
export async function readPackedUsageAccountingRows(tx: Tx, accountId: string,
    queries: readonly UsageAnalyticsQueryRequest[]): Promise<PackedUsageAccountingRow[]> {
    const endMs = queries.reduce((latest, query) => Math.max(latest, query.dateRange?.endMs ?? Infinity), -Infinity);
    const end = Number.isFinite(endMs)
        ? prismaRuntime.sql`AND "observedAt" < CAST(${new Date(endMs).toISOString()} AS timestamp)` : prismaRuntime.empty;
    const reportEnd = Number.isFinite(endMs)
        ? prismaRuntime.sql`AND "updatedAt" < CAST(${new Date(endMs).toISOString()} AS timestamp)` : prismaRuntime.empty;
    const windows = prismaRuntime.join(queries.map(query => {
        const start = query.dateRange?.startMs === undefined ? prismaRuntime.sql`TRUE`
            : prismaRuntime.sql`"observedAt" >= CAST(${new Date(query.dateRange.startMs).toISOString()} AS timestamp)`;
        return query.dateRange?.endMs === undefined ? prismaRuntime.sql`(${start})`
            : prismaRuntime.sql`(${start} AND "observedAt" < CAST(${new Date(query.dateRange.endMs).toISOString()} AS timestamp))`;
    }), ' OR ');
    const reportWindows = prismaRuntime.join(queries.map(query => {
        const start = query.dateRange?.startMs === undefined ? prismaRuntime.sql`TRUE`
            : prismaRuntime.sql`"updatedAt" >= CAST(${new Date(query.dateRange.startMs).toISOString()} AS timestamp)`;
        return query.dateRange?.endMs === undefined ? prismaRuntime.sql`(${start})`
            : prismaRuntime.sql`(${start} AND "updatedAt" < CAST(${new Date(query.dateRange.endMs).toISOString()} AS timestamp))`;
    }), ' OR ');
    const sources = prismaRuntime.join([...TEAM_CREDENTIAL_ONLY_USAGE_SOURCES]);
    const hints = prismaRuntime.sql`CASE WHEN jsonb_typeof("metadata") = 'object' THEN "metadata"
        WHEN jsonb_typeof("metadata") = 'string' AND pg_input_is_valid("metadata" #>> '{}', 'jsonb')
        THEN CAST("metadata" #>> '{}' AS jsonb) END`;
    // Materialize only join keys. Retaining complete metadata here makes each
    // historical join sort and spill that content again before the final read.
    const identities = prismaRuntime.sql`"id", "sessionId", "agentId", "machineId", "source", "observedAt",
        (${hints}) #>> '{accountingSubject,sourceRootKey}' AS root,
        (${hints}) #>> '{accountingSubject,nativeSessionKey}' AS native,
        COALESCE('key:' || ((${hints}) #>> '{usageAccounting,nativeSessionKey}'),
            'id:' || regexp_replace((${hints}) #>> '{usageAccounting,nativeSessionId}', '[^a-zA-Z0-9]', '', 'g')) AS producer`;
    const allHistory = queries.some(query => query.dateRange?.startMs === undefined);
    // Window and history scans share account, end and source predicates. With
    // non-null observedAt, the time complement excludes the same unique rows
    // without joining and materializing the captured identities again.
    const candidates = allHistory ? prismaRuntime.empty : prismaRuntime.sql`, window_rows AS MATERIALIZED (
        SELECT ${identities}
        FROM "UsageEvent" WHERE "accountId" = ${accountId} ${end}
            AND "source" NOT IN (${sources}) AND (${windows})
    ), history AS MATERIALIZED (
        SELECT ${identities}
        FROM "UsageEvent" WHERE "accountId" = ${accountId} ${end}
            AND "source" NOT IN (${sources})
            AND NOT (${windows})
    ), sessions AS (
        SELECT DISTINCT "sessionId", "agentId" FROM window_rows WHERE "sessionId" IS NOT NULL
        UNION SELECT "sessionId", ${legacyUsageReportAgentId}::text AS "agentId" FROM retained_reports
            WHERE "sessionId" IS NOT NULL AND (${reportWindows})
    ), legacy_sessions AS (
        SELECT "sessionId", MAX(cutoff) AS cutoff FROM (
            SELECT "sessionId", "observedAt" AS cutoff FROM window_rows
            WHERE "sessionId" IS NOT NULL AND "source" = 'legacy_usage_report'
            UNION ALL SELECT "sessionId", "updatedAt" AS cutoff FROM retained_reports
            WHERE "sessionId" IS NOT NULL AND (${reportWindows})
        ) legacy_boundaries GROUP BY "sessionId"
    ), native_subjects AS (
        SELECT DISTINCT root, native FROM window_rows
    ), producers AS (
        SELECT DISTINCT "machineId", "agentId", producer FROM window_rows
    ), candidates AS (
        SELECT "id" FROM window_rows
        UNION SELECT h."id" FROM history h JOIN sessions s ON h."sessionId" = s."sessionId"
            AND h."agentId" IS NOT DISTINCT FROM s."agentId"
        UNION SELECT h."id" FROM history h JOIN legacy_sessions l
            ON h."sessionId" = l."sessionId" AND h."observedAt" <= l.cutoff
        UNION SELECT h."id" FROM history h JOIN native_subjects n
            ON h.root = n.root AND h.native = n.native
        UNION SELECT h."id" FROM history h JOIN producers p
            ON h."machineId" IS NOT DISTINCT FROM p."machineId" AND h."agentId" IS NOT DISTINCT FROM p."agentId"
            AND h.producer = p.producer
    )`;
    const selected = allHistory ? prismaRuntime.sql`TRUE` : prismaRuntime.sql`c."id" IS NOT NULL`;
    const evidenceKeys = new Set(Object.keys(usageEventEvidenceSelect));
    const columns = prismaRuntime.join(Object.keys(usageEventSelect).map(key => {
        if (key === 'metadata') return prismaRuntime.raw('e."metadata" #>> \'{}\' AS "metadata"');
        return evidenceKeys.has(key) ? prismaRuntime.raw(`e."${key}"`)
            : prismaRuntime.sql`CASE WHEN ${selected} THEN ${prismaRuntime.raw(`e."${key}"`)} END AS ${prismaRuntime.raw(`"${key}"`)}`;
    }));
    const reportColumns = prismaRuntime.join(Object.keys(usageEventSelect).map(key =>
        Object.hasOwn(usageReportSelect, key) ? prismaRuntime.raw(`r."${key}"`)
            : key === 'metadata' ? prismaRuntime.sql`NULL::text` : prismaRuntime.sql`NULL`));
    const reportSelect = prismaRuntime.join(Object.keys(usageReportSelect).map(key => prismaRuntime.raw(`"${key}"`)));
    const reportOrder = prismaRuntime.join(legacyUsageReportCanonicalOrder.flatMap(order => Object.entries(order)
        .map(([key, direction]) => prismaRuntime.raw(`r."${key}" ${direction}`))));
    const capture = prismaRuntime.sql`
        WITH retained_reports AS MATERIALIZED (
            SELECT ${reportSelect}
            FROM "UsageReport" WHERE "accountId" = ${accountId} ${reportEnd}
        ) ${candidates}
        SELECT CASE WHEN ${selected} THEN 'body' ELSE 'evidence' END AS "captureKind", ${columns},
            NULL::text AS "reportKey", NULL::jsonb AS "reportData", NULL::timestamp AS "reportUpdatedAt"
        FROM "UsageEvent" e ${allHistory ? prismaRuntime.empty : prismaRuntime.sql`LEFT JOIN candidates c ON c."id" = e."id"`}
        WHERE e."accountId" = ${accountId} ${end} AND e."source" NOT IN (${sources})
        UNION ALL (SELECT 'report' AS "captureKind", ${reportColumns},
            r."key" AS "reportKey", r."data" AS "reportData", r."updatedAt" AS "reportUpdatedAt"
        FROM retained_reports r ORDER BY ${reportOrder})`;
    // Prisma materializes a native result cell for every selected column. Keep
    // accounting values in one text cell, with field order derived from the
    // select owner, while dates retain the database driver's native decoding.
    return tx.$queryRaw<PackedUsageAccountingRow[]>(prismaRuntime.sql`
        SELECT jsonb_build_array(${prismaRuntime.join(payloadKeys.map(key => prismaRuntime.raw(`c."${key}"`)))})::text AS payload,
            c."observedAt", c."createdAt", c."reportUpdatedAt"
        FROM (${capture}) c`);
}

function createPackedUsageAccountingRowDecoder() {
    const entries: Array<[string, unknown]> = payloadKeys.map(key => [key, undefined]);
    return (row: PackedUsageAccountingRow) => {
        const values: unknown[] = JSON.parse(row.payload);
        for (let index = 0; index < entries.length; index++) entries[index]![1] = values[index];
        // The statement above owns the shape; fromEntries retains shared object
        // shapes rather than dictionary storage from many dynamic assignments.
        const captured = Object.fromEntries<unknown>(entries);
        captured.observedAt = row.observedAt;
        captured.createdAt = row.createdAt;
        captured.reportUpdatedAt = row.reportUpdatedAt;
        return captured as unknown as CapturedUsageAccountingRow;
    };
}

/** Composing callers still own the enclosing transaction. */
export async function loadUsageAccountingRowsForQuery(tx: Tx, accountId: string,
    queries: readonly UsageAnalyticsQueryRequest[]): Promise<CapturedUsageAccountingRow[]> {
    return (await readPackedUsageAccountingRows(tx, accountId, queries)).map(createPackedUsageAccountingRowDecoder());
}

export function* decodePackedUsageAccountingRows(rows: readonly PackedUsageAccountingRow[], sliceMs: number):
    Generator<void, CapturedUsageAccountingRow[], void> {
    const decode = createPackedUsageAccountingRowDecoder();
    const captured: CapturedUsageAccountingRow[] = [];
    let startedAt = performance.now();
    for (const row of rows) {
        captured.push(decode(row));
        if (performance.now() - startedAt >= sliceMs) {
            yield;
            startedAt = performance.now();
        }
    }
    return captured;
}
