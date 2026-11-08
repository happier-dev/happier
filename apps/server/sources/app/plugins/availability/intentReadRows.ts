import type { Tx } from '@/storage/inTx';
import { getActivePrismaRuntime, getDbProviderFromEnv } from '@/storage/prisma';

type IntentReadRow = Readonly<{
    availabilityCursor: number;
    pluginId: string | null;
    desiredVersion: string | null;
    enabled: boolean | number;
    offlineUiHosting: string;
    writableCollectionsText: string;
    releaseLessDeclarationText: string | null;
    revision: bigint;
}>;

/**
 * Capture the cursor and selected intents in one statement. Keep large JSON as
 * text until the read snapshot closes: decoding/projection must not extend its
 * transaction tenure. The release coordinate remains available for the same
 * snapshot's immutable-release/link read.
 */
export async function readIntentRows(tx: Tx, input: Readonly<{
    accountId: string;
    pluginId?: string;
    after?: string;
    take?: number;
}>): Promise<readonly IntentReadRow[]> {
    const prisma = getActivePrismaRuntime();
    const mysql = getDbProviderFromEnv(process.env, 'postgres') === 'mysql';
    const quote = mysql ? '`' : '"';
    const identifier = (name: string) => prisma.raw(`${quote}${name}${quote}`);
    const column = (alias: 'a' | 'i', name: string) => prisma.sql`${prisma.raw(alias)}.${identifier(name)}`;
    const text = (name: string) => prisma.sql`CAST(${column('i', name)} AS ${prisma.raw(mysql ? 'CHAR' : 'TEXT')})`;
    return tx.$queryRaw<IntentReadRow[]>(prisma.sql`
        SELECT ${column('a', 'seq')} AS ${identifier('availabilityCursor')},
            ${column('i', 'pluginId')} AS ${identifier('pluginId')},
            ${column('i', 'desiredVersion')} AS ${identifier('desiredVersion')},
            ${column('i', 'enabled')} AS ${identifier('enabled')},
            ${column('i', 'offlineUiHosting')} AS ${identifier('offlineUiHosting')},
            ${text('writableCollections')} AS ${identifier('writableCollectionsText')},
            CASE WHEN ${column('i', 'enabled')} AND ${column('i', 'desiredVersion')} IS NULL
                THEN ${text('releaseLessDeclaration')} ELSE NULL END AS ${identifier('releaseLessDeclarationText')},
            ${column('i', 'revision')} AS ${identifier('revision')}
        FROM ${identifier('Account')} a LEFT JOIN ${identifier('AccountPluginIntent')} i
            ON ${column('i', 'accountId')} = ${column('a', 'id')}
            ${input.pluginId === undefined ? prisma.empty : prisma.sql`AND ${column('i', 'pluginId')} = ${input.pluginId}`}
            ${input.after === undefined ? prisma.empty : prisma.sql`AND ${column('i', 'pluginId')} > ${input.after}`}
        WHERE ${column('a', 'id')} = ${input.accountId}
        ORDER BY ${column('i', 'pluginId')} ASC
        ${input.take === undefined ? prisma.empty : prisma.sql`LIMIT ${input.take}`}
    `);
}

/** Called only after the read snapshot returns its captured strings. */
export function decodeIntentReadRow(row: IntentReadRow) {
    return {
        pluginId: row.pluginId!,
        desiredVersion: row.desiredVersion,
        enabled: row.enabled === true || row.enabled === 1,
        offlineUiHosting: row.offlineUiHosting,
        writableCollections: JSON.parse(row.writableCollectionsText) as unknown,
        releaseLessDeclaration: row.releaseLessDeclarationText === null ? null : JSON.parse(row.releaseLessDeclarationText) as unknown,
        revision: row.revision,
    };
}
