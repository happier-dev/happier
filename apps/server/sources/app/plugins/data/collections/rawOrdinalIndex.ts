import type { Prisma } from "@prisma/client";
import { PLUGIN_COLLECTION_INDEX_SORT_KEY_MAX_BYTES_V1 } from "@happier-dev/protocol";
import { z } from "zod";

import type { Tx } from "@/storage/inTx";
import { getActivePrismaRuntime, getDbProviderFromEnv } from "@/storage/prisma";

export type PluginCollectionRawOrdinalIndexEntry = Readonly<{
    encodedSortKey: Uint8Array;
    rowId: string;
    rowRevision: number;
}>;

type RawOrdinalIndexReadClient = Pick<Tx, "$queryRaw">;

const PluginCollectionRawOrdinalIndexEntrySchema = z.object({
    encodedSortKey: z.instanceof(Uint8Array)
        .refine((value) => value.byteLength > 0 && value.byteLength <= PLUGIN_COLLECTION_INDEX_SORT_KEY_MAX_BYTES_V1),
    rowId: z.string(),
    rowRevision: z.number().int(),
}).strict();

const PluginCollectionRawOrdinalIndexCountSchema = z.object({
    rowCount: z.union([z.bigint(), z.number(), z.string()]),
}).strict();

function rawOrdinalIndexSql() {
    const prisma = getActivePrismaRuntime();
    const quote = getDbProviderFromEnv(process.env, "postgres") === "mysql" ? "`" : "\"";
    const identifier = (value: "PluginCollectionIndexEntry" | "indexStateId" | "encodedSortKey" | "rowId" | "rowRevision" | "rowCount") => (
        prisma.raw(`${quote}${value}${quote}`)
    );
    return {
        prisma,
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
    indexStateId: Prisma.Sql;
    encodedSortKey: Prisma.Sql;
    value: Readonly<{
        indexStateId: string;
        lower?: Uint8Array;
        upper?: Uint8Array;
        after?: Uint8Array;
    }>;
}>) {
    const conditions = [input.prisma.sql`${input.indexStateId} = ${input.value.indexStateId}`];
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
    order: "asc" | "desc";
    take: number;
}>): Promise<readonly PluginCollectionRawOrdinalIndexEntry[] | null> {
    const sql = rawOrdinalIndexSql();
    const conditions = rawOrdinalIndexConditions({
        prisma: sql.prisma,
        indexStateId: sql.indexStateId,
        encodedSortKey: sql.encodedSortKey,
        value: { indexStateId: input.indexStateId, ...input.bounds },
    });
    const direction = sql.prisma.raw(input.order === "asc" ? "ASC" : "DESC");
    const rows = await input.tx.$queryRaw<unknown[]>(sql.prisma.sql`
        SELECT ${sql.encodedSortKey} AS ${sql.encodedSortKey}, ${sql.rowId} AS ${sql.rowId}, ${sql.rowRevision} AS ${sql.rowRevision}
        FROM ${sql.table}
        WHERE ${sql.prisma.join(conditions, " AND ")}
        ORDER BY ${sql.encodedSortKey} ${direction}
        LIMIT ${input.take}
    `);
    const parsed = z.array(PluginCollectionRawOrdinalIndexEntrySchema).safeParse(rows);
    return parsed.success ? parsed.data : null;
}

export async function countPluginCollectionIndexEntriesByRawOrdinalKey(input: Readonly<{
    tx: RawOrdinalIndexReadClient;
    indexStateId: string;
    bounds: Readonly<{ lower?: Uint8Array; upper?: Uint8Array }>;
}>): Promise<bigint | null> {
    const sql = rawOrdinalIndexSql();
    const conditions = rawOrdinalIndexConditions({
        prisma: sql.prisma,
        indexStateId: sql.indexStateId,
        encodedSortKey: sql.encodedSortKey,
        value: { indexStateId: input.indexStateId, ...input.bounds },
    });
    const rows = await input.tx.$queryRaw<unknown[]>(sql.prisma.sql`
        SELECT COUNT(*) AS ${sql.rowCount}
        FROM ${sql.table}
        WHERE ${sql.prisma.join(conditions, " AND ")}
    `);
    const parsed = z.array(PluginCollectionRawOrdinalIndexCountSchema).length(1).safeParse(rows);
    if (!parsed.success) return null;
    const value = parsed.data[0].rowCount;
    if (typeof value === "bigint") return value >= BigInt(0) ? value : null;
    if (typeof value === "number") {
        return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
    }
    if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
    return BigInt(value);
}
