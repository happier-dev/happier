import type { DaemonDatabase } from '@happier-dev/plugin-sdk/storage';
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
    operation: DaemonDatabaseRetentionOperation;
}>): Promise<DaemonDatabaseRetentionPassResult> {
    const ageMs = input.days * 86_400_000;
    const cutoff = input.nowMs - ageMs;
    let pruned = 0;
    let nextDueAtMs: number | null = null;
    const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
    for (const declaration of input.retention) {
        const table = quote(declaration.table);
        const timeColumn = quote(declaration.timeColumn);
        let changes: number;
        do {
            await input.operation.beforeEffect?.();
            ({ changes } = await input.database.execute(
                `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${timeColumn} <= ? LIMIT ?)`,
                [cutoff, input.maximumAffectedRows],
            ));
            pruned += changes;
        } while (changes === input.maximumAffectedRows);
        const oldest = (await input.database.query(`SELECT MIN(${timeColumn}) AS oldest FROM ${table}`))[0]?.oldest;
        if (typeof oldest === 'number') nextDueAtMs = Math.min(nextDueAtMs ?? Infinity, oldest + ageMs);
    }
    return { pruned, nextDueAtMs };
}
