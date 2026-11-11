import type { UsageAnalyticsQueryRequest } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { Tx } from '@/storage/inTx';
import { prismaRuntime } from '@/storage/prisma';
import { TEAM_CREDENTIAL_ONLY_USAGE_SOURCES } from '../usageSourceClassifier';
import { usageEventSelect, type UsageQueryEvent } from './loadUsageEventsForQuery';
import { usageAccountingSubjectIdentity } from './resolveScopedUsageContributions';
import type { ScopedUsageEvidenceRow } from './scopedUsageEventRow';
import type { UsageAnalyticsSnapshot } from '../usageQueryService';
import { normalizeUsageAnalyticsEvidenceRows } from './projectUsageAnalyticsPopulation';

/** Canonical admission touches only demanded rows; SQL conservatively captures their histories. */
export async function loadUsageEventCandidatesForQuery(tx: Tx, accountId: string,
    queries: readonly UsageAnalyticsQueryRequest[], windowRows: readonly ScopedUsageEvidenceRow[],
    legacyReports: UsageAnalyticsSnapshot['legacyReports']): Promise<UsageQueryEvent[]> {
    const endMs = queries.reduce((end, query) => Math.max(end, query.dateRange?.endMs ?? Infinity), -Infinity);
    const end = Number.isFinite(endMs)
        ? prismaRuntime.sql`AND "observedAt" < CAST(${new Date(endMs).toISOString()} AS timestamp)` : prismaRuntime.empty;
    const nativeSubjects = new Map<string, { sourceRootKey: string; nativeSessionKey: string }>();
    const sessions = new Map<string, { sessionId: string; agentId: string | null }>();
    const producers = new Map<string, { machineId: string | null; agentId: string | null; nativeKey: string }>();
    // Each request has its own latest retained report; a later invalid report
    // must not hide the valid older report selected by a comparison window.
    const demandedReports = queries.flatMap(query => normalizeUsageAnalyticsEvidenceRows([], legacyReports.filter(report =>
        report.updatedAt.getTime() >= query.dateRange!.startMs!
        && (query.dateRange?.endMs === undefined || report.updatedAt.getTime() < query.dateRange.endMs))));
    for (const row of [...windowRows, ...demandedReports]) {
        const identity = usageAccountingSubjectIdentity(row);
        if (identity[0] === 'session') sessions.set(JSON.stringify(identity), { sessionId: identity[1], agentId: identity[2] });
        else if (identity[0] === 'native' && identity.length === 6) nativeSubjects.set(JSON.stringify(identity), {
            sourceRootKey: identity[4], nativeSessionKey: identity[5],
        });
        else if (identity[0] === 'native') producers.set(JSON.stringify(identity), {
            machineId: identity[1], agentId: identity[2],
            // A coarse storage fingerprint, deliberately not another trim/admission rule.
            // Canonically equal trimmed ids always retain the same ASCII alphanumerics.
            nativeKey: identity[3].replace(/[^a-zA-Z0-9]/g, ''),
        });
    }
    // The captured evidence owns metadata admission for every hydrated body.
    const columns = prismaRuntime.join(Object.keys(usageEventSelect).filter(key => key !== 'metadata')
        .map(key => prismaRuntime.raw(`e."${key}"`)));
    // Captured window rows already own their identities. Only rows outside those
    // windows need historical metadata materialization and the subject joins below.
    const windowIds = windowRows.map(row => row.id);
    return await tx.$queryRaw<UsageQueryEvent[]>(prismaRuntime.sql`
        WITH window_ids AS (
            SELECT unnest(CAST(${windowIds} AS text[])) AS "id"
        ), history AS MATERIALIZED (
            SELECT "id", "sessionId", "agentId", "machineId",
                CASE WHEN jsonb_typeof("metadata") = 'object' THEN "metadata"
                    WHEN jsonb_typeof("metadata") = 'string' AND pg_input_is_valid("metadata" #>> '{}', 'jsonb')
                    THEN CAST("metadata" #>> '{}' AS jsonb) END AS hints
            FROM "UsageEvent" WHERE "accountId" = ${accountId} ${end}
                AND "source" NOT IN (${prismaRuntime.join([...TEAM_CREDENTIAL_ONLY_USAGE_SOURCES])})
                AND NOT EXISTS (SELECT 1 FROM window_ids windowed WHERE windowed."id" = "UsageEvent"."id")
        ), sessions AS (
            SELECT * FROM jsonb_to_recordset(CAST(${JSON.stringify([...sessions.values()])} AS jsonb))
                AS s("sessionId" text, "agentId" text)
        ), native_subjects AS (
            SELECT * FROM jsonb_to_recordset(CAST(${JSON.stringify([...nativeSubjects.values()])} AS jsonb))
                AS n("sourceRootKey" text, "nativeSessionKey" text)
        ), producers AS (
            SELECT * FROM jsonb_to_recordset(CAST(${JSON.stringify([...producers.values()])} AS jsonb))
                AS p("machineId" text, "agentId" text, "nativeKey" text)
        ), candidates AS (
            SELECT "id" FROM window_ids
            UNION SELECT h."id" FROM history h JOIN sessions s ON h."sessionId" = s."sessionId"
                AND h."agentId" IS NOT DISTINCT FROM s."agentId"
            UNION SELECT h."id" FROM history h JOIN native_subjects n
                ON h.hints #>> '{accountingSubject,sourceRootKey}' = n."sourceRootKey"
                AND h.hints #>> '{accountingSubject,nativeSessionKey}' = n."nativeSessionKey"
            UNION SELECT h."id" FROM history h JOIN producers p
                ON h."machineId" IS NOT DISTINCT FROM p."machineId" AND h."agentId" IS NOT DISTINCT FROM p."agentId"
                AND regexp_replace(h.hints #>> '{usageAccounting,nativeSessionId}', '[^a-zA-Z0-9]', '', 'g') = p."nativeKey"
                WHERE h."sessionId" IS NULL
        )
        SELECT ${columns} FROM "UsageEvent" e WHERE e."accountId" = ${accountId}
            AND e."id" IN (SELECT "id" FROM candidates) ORDER BY e."observedAt" ASC`);
}
