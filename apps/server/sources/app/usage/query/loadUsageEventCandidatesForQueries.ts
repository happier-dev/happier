import type { UsageAnalyticsQueryRequest } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { Tx } from '@/storage/inTx';
import { prismaRuntime } from '@/storage/prisma';
import { TEAM_CREDENTIAL_ONLY_USAGE_SOURCES } from '../usageSourceClassifier';
import { usageEventSelect, type UsageQueryEvent } from './loadUsageEventsForQuery';

/**
 * Conservative storage candidates, not accounting admission. Session histories,
 * opaque native-key histories and unidentified native producers can contain a
 * demanded baseline/competitor. The committed replay owner still decides which
 * candidates actually share an accounting subject and contribute.
 */
export async function loadUsageEventCandidatesForQueries(tx: Tx, accountId: string,
    queries: readonly UsageAnalyticsQueryRequest[]): Promise<UsageQueryEvent[]> {
    const startMs = Math.min(...queries.map(query => query.dateRange!.startMs!));
    const endMs = Math.max(...queries.map(query => query.dateRange!.endMs ?? Infinity));
    const end = Number.isFinite(endMs)
        ? prismaRuntime.sql`AND "observedAt" < CAST(${new Date(endMs).toISOString()} AS timestamp)` : prismaRuntime.empty;
    const reportEnd = Number.isFinite(endMs)
        ? prismaRuntime.sql`AND "updatedAt" < CAST(${new Date(endMs).toISOString()} AS timestamp)` : prismaRuntime.empty;
    const columns = prismaRuntime.join(Object.keys(usageEventSelect).map(key => key === 'metadata'
        ? prismaRuntime.raw('e."metadata" #>> \'{}\' AS "metadata"') : prismaRuntime.raw(`e."${key}"`)));
    return await tx.$queryRaw<UsageQueryEvent[]>(prismaRuntime.sql`
        WITH history AS MATERIALIZED (
            SELECT "id", "sessionId", "agentId", "machineId", "observedAt",
                CASE WHEN jsonb_typeof("metadata") = 'object' THEN "metadata"
                    WHEN jsonb_typeof("metadata") = 'string'
                        AND pg_input_is_valid("metadata" #>> '{}', 'jsonb')
                    THEN CAST("metadata" #>> '{}' AS jsonb) END AS hints
            FROM "UsageEvent" WHERE "accountId" = ${accountId} ${end}
                AND "source" NOT IN (${prismaRuntime.join([...TEAM_CREDENTIAL_ONLY_USAGE_SOURCES])})
        ), demanded AS MATERIALIZED (
            SELECT * FROM history WHERE "observedAt" >= CAST(${new Date(startMs).toISOString()} AS timestamp)
        ), sessions AS (
            SELECT "sessionId" FROM demanded WHERE "sessionId" IS NOT NULL
            UNION SELECT "sessionId" FROM "UsageReport" WHERE "accountId" = ${accountId}
                AND "updatedAt" >= CAST(${new Date(startMs).toISOString()} AS timestamp) ${reportEnd}
        ), native_keys AS (
            SELECT DISTINCT hints #> '{accountingSubject,nativeSessionKey}' AS key FROM demanded
                WHERE hints #> '{accountingSubject,nativeSessionKey}' IS NOT NULL
        ), unidentified_producers AS (
            SELECT DISTINCT "machineId", "agentId" FROM demanded WHERE "sessionId" IS NULL
                AND jsonb_typeof(hints #> '{usageAccounting,nativeSessionId}') = 'string'
        ), candidates AS (
            SELECT "id" FROM demanded
            UNION SELECT "id" FROM history WHERE "sessionId" IN (SELECT "sessionId" FROM sessions)
            UNION SELECT "id" FROM history WHERE hints #> '{accountingSubject,nativeSessionKey}' IN (SELECT key FROM native_keys)
            UNION SELECT h."id" FROM history h JOIN unidentified_producers p
                ON h."machineId" IS NOT DISTINCT FROM p."machineId"
                AND h."agentId" IS NOT DISTINCT FROM p."agentId" WHERE h."sessionId" IS NULL
        )
        SELECT ${columns} FROM "UsageEvent" e WHERE e."accountId" = ${accountId}
            AND e."id" IN (SELECT "id" FROM candidates) ORDER BY e."observedAt" ASC`);
}
