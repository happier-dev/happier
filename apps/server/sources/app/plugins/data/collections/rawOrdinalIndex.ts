import type { Prisma } from "@prisma/client";
import { PLUGIN_COLLECTION_INDEX_SORT_KEY_MAX_BYTES_V1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { z } from "zod/mini";

import { resourceGrantSharedPageSqlPredicate } from '@/app/teams/resourceGrantAccess';
import type { Tx } from "@/storage/inTx";
import { getActivePrismaRuntime, getDbProviderFromEnv } from "@/storage/prisma";

export type PluginCollectionRawOrdinalIndexEntry = Readonly<{
    encodedSortKey: Uint8Array;
    rowId: string;
    rowRevision: number;
}>;

type RawOrdinalIndexReadClient = Pick<Tx, "$queryRaw">;

const PluginCollectionRawOrdinalIndexEntrySchema = z.strictObject({
    encodedSortKey: z.instanceof(Uint8Array).check(z.refine((value) => value.byteLength > 0 && value.byteLength <= PLUGIN_COLLECTION_INDEX_SORT_KEY_MAX_BYTES_V1)),
    rowId: z.string(),
    rowRevision: z.number().check(z.int()),
});

const PluginCollectionRawOrdinalIndexCountSchema = z.strictObject({
    rowCount: z.union([z.bigint(), z.number(), z.string()]),
});

function rawOrdinalIndexSql() {
    const prisma = getActivePrismaRuntime();
    const quote = getDbProviderFromEnv(process.env, "postgres") === "mysql" ? "`" : "\"";
    const identifier = (value: string) => (
        prisma.raw(`${quote}${value}${quote}`)
    );
    return {
        prisma,
        identifier,
        table: identifier("PluginCollectionIndexEntry"),
        indexStateId: identifier("indexStateId"),
        encodedSortKey: identifier("encodedSortKey"),
        rowId: identifier("rowId"),
        rowRevision: identifier("rowRevision"),
        rowCount: identifier("rowCount"),
    };
}

function rawOrdinalIndexConditions(input: Readonly<{
    prisma: ReturnType<typeof getActivePrismaRuntime>;
    encodedSortKey: Prisma.Sql;
    value: Readonly<{
        lower?: Uint8Array;
        upper?: Uint8Array;
        after?: Uint8Array;
    }>;
}>) {
    const conditions: Prisma.Sql[] = [];
    if (input.value.lower !== undefined) {
        conditions.push(input.prisma.sql`${input.encodedSortKey} >= ${input.value.lower}`);
    }
    if (input.value.upper !== undefined) {
        conditions.push(input.prisma.sql`${input.encodedSortKey} < ${input.value.upper}`);
    }
    if (input.value.after !== undefined) {
        conditions.push(input.prisma.sql`${input.encodedSortKey} > ${input.value.after}`);
    }
    return conditions;
}

/**
 * Prisma's Bytes filters intentionally do not expose ordinal range operators.
 * Both Collection pagination and quota admission use this one raw-byte range
 * owner inside their enclosing transaction.
 */
export async function readPluginCollectionIndexEntriesByRawOrdinalKey(input: Readonly<{
    tx: RawOrdinalIndexReadClient;
    indexStateId: string;
    bounds: Readonly<{ lower?: Uint8Array; upper?: Uint8Array; after?: Uint8Array }>;
    intervals?: readonly Readonly<{ lower?: Uint8Array; upper?: Uint8Array }>[];
    order: "asc" | "desc";
    take: number;
}>): Promise<readonly PluginCollectionRawOrdinalIndexEntry[] | null> {
    const sql = rawOrdinalIndexSql();
    const conditions = [
        sql.prisma.sql`${sql.indexStateId} = ${input.indexStateId}`,
        ...rawOrdinalIndexConditions({ prisma: sql.prisma, encodedSortKey: sql.encodedSortKey, value: input.bounds }),
    ];
    const direction = sql.prisma.raw(input.order === "asc" ? "ASC" : "DESC");
    const selection = rawOrdinalPrefixSetJoin(sql.prisma, sql.encodedSortKey, input.intervals);
    const rows = await input.tx.$queryRaw<unknown[]>(sql.prisma.sql`
        SELECT ${sql.encodedSortKey} AS ${sql.encodedSortKey}, ${sql.rowId} AS ${sql.rowId}, ${sql.rowRevision} AS ${sql.rowRevision}
        FROM ${sql.table}
        ${selection}
        WHERE ${sql.prisma.join(conditions, " AND ")}
        ORDER BY ${sql.encodedSortKey} ${direction}
        LIMIT ${input.take}
    `);
    const parsed = z.array(PluginCollectionRawOrdinalIndexEntrySchema).safeParse(rows);
    return parsed.success ? parsed.data : null;
}

function rawOrdinalPrefixSetJoin(
    prisma: ReturnType<typeof getActivePrismaRuntime>,
    encodedSortKey: Prisma.Sql,
    intervals: readonly Readonly<{ lower?: Uint8Array; upper?: Uint8Array }>[] | undefined,
): Prisma.Sql {
    // One parameter carries the entire interval set: bind count stays constant
    // below PostgreSQL's 32,767-parameter boundary, independently of demand.
    // Decode the parameter's bounds, never the indexed key, retaining native
    // binary range comparisons on all supported database providers.
    if (intervals === undefined) return prisma.empty;
    const encodedIntervals = JSON.stringify(intervals.map(interval => ({
        lo: interval.lower === undefined ? null : Buffer.from(interval.lower).toString("hex"),
        hi: interval.upper === undefined ? null : Buffer.from(interval.upper).toString("hex"),
    })));
    const provider = getDbProviderFromEnv(process.env, "postgres");
    const values = provider === "mysql"
        ? prisma.sql`(SELECT UNHEX(lo) AS lo, UNHEX(hi) AS hi FROM JSON_TABLE(${encodedIntervals}, '$[*]' COLUMNS (lo TEXT PATH '$.lo', hi TEXT PATH '$.hi')) AS decoded_prefixes)`
        : provider === "sqlite"
            ? prisma.sql`(SELECT unhex(json_extract(value, '$.lo')) AS lo, unhex(json_extract(value, '$.hi')) AS hi FROM json_each(${encodedIntervals}))`
            : prisma.sql`(SELECT decode(lo, 'hex') AS lo, decode(hi, 'hex') AS hi FROM jsonb_to_recordset(${encodedIntervals}::jsonb) AS decoded_prefixes(lo text, hi text))`;
    const lower = intervals.every(interval => interval.lower !== undefined)
        ? prisma.sql`${encodedSortKey} >= prefix_set.lo`
        : prisma.sql`(prefix_set.lo IS NULL OR ${encodedSortKey} >= prefix_set.lo)`;
    const upper = intervals.every(interval => interval.upper !== undefined)
        ? prisma.sql`${encodedSortKey} < prefix_set.hi`
        : prisma.sql`(prefix_set.hi IS NULL OR ${encodedSortKey} < prefix_set.hi)`;
    return prisma.sql`JOIN ${values} AS prefix_set ON ${lower} AND ${upper}`;
}

const SharedOrdinalIndexEntrySchema = z.extend(PluginCollectionRawOrdinalIndexEntrySchema, { id: z.string() });

/** Seek grant arms, then each resource's declared index entry. Only page positions leave SQL. */
export async function readSharedPluginCollectionIndexEntriesByRawOrdinalKey(input: Readonly<{
    tx: RawOrdinalIndexReadClient;
    actorAccountId: string;
    sharedWithTeamId?: string;
    pluginId: string;
    collectionId: string;
    indexId: string;
    bounds: Readonly<{ lower?: Uint8Array; upper?: Uint8Array }>;
    intervals?: readonly Readonly<{ lower?: Uint8Array; upper?: Uint8Array }>[];
    after?: Readonly<{ encodedSortKey: Uint8Array; id: string }>;
    order: "asc" | "desc";
    take: number;
}>): Promise<readonly z.infer<typeof SharedOrdinalIndexEntrySchema>[] | null> {
    const { prisma, identifier, table, ...index } = rawOrdinalIndexSql();
    const { sql } = prisma;
    const row = (column: string) => sql`a.${identifier(column)}`;
    const state = (column: string) => sql`s.${identifier(column)}`;
    const key = sql`e.${index.encodedSortKey}`;
    const id = row("id");
    const access = resourceGrantSharedPageSqlPredicate({
        actorAccountId: input.actorAccountId, sharedWithTeamId: input.sharedWithTeamId,
        resourceTablePrefix: "PluginCollection", resourceIdColumn: "rowDbId",
    });
    const conditions = [
        access,
        sql`${row("pluginId")} = ${input.pluginId}`,
        sql`${row("collectionId")} = ${input.collectionId}`,
        sql`${row("deletedAt")} IS NULL`,
        ...rawOrdinalIndexConditions({ prisma, encodedSortKey: key, value: input.bounds }),
    ];
    const direction = prisma.raw(input.order === "asc" ? "ASC" : "DESC");
    if (input.after) {
        const comparator = prisma.raw(input.order === "asc" ? ">" : "<");
        conditions.push(sql`(${key}, ${id}) ${comparator} (${input.after.encodedSortKey}, ${input.after.id})`);
    }
    const rows = await input.tx.$queryRaw<unknown[]>(sql`
        SELECT ${id} AS ${identifier("id")}, ${key} AS ${index.encodedSortKey},
            e.${index.rowId} AS ${index.rowId}, e.${index.rowRevision} AS ${index.rowRevision}
        FROM ${identifier("PluginCollectionRow")} a
        JOIN ${identifier("PluginCollectionIndexState")} s
            ON ${state("accountId")} = ${row("accountId")}
            AND ${state("pluginId")} = ${row("pluginId")}
            AND ${state("collectionId")} = ${row("collectionId")}
            AND ${state("indexId")} = ${input.indexId}
            AND ${state("contractDigest")} = ${row("contractDigest")}
            AND ${state("contractId")} = ${row("contractId")}
            AND ${state("buildState")} = 'ready' AND ${state("indexedThroughRevision")} IS NOT NULL
        JOIN ${table} e ON e.${index.indexStateId} = ${state("id")} AND e.${index.rowId} = ${row("rowId")}
        ${rawOrdinalPrefixSetJoin(prisma, key, input.intervals)}
        WHERE ${prisma.join(conditions, " AND ")}
        ORDER BY ${key} ${direction}, ${id} ${direction}
        LIMIT ${input.take}
    `);
    const parsed = z.array(SharedOrdinalIndexEntrySchema).safeParse(rows);
    return parsed.success ? parsed.data : null;
}

export async function countPluginCollectionIndexEntriesByRawOrdinalKey(input: Readonly<{
    tx: RawOrdinalIndexReadClient;
    indexStateId: string;
    bounds: Readonly<{ lower?: Uint8Array; upper?: Uint8Array }>;
}>): Promise<bigint | null> {
    const sql = rawOrdinalIndexSql();
    const conditions = [
        sql.prisma.sql`${sql.indexStateId} = ${input.indexStateId}`,
        ...rawOrdinalIndexConditions({ prisma: sql.prisma, encodedSortKey: sql.encodedSortKey, value: input.bounds }),
    ];
    const rows = await input.tx.$queryRaw<unknown[]>(sql.prisma.sql`
        SELECT COUNT(*) AS ${sql.rowCount}
        FROM ${sql.table}
        WHERE ${sql.prisma.join(conditions, " AND ")}
    `);
    const parsed = z.array(PluginCollectionRawOrdinalIndexCountSchema).check(z.length(1)).safeParse(rows);
    if (!parsed.success) return null;
    const value = parsed.data[0].rowCount;
    if (typeof value === "bigint") return value >= BigInt(0) ? value : null;
    if (typeof value === "number") {
        return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
    }
    if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
    return BigInt(value);
}
