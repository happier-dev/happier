import { statSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { openSqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';
import type { DatabaseFailureCauseV1, DatabaseOperationInputV1, DatabaseOperationResultV1 } from '@happier-dev/database-protocol';
import { executeSqliteOperation, SqliteOperationError, type SqliteExecutionOptions, type SqliteNativeValue, type SqliteQuery } from '@happier-dev/databases/sqlite';
import { DatabaseStatementError } from '@happier-dev/databases';
import { fitDatabaseOperationResult } from '@happier-dev/databases';


export interface SqliteConnection {
    execute(input: DatabaseOperationInputV1, signal?: AbortSignal): Promise<DatabaseOperationResultV1>;
    close(): Promise<void>;
}

type SqliteWorkerRequest = { kind: 'execute'; input: DatabaseOperationInputV1; cancellation: SharedArrayBuffer } | { kind: 'close' };
type SqliteWorkerResponse = { kind: 'ready' } | { kind: 'result'; result: DatabaseOperationResultV1 } | { kind: 'closed' } | { kind: 'open_error'; message: string };
type SqliteWorkerData = { kind: 'happier.database-workbench.sqlite'; filePath: string; readOnly: boolean };

function cancelled(): DatabaseOperationResultV1 { return { ok: false, status: 'cancelled', code: 'database_cancelled' }; }
function connectionUnavailable(): DatabaseOperationResultV1 {
    return { ok: false, status: 'failed', code: 'database_connection_unavailable', reason: 'Reopen the database connection' };
}

export async function openSqliteConnection(filePath: string, options: { readOnly: boolean }): Promise<SqliteConnection> {
    // The same entry works as authored source and as the canonical single-file
    // daemon bundle. The worker owns the native handle for this connection.
    const worker = new Worker(new URL(import.meta.url), { workerData: { kind: 'happier.database-workbench.sqlite', filePath, readOnly: options.readOnly } satisfies SqliteWorkerData });
    let closed = false; let exited = false; let failure: Error | undefined;
    let activeCancellation: Int32Array | undefined;
    let sequence = Promise.resolve(); let closePromise: Promise<void> | undefined;
    worker.on('error', error => { failure = error; closed = true; });
    const exit = new Promise<void>(resolve => worker.once('exit', () => { exited = true; closed = true; resolve(); }));
    const exchange = (request?: SqliteWorkerRequest) => new Promise<SqliteWorkerResponse>((resolve, reject) => {
        if (failure || exited) { reject(failure ?? new Error('SQLite worker closed')); return; }
        const cleanup = () => { worker.off('message', message); worker.off('error', error); worker.off('exit', ended); };
        const message = (response: SqliteWorkerResponse) => { cleanup(); resolve(response); };
        const error = (cause: Error) => { cleanup(); reject(cause); };
        const ended = () => { cleanup(); reject(new Error('SQLite worker closed')); };
        worker.once('message', message); worker.once('error', error); worker.once('exit', ended);
        try { if (request) worker.postMessage(request); } catch (cause) { cleanup(); reject(cause); }
    });
    try {
        const response = await exchange();
        if (response.kind !== 'ready') throw new Error(response.kind === 'open_error' ? response.message : 'SQLite worker did not open');
    } catch (error) { await exit; throw error; }
    return {
        execute(input, signal) {
            // Preserve the native connection's serial operation order without
            // sharing cancellation between queued requests.
            const operation = sequence.then(async () => {
                if (closed) return connectionUnavailable();
                if (signal?.aborted) return cancelled();
                const cancellation = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
                const abort = () => { Atomics.store(cancellation, 0, 1); };
                activeCancellation = cancellation;
                signal?.addEventListener('abort', abort, { once: true });
                if (signal?.aborted) abort();
                try {
                    const response = await exchange({ kind: 'execute', input, cancellation: cancellation.buffer as SharedArrayBuffer });
                    // The worker decides cancellation before COMMIT. A later
                    // AbortSignal cannot reinterpret an already-settled write.
                    return response.kind === 'result' ? response.result : connectionUnavailable();
                } catch { return connectionUnavailable(); }
                finally { signal?.removeEventListener('abort', abort); activeCancellation = undefined; }
            });
            sequence = operation.then(() => undefined, () => undefined);
            return operation;
        },
        close() {
            if (closePromise) return closePromise;
            closed = true;
            if (activeCancellation) Atomics.store(activeCancellation, 0, 1);
            closePromise = sequence.then(async () => {
                if (!exited && !failure) await exchange({ kind: 'close' });
                await exit;
            });
            return closePromise;
        },
    };
}

function openNativeSqliteConnection(filePath: string, options: { readOnly: boolean }) {
    // User-selected files are not daemon storage. Do not chmod them or create a missing database.
    if (!statSync(filePath).isFile()) throw new Error('The selected SQLite database is not a file');
    const db = openSqliteDatabaseSync(filePath, { readOnly: options.readOnly });
    // Bun follows SQLite's disabled-by-default FK setting; Node enables it.
    // Workbench mutations honor the same declared constraints on both providers.
    let setup: { database: string; dbstat: boolean };
    try {
        db.exec('PRAGMA foreign_keys=ON');
        const facts = db.prepare("SELECT file,EXISTS(SELECT 1 FROM pragma_module_list WHERE name='dbstat') FROM pragma_database_list WHERE name='main'").values()[0];
        const filename = facts?.[0];
        if (typeof filename !== 'string' || !filename) throw new Error('SQLite did not report the selected database filename');
        setup = { database: filename, dbstat: facts?.[1] === 1n };
    }
    catch (error) { db.close(); throw error; }
    const databaseIdentity = JSON.stringify({ filePath: setup.database });
    let closed = false;
    return {
        execute(input: DatabaseOperationInputV1, cancellation: Int32Array): DatabaseOperationResultV1 {
            const controller = new AbortController(); const signal = controller.signal;
            // Native calls may finish before observing this one local abort fact.
            // Cleanup uses db.exec directly so cancellation cannot prevent rollback.
            const observeCancellation = () => { if (Atomics.load(cancellation, 0) !== 0) controller.abort(); };
            const checkCancellation = () => { observeCancellation(); signal.throwIfAborted(); };
            observeCancellation();
            if (signal.aborted) return cancelled();
            if (closed) return connectionUnavailable();
            const query: SqliteQuery = statement => {
                checkCancellation();
                const prepared = db.prepare(statement.text); const columns = prepared.columns();
                checkCancellation();
                // Keep optional change metadata absent instead of replaying RETURNING writes.
                if (columns.length) {
                    const rows = prepared.values(...statement.values) as SqliteNativeValue[][];
                    checkCancellation(); return { columns, rows, changes: null };
                }
                const result = prepared.run(...statement.values);
                checkCancellation();
                if (!result || typeof result !== 'object' || !('changes' in result) || (typeof result.changes !== 'number' && typeof result.changes !== 'bigint')) throw new Error('SQLite did not return an affected-row count');
                return { columns, rows: [], changes: BigInt(result.changes) };
            };
            const write = input.operation === 'edits.apply' || (input.operation === 'statement.run' && input.mode === 'write') || (input.operation === 'statement.explain' && input.accessMode === 'write');
            let transaction = false;
            try {
                if (!options.readOnly) db.exec(`PRAGMA query_only=${write ? 'OFF' : 'ON'}`);
                db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN'); transaction = true;
                const executionOptions: SqliteExecutionOptions = input.operation === 'stats.read' ? { stats: {
                    database: setup.database, dbstat: setup.dbstat,
                    intervalBasis: { databaseIdentity,
                        bindingKey: JSON.stringify({ target: input.target, databaseIdentity }),
                        selectionKey: JSON.stringify(input.request) },
                } } : {};
                const result = fitDatabaseOperationResult(input, executeSqliteOperation(input, query, executionOptions));
                checkCancellation();
                db.exec(!result.ok || (input.operation === 'statement.explain' && input.accessMode === 'write') ? 'ROLLBACK' : 'COMMIT'); transaction = false;
                return result;
            } catch (error) {
                if (transaction) { try { db.exec('ROLLBACK'); } catch { db.close(); closed = true; } }
                observeCancellation();
                if (signal.aborted) return cancelled();
                if (error instanceof SqliteOperationError) return error.failure;
                if (error instanceof DatabaseStatementError) return { ok: false, status: 'failed', code: error.code, reason: error.reason };
                const nativeCode = error instanceof Error && 'errcode' in error && typeof error.errcode === 'number' ? String(error.errcode)
                    : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'SQLITE_ERROR';
                const cause: DatabaseFailureCauseV1 = { source: 'engine', code: nativeCode, message: error instanceof Error ? error.message : 'SQLite operation failed',
                    ...(error instanceof Error && 'statementIndex' in error && typeof error.statementIndex === 'number' ? { statementIndex: error.statementIndex } : {}) };
                return { ok: false, status: 'failed', code: 'database_engine_error', cause };
            } finally { if (!closed && !options.readOnly) db.exec('PRAGMA query_only=OFF'); }
        },
        close() { if (!closed) { db.close(); closed = true; } },
    };
}

const sqliteWorkerData = workerData as SqliteWorkerData | undefined;
if (!isMainThread && sqliteWorkerData?.kind === 'happier.database-workbench.sqlite') {
    const port = parentPort!;
    try {
        const connection = openNativeSqliteConnection(sqliteWorkerData.filePath, { readOnly: sqliteWorkerData.readOnly });
        port.on('message', (request: SqliteWorkerRequest) => {
            if (request.kind === 'execute') port.postMessage({ kind: 'result', result: connection.execute(request.input, new Int32Array(request.cancellation)) } satisfies SqliteWorkerResponse);
            else { connection.close(); port.postMessage({ kind: 'closed' } satisfies SqliteWorkerResponse); port.close(); }
        });
        port.postMessage({ kind: 'ready' } satisfies SqliteWorkerResponse);
    } catch (error) {
        port.postMessage({ kind: 'open_error', message: error instanceof Error ? error.message : 'SQLite connection unavailable' } satisfies SqliteWorkerResponse);
        port.close();
    }
}
