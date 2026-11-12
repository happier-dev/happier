import { releaseLessDeclarationIdentitySql, selectedDeclarationBodySql } from './declarationReadRows';
import type { Tx } from '@/storage/inTx';
import { getActivePrismaRuntime, getDbProviderFromEnv } from '@/storage/prisma';
import type { ParsedPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest/v2';
import type { CurrentPluginDeclarationV1 } from './currentDeclaration';
import { readReleaseLessDeclarationListSummary } from './currentDeclaration';

type IntentReadRow = Readonly<{
    availabilityCursor: number;
    pluginId: string | null;
    desiredVersion: string | null;
    enabled: boolean | number;
    offlineUiHosting: string;
    writableCollectionsText: string;
    releaseLessDeclarationText: string | null;
    releaseLessDeclarationSummaryText?: string | null;
    revision: bigint | number;
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
    list?: boolean;
    omitDeclarations?: boolean;
}>): Promise<readonly IntentReadRow[]> {
    const prisma = getActivePrismaRuntime();
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    const mysql = provider === 'mysql';
    const summarize = provider === 'postgres' && input.list === true && !input.omitDeclarations;
    const quote = mysql ? '`' : '"';
    const identifier = (name: string) => prisma.raw(`${quote}${name}${quote}`);
    const column = (alias: 'a' | 'i', name: string) => prisma.sql`${prisma.raw(alias)}.${identifier(name)}`;
    const text = (name: string) => prisma.sql`CAST(${column('i', name)} AS ${prisma.raw(mysql ? 'CHAR' : 'TEXT')})`;
    const declarationSummary = summarize ? releaseLessDeclarationIdentitySql() : prisma.empty;
    return tx.$queryRaw<IntentReadRow[]>(prisma.sql`
        SELECT ${column('a', 'seq')} AS ${identifier('availabilityCursor')},
            ${column('i', 'pluginId')} AS ${identifier('pluginId')},
            ${column('i', 'desiredVersion')} AS ${identifier('desiredVersion')},
            ${column('i', 'enabled')} AS ${identifier('enabled')},
            ${column('i', 'offlineUiHosting')} AS ${identifier('offlineUiHosting')},
            ${text('writableCollections')} AS ${identifier('writableCollectionsText')},
            ${input.omitDeclarations || summarize ? prisma.sql`NULL`
                : prisma.sql`CASE WHEN ${column('i', 'enabled')} AND ${column('i', 'desiredVersion')} IS NULL
                    THEN ${text('releaseLessDeclaration')} ELSE NULL END`} AS ${identifier('releaseLessDeclarationText')},
            ${summarize ? prisma.sql`CASE WHEN i."enabled" AND i."desiredVersion" IS NULL
                THEN CAST((${declarationSummary}) AS TEXT) ELSE NULL END AS "releaseLessDeclarationSummaryText",` : prisma.empty}
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

type CapturedListDeclaration = Readonly<{
    machineDeclarations: ReturnType<typeof readReleaseLessDeclarationListSummary>['machineDeclarations'];
    currentDeclaration: Readonly<{ declarationDigestSha256: CurrentPluginDeclarationV1['declarationDigestSha256']; manifestText: string }> | null;
}>;

/** Resolve selected bodies as one set within the original cursor snapshot. */
export async function readIntentListDeclarations(tx: Tx, accountId: string, rows: readonly IntentReadRow[]): Promise<ReadonlyMap<string, CapturedListDeclaration>> {
    const summaries = rows.flatMap(row => row.pluginId !== null && row.releaseLessDeclarationSummaryText !== undefined
        && row.enabled && row.desiredVersion === null
        ? [{ pluginId: row.pluginId, summary: readReleaseLessDeclarationListSummary(
            row.releaseLessDeclarationSummaryText === null ? null : JSON.parse(row.releaseLessDeclarationSummaryText), row.pluginId) }]
        : []);
    const selected = summaries.flatMap(({ pluginId, summary }) => summary.currentDeclaration
        ? [{ pluginId, path: summary.currentDeclaration.manifestPath, digest: summary.currentDeclaration.manifestDigestSha256 }] : []);
    const prisma = getActivePrismaRuntime();
    const bodies = selected.length === 0 ? [] : await tx.$queryRaw<Readonly<{ pluginId: string; manifestText: string }>[]>(prisma.sql`
        SELECT i."pluginId", CAST(${selectedDeclarationBodySql(
            'i."releaseLessDeclaration" #> ARRAY(SELECT jsonb_array_elements_text(r.path))', 'r.digest')} AS TEXT) AS "manifestText"
        FROM jsonb_to_recordset(CAST(${JSON.stringify(selected)} AS jsonb)) AS r("pluginId" text, path jsonb, digest text)
        JOIN "AccountPluginIntent" i ON i."accountId" = ${accountId} AND i."pluginId" = r."pluginId"
    `);
    const manifests = new Map(bodies.map(row => [row.pluginId, row.manifestText]));
    return new Map<string, CapturedListDeclaration>(summaries.map(({ pluginId, summary }) => [pluginId, {
        machineDeclarations: summary.machineDeclarations,
        currentDeclaration: summary.currentDeclaration ? {
            declarationDigestSha256: summary.currentDeclaration.manifestDigestSha256,
            manifestText: manifests.get(pluginId)!,
        } : null,
    }]));
}

/** Decode only consumed bodies after releasing the database snapshot. */
export function decodeIntentListDeclaration(captured: CapturedListDeclaration): Readonly<{
    machineDeclarations: CapturedListDeclaration['machineDeclarations'];
    currentDeclaration: CurrentPluginDeclarationV1 | null;
}> {
    return { machineDeclarations: captured.machineDeclarations,
        currentDeclaration: captured.currentDeclaration ? {
            declarationDigestSha256: captured.currentDeclaration.declarationDigestSha256,
            // The same-snapshot body belongs to the identity selected by the domain owner.
            manifest: JSON.parse(captured.currentDeclaration.manifestText) as ParsedPluginManifestV2,
        } : null };
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
        revision: BigInt(row.revision),
    };
}
