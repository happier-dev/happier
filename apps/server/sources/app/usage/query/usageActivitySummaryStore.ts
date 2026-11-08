import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { brotliCompress, brotliDecompress, constants as zlibConstants } from 'node:zlib';
import * as privacyKit from 'privacy-kit';
import { resolveDbSqlDialect } from '@/config/databaseProvider';
import { inTx, type Tx } from '@/storage/inTx';
import { getDbProviderFromEnv, isPrismaErrorCode, prismaRuntime } from '@/storage/prisma';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { TEAM_CREDENTIAL_ONLY_USAGE_SOURCES } from '../usageSourceClassifier';
import { usageEventSelect, usageReportSelect } from './loadUsageEventsForQuery';

export interface UsageActivitySourceChange {
    kind: 'event' | 'report';
    dayStartMs: number;
    fingerprint: string | null;
}

export const USAGE_ACTIVITY_SUMMARY_VERSION = 5;

const compressChunk = promisify(brotliCompress);
const decompressChunk = promisify(brotliDecompress);

const summaryKind = `actSummary${USAGE_ACTIVITY_SUMMARY_VERSION}`;
const chunkKind = `actChunk${USAGE_ACTIVITY_SUMMARY_VERSION}`;
const sourceKinds = { event: `actEvent${USAGE_ACTIVITY_SUMMARY_VERSION}`,
    report: `actReport${USAGE_ACTIVITY_SUMMARY_VERSION}` } as const;

function recordKey(accountId: string, kind: string, item: number | string = 0): string {
    return createHash('sha256').update(JSON.stringify([`usage-activity-summary-v${USAGE_ACTIVITY_SUMMARY_VERSION}`,
        accountId, kind, item])).digest('hex');
}

function sqlDialect() {
    return resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres'));
}

function quoted(name: string): string {
    return sqlDialect() === 'mysql' ? '`' + name + '`' : '"' + name + '"';
}

/** Warm readers receive the compact projection without decoding retained chunks. */
export async function readUsageActivitySummaryHead(tx: Tx, accountId: string): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ value: string | null }>>(prismaRuntime.sql`
        SELECT ${prismaRuntime.raw(quoted('payload'))} AS ${prismaRuntime.raw(quoted('value'))}
        FROM ${prismaRuntime.raw(quoted('UsageAccountingProjection'))}
        WHERE ${prismaRuntime.raw(quoted('recordKey'))} = ${recordKey(accountId, summaryKind)}
            AND ${prismaRuntime.raw(quoted('accountId'))} = ${accountId}`);
    return rows[0]?.value ?? null;
}

/** Only requested read-owned chunks cross the database and codec boundaries. */
export async function readUsageActivitySummaryChunks(tx: Tx, accountId: string,
    keys: readonly string[]): Promise<Map<string, string>> {
    const requested = new Map(keys.map(key => [recordKey(accountId, chunkKind, key), key]));
    const result = new Map<string, string>();
    for (const chunk of portableQueryChunks({ values: [...requested.keys()], bindingsPerValue: 1, fixedBindings: 1 })) {
        const rows = await tx.usageAccountingProjection.findMany({
            where: { accountId, recordKey: { in: [...chunk] } },
            select: { recordKey: true, payload: true },
        });
        const decoded = await Promise.all(rows.map(async row => [requested.get(row.recordKey)!,
            (await decompressChunk(privacyKit.decodeBase64(row.payload))).toString('utf8')] as const));
        for (const [key, payload] of decoded) result.set(key, payload);
    }
    return result;
}

function sourceReadSql(accountId: string, kind: UsageActivitySourceChange['kind'], endMs?: number) {
    const dialect = sqlDialect();
    const fields = Object.keys(kind === 'event' ? usageEventSelect : usageReportSelect).map(quoted).join(', ');
    const timestamp = quoted(kind === 'event' ? 'observedAt' : 'updatedAt');
    const day = dialect === 'postgres' ? `CAST(EXTRACT(EPOCH FROM DATE_TRUNC('day', ${timestamp})) * 1000 AS bigint)`
        : dialect === 'mysql' ? `CAST(DATEDIFF(${timestamp}, '1970-01-01') * 86400000 AS SIGNED)`
            : `(${timestamp} - ((${timestamp} % 86400000 + 86400000) % 86400000))`;
    // Every consumed field participates, including metadata and nullable Session attribution.
    // PostgreSQL/MySQL retain the explicitly accepted row-hash collision residual.
    // SQLite has no hash function in its native Prisma connection: its exact ordered
    // serialization stays in SQL, and only changed days cross the process boundary.
    const fingerprint = dialect === 'postgres'
        ? `COUNT(*)::text || ':' || SUM(hash_record_extended(ROW(${fields}), 0)::numeric)::text`
        : dialect === 'mysql'
            ? `CONCAT(COUNT(*), ':', HEX(BIT_XOR(UNHEX(SHA2(JSON_ARRAY(${fields}), 256)))))`
            : `json_group_array(json_array(${fields}) ORDER BY ${quoted('id')})`;
    const beforeEnd = endMs === undefined ? prismaRuntime.empty : dialect === 'postgres'
        ? prismaRuntime.sql`AND ${prismaRuntime.raw(timestamp)} < CAST(${new Date(endMs).toISOString()} AS timestamp)`
        : dialect === 'mysql' ? prismaRuntime.sql`AND ${prismaRuntime.raw(timestamp)} < CAST(${new Date(endMs).toISOString().replace('T', ' ').replace('Z', '')} AS DATETIME(3))`
            : prismaRuntime.sql`AND ${prismaRuntime.raw(timestamp)} < ${endMs}`;
    const source = kind === 'event' ? prismaRuntime.sql`AND ${prismaRuntime.raw(quoted('source'))}
        NOT IN (${prismaRuntime.join([...TEAM_CREDENTIAL_ONLY_USAGE_SOURCES])})` : prismaRuntime.empty;
    return prismaRuntime.sql`SELECT ${kind} AS ${prismaRuntime.raw(quoted('kind'))},
        ${prismaRuntime.raw(day)} AS ${prismaRuntime.raw(quoted('dayStartMs'))},
        ${prismaRuntime.raw(fingerprint)} AS ${prismaRuntime.raw(quoted('fingerprint'))}
        FROM ${prismaRuntime.raw(quoted(kind === 'event' ? 'UsageEvent' : 'UsageReport'))}
        WHERE ${prismaRuntime.raw(quoted('accountId'))} = ${accountId} ${beforeEnd} ${source}
        GROUP BY ${prismaRuntime.raw(day)}`;
}

/**
 * Compare all retained inputs in the admitted snapshot. Exact SQLite witnesses
 * never leave storage on a hit. A narrower end removes stored later days too:
 * a later expansion must not reuse witnesses whose retained body was removed.
 */
export async function readUsageActivitySourceChanges(tx: Tx, accountId: string,
    endMs?: number): Promise<UsageActivitySourceChange[]> {
    const column = (alias: string, name: string) => prismaRuntime.raw(`${alias}.${quoted(name)}`);
    const equal = sqlDialect() === 'mysql'
        ? prismaRuntime.sql`CAST(${column('c', 'fingerprint')} AS BINARY) = CAST(${column('p', 'payload')} AS BINARY)`
        : prismaRuntime.sql`${column('c', 'fingerprint')} = ${column('p', 'payload')}`;
    const rows = await tx.$queryRaw<Array<Omit<UsageActivitySourceChange, 'dayStartMs'> & { dayStartMs: number | bigint }>>(prismaRuntime.sql`
        WITH current_sources AS (
            ${sourceReadSql(accountId, 'event', endMs)} UNION ALL ${sourceReadSql(accountId, 'report', endMs)}
        ), stored_sources AS (
            SELECT CASE WHEN ${prismaRuntime.raw(quoted('kind'))} = ${sourceKinds.event} THEN 'event' ELSE 'report' END AS ${prismaRuntime.raw(quoted('kind'))},
                ${prismaRuntime.raw(quoted('observedAtMs'))} AS ${prismaRuntime.raw(quoted('dayStartMs'))}, ${prismaRuntime.raw(quoted('payload'))}
            FROM ${prismaRuntime.raw(quoted('UsageAccountingProjection'))}
            WHERE ${prismaRuntime.raw(quoted('accountId'))} = ${accountId}
                AND ${prismaRuntime.raw(quoted('kind'))} IN (${sourceKinds.event}, ${sourceKinds.report})
        )
        SELECT ${column('c', 'kind')}, ${column('c', 'dayStartMs')}, ${column('c', 'fingerprint')}
        FROM current_sources c LEFT JOIN stored_sources p
            ON ${column('c', 'kind')} = ${column('p', 'kind')} AND ${column('c', 'dayStartMs')} = ${column('p', 'dayStartMs')}
        WHERE ${column('p', 'payload')} IS NULL OR NOT (${equal})
        UNION ALL
        SELECT ${column('p', 'kind')}, ${column('p', 'dayStartMs')}, NULL AS ${prismaRuntime.raw(quoted('fingerprint'))}
        FROM stored_sources p WHERE NOT EXISTS (SELECT 1 FROM current_sources c
            WHERE ${column('c', 'kind')} = ${column('p', 'kind')} AND ${column('c', 'dayStartMs')} = ${column('p', 'dayStartMs')})
        ORDER BY ${prismaRuntime.raw(quoted('kind'))}, ${prismaRuntime.raw(quoted('dayStartMs'))}`);
    return rows.map(row => ({ ...row, dayStartMs: Number(row.dayStartMs) }));
}

/** Publish a replay result and its captured witnesses together after releasing the read snapshot. */
export async function saveUsageActivitySummary(accountId: string, expectedHead: string | null,
    head: string, updates: ReadonlyMap<string, string | null>,
    changes: readonly UsageActivitySourceChange[]): Promise<boolean> {
    const key = recordKey(accountId, summaryKind);
    const chunkRows = await Promise.all([...updates].map(async ([item, payload]) => ({
        recordKey: recordKey(accountId, chunkKind, item), accountId, kind: chunkKind,
        observedAtMs: 0n, validFromMs: 0n,
        payload: payload === null ? null : privacyKit.encodeBase64(await compressChunk(payload, {
            params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 1 },
        })),
    })));
    try {
        return await inTx(async tx => {
            if (expectedHead === null) {
                await tx.usageAccountingProjection.create({ data: { recordKey: key, accountId, kind: summaryKind,
                    observedAtMs: 0n, validFromMs: 0n, payload: head } });
            } else {
                const equal = sqlDialect() === 'mysql'
                    ? prismaRuntime.sql`CAST(${prismaRuntime.raw(quoted('payload'))} AS BINARY) = CAST(${expectedHead} AS BINARY)`
                    : prismaRuntime.sql`${prismaRuntime.raw(quoted('payload'))} = ${expectedHead}`;
                const updated = await tx.$executeRaw(prismaRuntime.sql`UPDATE ${prismaRuntime.raw(quoted('UsageAccountingProjection'))}
                    SET ${prismaRuntime.raw(quoted('payload'))} = ${head}
                    WHERE ${prismaRuntime.raw(quoted('recordKey'))} = ${key}
                        AND ${prismaRuntime.raw(quoted('accountId'))} = ${accountId} AND ${equal}`);
                if (updated === 0) return false;
            }
            const replacements = [...chunkRows, ...changes.map(change => ({
                recordKey: recordKey(accountId, sourceKinds[change.kind], change.dayStartMs), accountId,
                kind: sourceKinds[change.kind], observedAtMs: BigInt(change.dayStartMs), validFromMs: 0n,
                payload: change.fingerprint,
            }))];
            for (const chunk of portableQueryChunks({ values: replacements, bindingsPerValue: 1, fixedBindings: 1 })) {
                await tx.usageAccountingProjection.deleteMany({ where: { accountId, recordKey: { in: chunk.map(row => row.recordKey) } } });
            }
            const present = replacements.filter((row): row is typeof row & { payload: string } => row.payload !== null);
            for (const chunk of portableQueryChunks({ values: present, bindingsPerValue: 6 })) {
                await tx.usageAccountingProjection.createMany({ data: [...chunk] });
            }
            return true;
        });
    } catch (error) {
        // A competing first publisher owns the row; its committed witnesses remain untouched.
        if (isPrismaErrorCode(error, 'P2002')) return false;
        throw error;
    }
}
