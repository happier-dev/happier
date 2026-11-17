import { Client, Query } from 'pg';
import type { Duplex } from 'node:stream';
import type { DatabaseOperationInputV1, DatabaseOperationResultV1 } from '@happier-dev/database-protocol';
import {
    executePostgresqlOperation, PostgresqlInputError, PostgresqlOperationError, postgresqlFailureCause,
    compilePostgresqlSetupV1, decodePostgresqlSetupV1,
    type PostgresqlCompiledStatement, type PostgresqlNativeResult, type PostgresqlSetupFactsV1,
    type PostgresqlExecutionOptions,
} from '../postgresql/index.js';

export { postgresqlCapabilities } from '../capabilities.js';

export interface PostgresqlConnection {
    execute(input: DatabaseOperationInputV1, signal?: AbortSignal): Promise<DatabaseOperationResultV1>;
    close(): Promise<void>;
}

/** The caller owns this demand's credential and connection. No pool, timer or retry outlives it. */
export async function openPostgresqlConnection(connectionString: string, signal?: AbortSignal,
    options: Readonly<{ sessionGuardSql?: string;
        openStream?: () => Promise<Readonly<{ stream: Duplex; close(): Promise<void> }>>;
    }> = {}): Promise<PostgresqlConnection> {
    signal?.throwIfAborted();
    const openClient = async () => {
        const transport = await options.openStream?.();
        try {
            // pg 8.23.1's stream factory expects these two Socket methods.
            // The caller already opened the transport; notify pg after it has
            // attached its protocol listeners, without opening another socket.
            const stream = transport ? Object.assign(transport.stream, {
                setNoDelay() { return transport.stream; },
                connect() { queueMicrotask(() => transport.stream.emit('connect')); return transport.stream; },
            }) : undefined;
            return { client: new Client({ connectionString, ...(stream ? { stream: () => stream } : {}) }), transport };
        } catch (error) { await transport?.close(); throw error; }
    };
    const { client, transport } = await openClient();
    let closed = false;
    let closing: Promise<void> | undefined;
    let terminalError: unknown;
    let activeQuery: Query<Array<string | null>, PostgresqlCompiledStatement['values']> | undefined;
    let activeCompletion: Promise<void> | undefined;
    let cancellation: Promise<void> | undefined;
    let tail: Promise<unknown> = Promise.resolve();
    const cancelActive = (): Promise<void> => {
        if (cancellation) return cancellation;
        if (!activeQuery) return Promise.resolve();
        const native = activeQuery;
        const completion = activeCompletion;
        cancellation = (async () => {
            const borrowed = await openClient();
            const sender = borrowed.client;
            try {
                // Opening a borrowed stream is asynchronous. The original
                // statement may have completed before cancellation can be sent.
                if (activeQuery !== native) return;
                const delivered = new Promise<void>(resolve => {
                    sender.connection.once('end', resolve);
                    sender.connection.once('error', () => { sender.connection.stream.destroy(); void client.end().catch(() => {}); resolve(); });
                });
                // pg 8.23.1 exposes native CancelRequest here; @types/pg omits this driver method.
                const boundary = sender as Client & { cancel(target: Client, native: Query<Array<string | null>, PostgresqlCompiledStatement['values']>): void };
                boundary.cancel(client, native);
                await Promise.all([delivered, completion]);
            } finally { sender.connection.stream.destroy(); await borrowed.transport?.close(); }
        })();
        return cancellation;
    };
    const close = () => {
        if (!closing) {
            closed = true;
            closing = (async () => {
                try { await cancelActive(); }
                finally { try { await client.end(); } finally { await transport?.close(); } }
            })();
        }
        return closing;
    };
    // pg emits idle network failures separately from query rejections. Retain the cause for the next request.
    client.on('error', error => { terminalError = error; });
    const query = (statement: PostgresqlCompiledStatement): Promise<PostgresqlNativeResult> => {
        const config = { text: statement.text, values: statement.values, rowMode: 'array' as const,
            queryMode: 'extended', types: { getTypeParser: () => (value: string) => value } };
        return new Promise((resolve, reject) => {
            let settled!: () => void;
            activeCompletion = new Promise<void>(resolve => { settled = resolve; });
            const native = new Query<Array<string | null>, PostgresqlCompiledStatement['values']>(config, (error, result) => {
                activeQuery = undefined;
                activeCompletion = undefined;
                settled();
                if (error) reject(error); else resolve(result);
            });
            activeQuery = native;
            client.query(native);
        });
    };
    let setup: PostgresqlSetupFactsV1;
    const onConnectAbort = () => { void close().catch(() => {}); };
    signal?.throwIfAborted();
    signal?.addEventListener('abort', onConnectAbort, { once: true });
    try {
        signal?.throwIfAborted();
        await client.connect();
        if (options.sessionGuardSql) await query({ text: options.sessionGuardSql, values: [] });
        setup = decodePostgresqlSetupV1(await query(compilePostgresqlSetupV1()));
        signal?.throwIfAborted();
    }
    catch (error) { await close().catch(() => {}); throw error; }
    finally { signal?.removeEventListener('abort', onConnectAbort); }
    const databaseIdentity = JSON.stringify({ database: setup.database, databaseOid: setup.databaseOid,
        serverAddress: setup.serverAddress, serverPort: setup.serverPort, engineStartedAt: setup.engineStartedAt });
    const execute = async (input: DatabaseOperationInputV1, operationSignal?: AbortSignal): Promise<DatabaseOperationResultV1> => {
        if (operationSignal?.aborted) return { ok: false, status: 'cancelled', code: 'database_cancelled' };
        if (closed || terminalError) return { ok: false, status: 'failed', code: 'database_connection_unavailable',
            ...(terminalError ? { cause: postgresqlFailureCause(terminalError) } : {}), reason: 'Reopen the database connection' };
        const write = input.operation === 'edits.apply'
            || (input.operation === 'statement.run' && input.mode === 'write')
            || (input.operation === 'statement.explain' && input.accessMode === 'write');
        let transaction = false;
        let committing = false;
        const onAbort = () => {
            if (!activeQuery) { void close().catch(() => {}); return; }
            void cancelActive().catch(() => { void close().catch(() => {}); });
        };
        operationSignal?.addEventListener('abort', onAbort, { once: true });
        try {
            await query({ text: write ? 'BEGIN' : 'BEGIN READ ONLY', values: [] });
            transaction = true;
            const options: PostgresqlExecutionOptions = input.operation === 'stats.read' ? { stats: {
                database: setup.database, pgStatStatements: setup.pgStatStatements,
                intervalBasis: { databaseIdentity, engineStartedAt: setup.engineStartedAt,
                    bindingKey: JSON.stringify({ target: input.target, databaseIdentity, currentUser: setup.currentUser }),
                    selectionKey: JSON.stringify(input.request) },
            } } : {};
            const result = await executePostgresqlOperation(input, query, options);
            operationSignal?.throwIfAborted();
            if (!result.ok || (input.operation === 'statement.explain' && input.accessMode === 'write')) {
                await query({ text: 'ROLLBACK', values: [] });
            } else {
                committing = true;
                await query({ text: 'COMMIT', values: [] });
            }
            transaction = false;
            return result;
        } catch (error) {
            if (transaction && !closed) {
                try { await query({ text: 'ROLLBACK', values: [] }); }
                catch { await close().catch(() => {}); }
            }
            if (committing && (closed || operationSignal?.aborted || postgresqlFailureCause(error).source === 'transport')) return { ok: false, status: 'outcome_unknown', code: 'database_outcome_unknown', cause: postgresqlFailureCause(error) };
            if (operationSignal?.aborted || closed) return { ok: false, status: 'cancelled', code: 'database_cancelled' };
            if (error instanceof PostgresqlOperationError) return error.failure;
            if (error instanceof PostgresqlInputError) return { ok: false, status: 'failed', code: error.code, reason: error.reason };
            const failureCause = postgresqlFailureCause(error);
            return { ok: false, status: 'failed', code: failureCause.source === 'engine' ? 'database_engine_error' : 'database_transport_error', cause: failureCause };
        } finally {
            operationSignal?.removeEventListener('abort', onAbort);
            if (cancellation) await cancellation;
            if (operationSignal?.aborted) await close().catch(() => {});
        }
    };
    return {
        // pg queues individual queries; serialize whole operations so concurrent page requests cannot interleave transactions.
        execute(input, operationSignal) {
            const result = tail.then(() => execute(input, operationSignal));
            tail = result.catch(() => {});
            return result;
        },
        close,
    };
}
