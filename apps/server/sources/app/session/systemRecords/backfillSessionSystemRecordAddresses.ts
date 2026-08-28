import type { Prisma } from "@prisma/client";
import {
    PluginIdSchema,
    SESSION_SYSTEM_RECORD_VERSION_MAX,
} from "@happier-dev/protocol";

import { deriveSessionSystemRecordAddressKeys } from "./sessionSystemRecordAddressKeys";
import {
    getDbProviderFromEnv,
    type DbProvider,
} from "@/storage/prisma";

export const SESSION_SYSTEM_RECORD_BACKFILL_PAGE_MAX = 500;

type BackfillClient = Pick<Prisma.TransactionClient, "sessionSystemRecord" | "$queryRawUnsafe">;
type SessionSystemRecordAuditClient = Pick<Prisma.TransactionClient, "sessionSystemRecord">;

type ExpandedAddressRow = Readonly<{
    id: string;
    namespace: string;
    localId: string;
}>;

async function readExpandedAddressRows(params: Readonly<{
    db: BackfillClient;
    provider: DbProvider;
    afterId?: string;
    limit: number;
}>): Promise<readonly ExpandedAddressRow[]> {
    const quote = params.provider === "mysql" ? "`" : '"';
    const bind = params.provider === "postgres" || params.provider === "pglite"
        ? (index: number) => `$${index}`
        : () => "?";
    const afterClause = params.afterId === undefined
        ? ""
        : `AND ${quote}id${quote} > ${bind(1)}`;
    const values = params.afterId === undefined
        ? [params.limit]
        : [params.afterId, params.limit];
    const limitPlaceholder = bind(values.length);
    const query = `
        SELECT ${quote}id${quote}, ${quote}namespace${quote}, ${quote}localId${quote}
        FROM ${quote}SessionSystemRecord${quote}
        WHERE (
            ${quote}ownerKind${quote} IS NULL
            OR ${quote}namespaceAddressKey${quote} IS NULL
            OR ${quote}recordAddressKey${quote} IS NULL
        )
        ${afterClause}
        ORDER BY ${quote}id${quote} ASC
        LIMIT ${limitPlaceholder}
    `;
    return await params.db.$queryRawUnsafe<ExpandedAddressRow[]>(query, ...values);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    if (left.byteLength !== right.byteLength) return false;
    return left.every((value, index) => value === right[index]);
}

export async function backfillSessionSystemRecordAddressesPage(params: Readonly<{
    db: BackfillClient;
    provider?: DbProvider;
    afterId?: string;
    limit?: number;
}>): Promise<Readonly<{ processed: number; updated: number; nextAfterId: string | null }>> {
    const limit = Math.max(1, Math.min(SESSION_SYSTEM_RECORD_BACKFILL_PAGE_MAX, Math.floor(params.limit ?? 100)));
    const rows = await readExpandedAddressRows({
        db: params.db,
        provider: params.provider ?? getDbProviderFromEnv(process.env, "postgres"),
        ...(params.afterId === undefined ? {} : { afterId: params.afterId }),
        limit,
    });

    let updated = 0;
    for (const row of rows) {
        const keys = deriveSessionSystemRecordAddressKeys({
            ownerKind: "host",
            pluginId: null,
            namespace: row.namespace,
            localId: row.localId,
        });
        const result = await params.db.sessionSystemRecord.updateMany({
            where: { id: row.id },
            data: {
                ownerKind: "host",
                pluginId: null,
                namespaceAddressKey: keys.namespaceAddressKey,
                recordAddressKey: keys.recordAddressKey,
                version: 1,
            },
        });
        updated += result.count;
    }

    return {
        processed: rows.length,
        updated,
        nextAfterId: rows.length === limit ? rows.at(-1)?.id ?? null : null,
    };
}

export async function auditSessionSystemRecordAddressesPage(params: Readonly<{
    db: SessionSystemRecordAuditClient;
    afterId?: string;
    limit?: number;
}>): Promise<Readonly<{
    processed: number;
    nullRows: number;
    mismatchedRows: number;
    nextAfterId: string | null;
}>> {
    const limit = Math.max(1, Math.min(SESSION_SYSTEM_RECORD_BACKFILL_PAGE_MAX, Math.floor(params.limit ?? 100)));
    const rows = await params.db.sessionSystemRecord.findMany({
        where: params.afterId ? { id: { gt: params.afterId } } : undefined,
        orderBy: { id: "asc" },
        take: limit,
        select: {
            id: true,
            ownerKind: true,
            pluginId: true,
            namespace: true,
            localId: true,
            namespaceAddressKey: true,
            recordAddressKey: true,
            version: true,
        },
    });

    let nullRows = 0;
    let mismatchedRows = 0;
    for (const row of rows) {
        if (
            row.ownerKind === null
            || row.namespaceAddressKey === null
            || row.recordAddressKey === null
        ) {
            nullRows += 1;
            continue;
        }
        if (row.ownerKind !== "host" && row.ownerKind !== "plugin") {
            mismatchedRows += 1;
            continue;
        }
        const parsedPluginId = row.ownerKind === "plugin"
            ? PluginIdSchema.safeParse(row.pluginId)
            : null;
        if (
            (row.ownerKind === "host" && row.pluginId !== null)
            || (
                row.ownerKind === "plugin"
                && (!parsedPluginId?.success || parsedPluginId.data !== row.pluginId)
            )
            || !Number.isInteger(row.version)
            || row.version < 1
            || row.version > SESSION_SYSTEM_RECORD_VERSION_MAX
        ) {
            mismatchedRows += 1;
            continue;
        }
        const expected = deriveSessionSystemRecordAddressKeys({
            ownerKind: row.ownerKind,
            pluginId: row.pluginId,
            namespace: row.namespace,
            localId: row.localId,
        });
        if (
            !bytesEqual(row.namespaceAddressKey, expected.namespaceAddressKey)
            || !bytesEqual(row.recordAddressKey, expected.recordAddressKey)
        ) {
            mismatchedRows += 1;
        }
    }

    return {
        processed: rows.length,
        nullRows,
        mismatchedRows,
        nextAfterId: rows.length === limit ? rows.at(-1)?.id ?? null : null,
    };
}
