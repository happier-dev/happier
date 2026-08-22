import {
    decodeDaemonDatabaseWorkerLineFrames,
    decodeDaemonDatabaseWorkerValue,
    encodeDaemonDatabaseWorkerLine,
    encodeDaemonDatabaseWorkerRow,
    encodeDaemonDatabaseWorkerValue,
    type DaemonDatabaseWorkerResultLimits,
    type DaemonDatabaseWorkerRequest,
    type DaemonDatabaseWorkerResponse,
} from './daemonDatabaseWorker';
import { openSqliteDatabaseSync, type SqliteDatabaseSync } from '@/daemon/persistence/sqliteSync';
import { PluginContextServiceError } from './errors';

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isResultLimits(value: unknown): value is DaemonDatabaseWorkerResultLimits {
    if (!isRecord(value)) return false;
    return typeof value.maximumResultRows === 'number'
        && Number.isSafeInteger(value.maximumResultRows)
        && value.maximumResultRows > 0
        && typeof value.maximumResultBytes === 'number'
        && Number.isSafeInteger(value.maximumResultBytes)
        && value.maximumResultBytes > 0;
}

function encodedRowByteLength(row: unknown): number {
    const encoded = JSON.stringify(row);
    if (typeof encoded !== 'string') {
        throw new PluginContextServiceError(
            'daemon_database_result_invalid',
            'SQLite query returned an invalid row',
        );
    }
    return Buffer.byteLength(encoded, 'utf8');
}

function parseRequest(value: unknown): DaemonDatabaseWorkerRequest | null {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.kind !== 'string') return null;
    switch (value.kind) {
        case 'open':
            return typeof value.filePath === 'string'
                ? value as unknown as DaemonDatabaseWorkerRequest
                : null;
        case 'exec':
            return typeof value.sql === 'string'
                ? value as unknown as DaemonDatabaseWorkerRequest
                : null;
        case 'get':
        case 'run':
            return typeof value.sql === 'string' && Array.isArray(value.values)
                ? value as unknown as DaemonDatabaseWorkerRequest
                : null;
        case 'all':
            return typeof value.sql === 'string' && Array.isArray(value.values) && isResultLimits(value.resultLimits)
                ? value as unknown as DaemonDatabaseWorkerRequest
                : null;
        case 'close':
            return value as unknown as DaemonDatabaseWorkerRequest;
        default:
            return null;
    }
}

function serializeError(error: unknown): Readonly<{ message: string; code: string | null }> {
    const message = error instanceof Error ? error.message : String(error ?? 'SQLite database worker failed');
    const candidateCode = error instanceof Error ? (error as Error & { code?: unknown }).code : null;
    return {
        message: message.trim().length > 0 ? message : 'SQLite database worker failed',
        code: typeof candidateCode === 'string' && candidateCode.trim().length > 0 ? candidateCode : null,
    };
}

function write(response: DaemonDatabaseWorkerResponse): void {
    process.stdout.write(encodeDaemonDatabaseWorkerLine(response));
}

/**
 * Runs inside the binary-safe `happier daemon database-worker` child. The parent
 * database entry remains the sole admission/transaction owner; this process owns
 * only one synchronous SQLite connection so a long native call cannot occupy the daemon.
 */
export async function runDaemonDatabaseWorkerChild(): Promise<void> {
    let database: SqliteDatabaseSync | null = null;
    let closing = false;

    const close = (): void => {
        if (!database) return;
        const current = database;
        database = null;
        current.close();
    };

    const respond = (request: DaemonDatabaseWorkerRequest): void => {
        try {
            switch (request.kind) {
                case 'open': {
                    if (database) throw new Error('daemon_database_worker_already_open');
                    database = openSqliteDatabaseSync(request.filePath);
                    write({ id: request.id, ok: true, result: { kind: 'void' } });
                    return;
                }
                case 'close': {
                    close();
                    closing = true;
                    write({ id: request.id, ok: true, result: { kind: 'void' } });
                    return;
                }
                case 'exec': {
                    if (!database) throw new Error('daemon_database_worker_not_open');
                    database.exec(request.sql);
                    write({ id: request.id, ok: true, result: { kind: 'void' } });
                    return;
                }
                case 'get': {
                    if (!database) throw new Error('daemon_database_worker_not_open');
                    const row = database.prepare(request.sql).get(...request.values.map(decodeDaemonDatabaseWorkerValue));
                    write({
                        id: request.id,
                        ok: true,
                        result: { kind: 'row', row: row === undefined ? null : encodeDaemonDatabaseWorkerRow(row) },
                    });
                    return;
                }
                case 'all': {
                    if (!database) throw new Error('daemon_database_worker_not_open');
                    const rows: ReturnType<typeof encodeDaemonDatabaseWorkerRow>[] = [];
                    let encodedBytes = 0;
                    for (const rawRow of database.prepare(request.sql).iterate(
                        ...request.values.map(decodeDaemonDatabaseWorkerValue),
                    )) {
                        if (rows.length >= request.resultLimits.maximumResultRows) {
                            throw new PluginContextServiceError(
                                'daemon_database_result_too_large',
                                'SQLite query returned too many rows',
                            );
                        }
                        const row = encodeDaemonDatabaseWorkerRow(rawRow);
                        const separatorBytes = rows.length === 0 ? 0 : 1;
                        const rowBytes = encodedRowByteLength(row);
                        if (
                            encodedBytes + separatorBytes + rowBytes
                            > request.resultLimits.maximumResultBytes
                        ) {
                            throw new PluginContextServiceError(
                                'daemon_database_result_too_large',
                                'SQLite query result exceeds the daemon database limit',
                            );
                        }
                        rows.push(row);
                        encodedBytes += separatorBytes + rowBytes;
                    }
                    write({
                        id: request.id,
                        ok: true,
                        result: { kind: 'rows', rows },
                    });
                    return;
                }
                case 'run': {
                    if (!database) throw new Error('daemon_database_worker_not_open');
                    const raw = database.prepare(request.sql).run(...request.values.map(decodeDaemonDatabaseWorkerValue));
                    const result = raw as Readonly<{
                        changes?: unknown;
                        lastInsertRowid?: unknown;
                        lastInsertRowId?: unknown;
                    }>;
                    write({
                        id: request.id,
                        ok: true,
                        result: {
                            kind: 'run',
                            changes: result.changes === undefined ? null : encodeDaemonDatabaseWorkerValue(
                                result.changes as Parameters<typeof encodeDaemonDatabaseWorkerValue>[0],
                            ),
                            lastInsertRowId: result.lastInsertRowId === undefined && result.lastInsertRowid === undefined
                                ? null
                                : encodeDaemonDatabaseWorkerValue(
                                    (result.lastInsertRowId ?? result.lastInsertRowid) as Parameters<typeof encodeDaemonDatabaseWorkerValue>[0],
                                ),
                        },
                    });
                    return;
                }
            }
        } catch (error) {
            write({ id: request.id, ok: false, error: serializeError(error) });
        }
    };

    // The hidden daemon command awaits this entry before it exits. Keep that
    // promise pending while the stdio protocol is live; otherwise the command
    // would exit immediately after registering the listeners.
    await new Promise<void>((resolve) => {
        let finished = false;
        const finish = (): void => {
            if (finished) return;
            finished = true;
            try {
                close();
            } finally {
                resolve();
            }
        };
        process.stdin.on('data', decodeDaemonDatabaseWorkerLineFrames((value) => {
            const request = parseRequest(value);
            if (!request || closing) return;
            respond(request);
        }));
        process.stdin.once('end', finish);
        process.stdin.once('close', finish);
        process.once('SIGTERM', finish);
        process.once('SIGINT', finish);
        process.stdin.resume();
    });
}
