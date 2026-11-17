import { DatabaseSync } from 'node:sqlite';
import type { DaemonDatabase, DaemonDatabaseRow, DaemonDatabaseValue } from '@happier-dev/plugin-sdk/storage';

function deferred() {
    let resolve = () => {};
    const promise = new Promise<void>(settle => { resolve = settle; });
    return { promise, resolve };
}

/** The genuine persistent-database boundary, with an optional barrier on a real open write transaction. */
export function createCaptureSqliteFixture() {
    const sqlite = new DatabaseSync(':memory:');
    const statements: string[] = [];
    const queryRows: number[] = [];
    let writeFailureCode: string | null = null;
    let commitBarrier: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
    const db: DaemonDatabase = {
        async query<T extends DaemonDatabaseRow>(statement: string, params: readonly DaemonDatabaseValue[] = []) {
            statements.push(statement);
            const rows = sqlite.prepare(statement).all(...params);
            queryRows.push(rows.length);
            return rows as unknown as readonly T[];
        },
        async execute(statement, params = []) {
            statements.push(statement);
            if (writeFailureCode !== null) throw Object.assign(new Error('SQLite fixture write refused'), { code: writeFailureCode });
            const result = sqlite.prepare(statement).run(...params);
            return { changes: Number(result.changes), lastInsertRowId: result.lastInsertRowid };
        },
        async transaction(operation) {
            sqlite.exec('BEGIN');
            try {
                const result = await operation(db);
                const held = commitBarrier;
                if (held) {
                    commitBarrier = undefined;
                    held.entered.resolve();
                    await held.release.promise;
                }
                sqlite.exec('COMMIT');
                return result;
            } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
        },
    };
    return {
        db, statements, queryRows, close: () => sqlite.close(),
        failWrites(code: string | null) { writeFailureCode = code; },
        holdNextCommit() {
            const held = { entered: deferred(), release: deferred() };
            commitBarrier = held;
            return { entered: held.entered.promise, release: held.release.resolve };
        },
    };
}
