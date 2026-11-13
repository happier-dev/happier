import { spawnSync } from 'node:child_process';

/** Keep Node's SQLite and Prisma's native SQLite in separate processes: their
 * independent in-process lock bookkeeping cannot coordinate shared WAL maps.
 * https://www.sqlite.org/howtocorrupt.html#multiple_copies_of_sqlite_linked_into_the_same_application */
export function measureSqliteQueryVisits(params: Readonly<{
    dbPath: string; sql: string; bindings: readonly (string | number | null)[]; probeName: string;
}>): Readonly<{ rowCount: number; visits: number }> {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { readFileSync } from 'node:fs';
        import { DatabaseSync } from 'node:sqlite';
        const input = JSON.parse(readFileSync(0, 'utf8'));
        const database = new DatabaseSync(input.dbPath, { readOnly: true });
        let visits = 0;
        try {
            database.function(input.probeName, () => { visits++; return 1; });
            const rows = database.prepare(input.sql).all(...input.bindings);
            process.stdout.write(JSON.stringify({ rowCount: rows.length, visits }));
        } finally { database.close(); }
    `], { input: JSON.stringify(params), encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`SQLite cost probe failed (${result.signal ?? result.status}): ${result.stderr}`);
    const value: unknown = JSON.parse(result.stdout);
    if (!value || typeof value !== 'object' || !('rowCount' in value) || !('visits' in value)
        || typeof value.rowCount !== 'number' || typeof value.visits !== 'number') throw new Error('Invalid SQLite cost probe result');
    return { rowCount: value.rowCount, visits: value.visits };
}
