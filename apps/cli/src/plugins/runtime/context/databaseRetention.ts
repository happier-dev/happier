import type { DaemonDatabase, DaemonDatabaseRetentionCallback, DaemonDatabaseTransaction } from '@happier-dev/plugin-sdk/storage';
import type { PluginDaemonDatabaseContributionV1 } from '@happier-dev/protocol';

export type DaemonDatabaseRetentionPassResult = Readonly<{
    pruned: number;
    nextDueAtMs: number | null;
}>;

export type DaemonDatabaseRetentionOperation = Readonly<{ beforeEffect?: () => Promise<void> }>;

/** The database owner supplies its existing statement bound; this creates no policy or wake. */
export async function runDatabaseRetention(input: Readonly<{
    database: DaemonDatabase;
    retention: NonNullable<PluginDaemonDatabaseContributionV1['retention']>;
    days: number;
    nowMs: number;
    maximumAffectedRows: number;
    maximumResultRows: number;
    operation: DaemonDatabaseRetentionOperation;
    onRetention?: DaemonDatabaseRetentionCallback;
}>): Promise<DaemonDatabaseRetentionPassResult> {
    const ageMs = input.days * 86_400_000;
    const cutoff = input.nowMs - ageMs;
    let pruned = 0;
    let nextDueAtMs: number | null = null;
    const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
    for (const declaration of input.retention) {
        const table = quote(declaration.table);
        const timeColumn = quote(declaration.timeColumn);
        const selectedRows = `SELECT rowid FROM ${table} WHERE ${timeColumn} <= ? LIMIT ?`;
        const deleteSql = `DELETE FROM ${table} WHERE rowid IN (${selectedRows})`;
        const values = [cutoff, input.maximumAffectedRows];
        const readKeys = async (tx: DaemonDatabaseTransaction): Promise<string[]> => {
            if (!declaration.changeKeyColumn) return [];
            const keyColumn = quote(declaration.changeKeyColumn);
            const keys: string[] = [];
            let after: string | undefined;
            let pageSize = input.maximumResultRows;
            while (true) {
                // Both reads and DELETE select the same bounded rows in this transaction.
                const sql = `WITH expiring AS (SELECT CAST(${keyColumn} AS TEXT) AS changeKey FROM ${table} WHERE rowid IN (${selectedRows})) SELECT DISTINCT changeKey FROM expiring WHERE changeKey IS NOT NULL${after === undefined ? '' : ' AND changeKey > ?'} ORDER BY changeKey LIMIT ?`;
                let rows;
                try {
                    rows = await tx.query<{ changeKey: string }>(sql, [...values, ...(after === undefined ? [] : [after]), pageSize]);
                } catch (error) {
                    if (pageSize <= 1 || error === null || typeof error !== 'object'
                        || !('code' in error) || error.code !== 'daemon_database_result_too_large') throw error;
                    // Shrink only when the owner's actual encoded-byte boundary refuses a page.
                    pageSize = Math.ceil(pageSize / 2);
                    continue;
                }
                keys.push(...rows.map(row => row.changeKey));
                if (rows.length < pageSize) return keys;
                after = rows.at(-1)!.changeKey;
            }
        };
        let changes: number;
        do {
            await input.operation.beforeEffect?.();
            const chunk = declaration.changeKeyColumn && input.onRetention
                ? await input.database.transaction(async tx => {
                    const keys = await readKeys(tx);
                    const result = await tx.execute(deleteSql, values);
                    return { changes: result.changes, keys };
                })
                : { ...(await input.database.execute(deleteSql, values)), keys: [] };
            changes = chunk.changes;
            pruned += changes;
            if (changes && chunk.keys.length) input.onRetention?.({ table: declaration.table, keys: chunk.keys });
        } while (changes === input.maximumAffectedRows);
        const oldest = (await input.database.query(`SELECT MIN(${timeColumn}) AS oldest FROM ${table}`))[0]?.oldest;
        if (typeof oldest === 'number') nextDueAtMs = Math.min(nextDueAtMs ?? Infinity, oldest + ageMs);
    }
    return { pruned, nextDueAtMs };
}
