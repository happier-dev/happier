import type { Prisma } from "@prisma/client";
import {
    PluginIdSchema,
    SESSION_SYSTEM_RECORD_VERSION_MAX,
} from "@happier-dev/protocol";

import { deriveSessionSystemRecordAddressKeys } from "./sessionSystemRecordAddressKeys";
import {
    getDbProviderFromEnv,
    prismaRuntime,
    type DbProvider,
} from "@/storage/prisma";

export const SESSION_SYSTEM_RECORD_BACKFILL_PAGE_MAX = 500;

type BackfillClient = Pick<Prisma.TransactionClient, "sessionSystemRecord" | "$queryRaw">;
type SessionSystemRecordAuditClient = Pick<Prisma.TransactionClient, "sessionSystemRecord">;

type ExpandedAddressRow = Readonly<{
    id: string;
    namespace: string;
    localId: string;
}>;

function quotedIdentifier(provider: DbProvider, identifier: string): Prisma.Sql {
    const quote = provider === "mysql" ? "`" : '"';
    return prismaRuntime.raw(`${quote}${identifier}${quote}`);
}

async function readExpandedAddressRows(params: Readonly<{
    db: BackfillClient;
    provider: DbProvider;
    afterId?: string;
    limit: number;
}>): Promise<readonly ExpandedAddressRow[]> {
    const table = quotedIdentifier(params.provider, "SessionSystemRecord");
    const id = quotedIdentifier(params.provider, "id");
    const namespace = quotedIdentifier(params.provider, "namespace");
    const localId = quotedIdentifier(params.provider, "localId");
    const ownerKind = quotedIdentifier(params.provider, "ownerKind");
    const namespaceAddressKey = quotedIdentifier(params.provider, "namespaceAddressKey");
    const recordAddressKey = quotedIdentifier(params.provider, "recordAddressKey");
    const after = params.afterId === undefined
        ? prismaRuntime.empty
        : prismaRuntime.sql`AND ${id} > ${params.afterId}`;
    return await params.db.$queryRaw<ExpandedAddressRow[]>(prismaRuntime.sql`
        SELECT ${id}, ${namespace}, ${localId}
        FROM ${table}
        WHERE (
            ${ownerKind} IS NULL
            OR ${namespaceAddressKey} IS NULL
            OR ${recordAddressKey} IS NULL
        )
        ${after}
        ORDER BY ${id} ASC
        LIMIT ${params.limit}
    `);
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
