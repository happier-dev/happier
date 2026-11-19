import { releaseLessDeclarationIdentitySql } from './declarationReadRows';
import type { Tx } from '@/storage/inTx';
import { getActivePrismaRuntime, getDbProviderFromEnv } from '@/storage/prisma';
import type { CurrentPluginDeclarationV1 } from './currentDeclaration';
import { readReleaseLessDeclarationListSummary } from './currentDeclaration';

type IntentReadRow = Readonly<{
    availabilityCursor: number;
    pluginId: string | null;
    desiredVersion: string | null;
    enabled: boolean | number;
    projectScopeText: string | null;
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
    /** Exactly these plugins' rows (an exact named read). */
    pluginIds?: readonly string[];
    after?: string;
    take?: number;
    /** Read declaration identities only (the body-free storage summary), never bodies. */
    list?: boolean;
    /** Also read the declarations a disabled intent holds (a writer claim rejoins them). */
    includeDisabled?: boolean;
    omitDeclarations?: boolean;
}>): Promise<readonly IntentReadRow[]> {
    const prisma = getActivePrismaRuntime();
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    const mysql = provider === 'mysql';
    const summarize = input.list === true && !input.omitDeclarations;
    const quote = mysql ? '`' : '"';
    const identifier = (name: string) => prisma.raw(`${quote}${name}${quote}`);
    const column = (alias: 'a' | 'i', name: string) => prisma.sql`${prisma.raw(alias)}.${identifier(name)}`;
    const text = (name: string) => prisma.sql`CAST(${column('i', name)} AS ${prisma.raw(mysql ? 'CHAR' : 'TEXT')})`;
    const declarationSummary = summarize ? releaseLessDeclarationIdentitySql() : prisma.empty;
    const holdsDeclaration = input.includeDisabled ? prisma.sql`${column('i', 'desiredVersion')} IS NULL`
        : prisma.sql`${column('i', 'enabled')} AND ${column('i', 'desiredVersion')} IS NULL`;
    return tx.$queryRaw<IntentReadRow[]>(prisma.sql`
        SELECT ${column('a', 'seq')} AS ${identifier('availabilityCursor')},
            ${column('i', 'pluginId')} AS ${identifier('pluginId')},
            ${column('i', 'desiredVersion')} AS ${identifier('desiredVersion')},
            ${column('i', 'enabled')} AS ${identifier('enabled')},
            ${text('projectScope')} AS ${identifier('projectScopeText')},
            ${column('i', 'offlineUiHosting')} AS ${identifier('offlineUiHosting')},
            ${text('writableCollections')} AS ${identifier('writableCollectionsText')},
            ${input.omitDeclarations || summarize ? prisma.sql`NULL`
                : prisma.sql`CASE WHEN ${holdsDeclaration}
                    THEN ${text('releaseLessDeclaration')} ELSE NULL END`} AS ${identifier('releaseLessDeclarationText')},
            ${summarize ? prisma.sql`CASE WHEN ${holdsDeclaration}
                THEN CAST((${declarationSummary}) AS ${prisma.raw(mysql ? 'CHAR' : 'TEXT')}) ELSE NULL END
                AS ${identifier('releaseLessDeclarationSummaryText')},` : prisma.empty}
            ${column('i', 'revision')} AS ${identifier('revision')}
        FROM ${identifier('Account')} a LEFT JOIN ${identifier('AccountPluginIntent')} i
            ON ${column('i', 'accountId')} = ${column('a', 'id')}
            ${input.pluginId === undefined ? prisma.empty : prisma.sql`AND ${column('i', 'pluginId')} = ${input.pluginId}`}
            ${input.pluginIds === undefined ? prisma.empty : prisma.sql`AND ${column('i', 'pluginId')} IN (${prisma.join([...input.pluginIds])})`}
            ${input.after === undefined ? prisma.empty : prisma.sql`AND ${column('i', 'pluginId')} > ${input.after}`}
        WHERE ${column('a', 'id')} = ${input.accountId}
        ORDER BY ${column('i', 'pluginId')} ASC
        ${input.take === undefined ? prisma.empty : prisma.sql`LIMIT ${input.take}`}
    `);
}

type CapturedListDeclaration = Readonly<{
    machineDeclarations: ReturnType<typeof readReleaseLessDeclarationListSummary>['machineDeclarations'];
    currentDeclaration: Readonly<{ declarationDigestSha256: CurrentPluginDeclarationV1['declarationDigestSha256'] }> | null;
}>;

/** Declaration identities from the body-free storage summary; no manifest body is read. */
export function readIntentListDeclarations(rows: readonly IntentReadRow[]): ReadonlyMap<string, CapturedListDeclaration> {
    return new Map<string, CapturedListDeclaration>(rows.flatMap(row => row.pluginId !== null && row.releaseLessDeclarationSummaryText !== undefined
        && row.enabled && row.desiredVersion === null
        ? [[row.pluginId, readReleaseLessDeclarationListSummary(
            row.releaseLessDeclarationSummaryText === null ? null : JSON.parse(row.releaseLessDeclarationSummaryText), row.pluginId)] as const]
        : []).map(([pluginId, summary]) => [pluginId, {
        machineDeclarations: summary.machineDeclarations,
        currentDeclaration: summary.currentDeclaration
            ? { declarationDigestSha256: summary.currentDeclaration.manifestDigestSha256 } : null,
    }]));
}

/** Called only after the read snapshot returns its captured strings. */
export function decodeIntentReadRow(row: IntentReadRow) {
    return {
        pluginId: row.pluginId!,
        desiredVersion: row.desiredVersion,
        enabled: row.enabled === true || row.enabled === 1,
        projectScope: row.projectScopeText === null ? null : JSON.parse(row.projectScopeText) as unknown,
        offlineUiHosting: row.offlineUiHosting,
        writableCollections: JSON.parse(row.writableCollectionsText) as unknown,
        releaseLessDeclaration: row.releaseLessDeclarationText === null ? null : JSON.parse(row.releaseLessDeclarationText) as unknown,
        revision: BigInt(row.revision),
    };
}
