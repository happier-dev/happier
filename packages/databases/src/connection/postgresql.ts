import { Client, Query } from 'pg';
import type { Duplex } from 'node:stream';
import type { DatabaseOperationClassV1, DatabaseOperationInputV1, DatabaseOperationResultV1 } from '@happier-dev/plugin-sdk/database';
import { statsOperationResultV1 } from '../stats.js';
import { databaseConnectionUrlWithoutOptions, databaseTlsVerification, withDatabaseConnectionUrlOptions, type DatabaseConnectionOperationRunner, type DatabaseTls } from '../connection.js';
import {
    executePostgresqlOperation, normalizePostgresqlStatement, PostgresqlInputError, PostgresqlOperationError, postgresqlFailureCause,
    compilePostgresqlSetupV1, decodePostgresqlSetupV1, postgresqlStatsExecutionOptions,
    type PostgresqlCompiledStatement, type PostgresqlNativeResult, type PostgresqlSetupFactsV1,
    type PostgresqlExecutionOptions,
} from '../postgresql/index.js';
import { postgresqlReadRoleProof, postgresqlReadRoleSchemas } from '../postgresql/readRoleSetup.js';
import { quotePostgresqlIdentifier } from '../postgresql/identifiers.js';
import { POSTGRESQL_WORKBENCH_APPLICATION_NAME, postgresqlWorkbenchReadSql } from '../postgresql/workbenchIdentity.js';
import {
    DatabaseReadRoleError, matchesDatabaseReadRolePlan, planDatabaseReadRoleSetup, postgresqlReadRolePassword, readRoleFailure,
    type DatabaseReadRoleConnection, type DatabaseReadRoleVerificationResult,
} from '../readRoleSetup.js';

export { postgresqlCapabilities } from '../capabilities.js';

export interface PostgresqlConnection {
    execute(input: DatabaseOperationInputV1, signal?: AbortSignal): Promise<DatabaseOperationResultV1>;
    close(): Promise<void>;
}

/** The caller owns this demand's credential and connection. No pool, timer or retry outlives it. */
export async function openPostgresqlConnection(connectionString: string, signal?: AbortSignal,
    options: Readonly<{ access?: DatabaseOperationClassV1; sessionGuardSql?: string; tls?: DatabaseTls;
        /** One row admits the writer. A null value keeps the login's own grants. */
        writeRoleSetupSql?: string;
        runOperation?: DatabaseConnectionOperationRunner;
        openStream?: () => Promise<Readonly<{ stream: Duplex; close(): Promise<void> }>>;
    }> = {}): Promise<PostgresqlConnection & DatabaseReadRoleConnection & { normalizeStatementShape(sql: string): string }> {
    signal?.throwIfAborted();
    const uri = withDatabaseConnectionUrlOptions(options.tls ? databaseConnectionUrlWithoutOptions(connectionString) : connectionString, {
        application_name: POSTGRESQL_WORKBENCH_APPLICATION_NAME,
    });
    const tls = options.tls && databaseTlsVerification(options.tls);
    const openClient = async (address = uri) => {
        const transport = await options.openStream?.();
        try {
            // pg 8.23.1's stream factory expects these two Socket methods.
            // The caller already opened the transport; notify pg after it has
            // attached its protocol listeners, without opening another socket.
            const stream = transport ? Object.assign(transport.stream, {
                setNoDelay() { return transport.stream; },
                connect() { queueMicrotask(() => transport.stream.emit('connect')); return transport.stream; },
            }) : undefined;
            return { client: new Client({ connectionString: address, ...(stream ? { stream: () => stream } : {}),
                ...(tls ? { ssl: { rejectUnauthorized: tls.verify, ...(tls.ca === undefined ? {} : { ca: tls.ca }) } } : {}),
            }), transport };
        } catch (error) { await transport?.close(); throw error; }
    };
    let terminalError: unknown;
    let defaultReadOnly = false;
    const connectClient = async (address: string) => {
        const connection = await openClient(address);
        const { client, transport } = connection;
        const abort = () => { void client.end().catch(() => {}); };
        signal?.addEventListener('abort', abort, { once: true });
        client.on('error', error => { terminalError = error; });
        // PostgreSQL reports the effective default at login and after any change.
        client.connection.on('parameterStatus', (parameter: { parameterName: string; parameterValue: string }) => {
            if (parameter.parameterName === 'default_transaction_read_only') defaultReadOnly = parameter.parameterValue === 'on';
        });
        try {
            signal?.throwIfAborted();
            await client.connect();
            return connection;
        } catch (error) {
            await client.end().catch(() => {});
            await transport?.close().catch(() => {});
            throw error;
        } finally { signal?.removeEventListener('abort', abort); }
    };
    const originalStartupOptions = new URL(uri).searchParams.get('options') || process.env.PGOPTIONS;
    const readOnlyUri = options.access === 'read' ? withDatabaseConnectionUrlOptions(uri, {
        options: [originalStartupOptions, '-c default_transaction_read_only=on'].filter(Boolean).join(' '),
    }) : undefined;
    const { client, transport } = await connectClient(readOnlyUri ?? uri).catch(error => {
        // Older PgBouncer releases can reject the setting or the options field.
        // Keep the explicit per-operation guard when startup cannot carry it.
        if (!readOnlyUri || signal?.aborted || !(error instanceof Error)
            || (error.message !== 'unsupported startup parameter in options: default_transaction_read_only'
                && (originalStartupOptions || error.message !== 'unsupported startup parameter: options'))) throw error;
        terminalError = undefined;
        defaultReadOnly = false;
        return connectClient(uri);
    });
    // pg stores the PID supplied in PostgreSQL's BackendKeyData startup message.
    // The driver does not expose it in @types/pg.
    const backendKey = client as Client & { readonly processID?: number };
    let closed = false;
    let closing: Promise<void> | undefined;
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
    const query = (statement: PostgresqlCompiledStatement): Promise<PostgresqlNativeResult> => {
        const config = { text: statement.text, values: statement.values, rowMode: 'array' as const,
            ...(statement.simpleProtocol ? {} : { queryMode: 'extended' }), types: { getTypeParser: () => (value: string) => value } };
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
    let writeRoleSql: string | undefined;
    const onConnectAbort = () => { void close().catch(() => {}); };
    signal?.addEventListener('abort', onConnectAbort, { once: true });
    try {
        signal?.throwIfAborted();
        if (options.sessionGuardSql) await query({ text: options.sessionGuardSql, values: [] });
        if (options.writeRoleSetupSql) {
            const role = (await query({ text: postgresqlWorkbenchReadSql(options.writeRoleSetupSql), values: [] })).rows[0]?.[0];
            if (role === undefined) throw Object.assign(new Error('The PostgreSQL write role is unavailable'), { code: 'write_role_unavailable' });
            if (role !== null) writeRoleSql = `SET LOCAL ROLE ${quotePostgresqlIdentifier(role)}`;
        }
        setup = decodePostgresqlSetupV1(await query(compilePostgresqlSetupV1()));
        signal?.throwIfAborted();
    }
    catch (error) { await close().catch(() => {}); throw error; }
    finally { signal?.removeEventListener('abort', onConnectAbort); }
    const onAbort = () => {
        if (!activeQuery) { void close().catch(() => {}); return; }
        void cancelActive().catch(() => { void close().catch(() => {}); });
    };
    const execute = async (input: DatabaseOperationInputV1, operationSignal?: AbortSignal): Promise<DatabaseOperationResultV1> => {
        if (operationSignal?.aborted) return { ok: false, status: 'cancelled', code: 'database_cancelled' };
        if (closed || terminalError) return { ok: false, status: 'failed', code: 'database_connection_unavailable',
            ...(terminalError ? { cause: postgresqlFailureCause(terminalError) } : {}), reason: 'Reopen the database connection' };
        const signalsBackend = input.operation === 'activity.cancel';
        const write = input.operation === 'edits.apply'
            || input.operation === 'stats.enable'
            || (input.operation === 'statement.run' && input.mode === 'write')
            || (input.operation === 'statement.explain' && input.accessMode === 'write');
        const indexAdvice = input.operation === 'stats.read' && input.request.group === 'indexAdvice';
        // Console SQL retains explicit transaction semantics, including SET LOCAL.
        const useTransaction = write || indexAdvice || input.operation === 'statement.run'
            || input.operation === 'statement.explain' || !defaultReadOnly;
        let transaction = false;
        let committing = false;
        const executionOptions: PostgresqlExecutionOptions = input.operation === 'stats.read'
            ? postgresqlStatsExecutionOptions(setup, input, backendKey.processID ?? undefined)
            : {};
        operationSignal?.addEventListener('abort', onAbort, { once: true });
        try {
            if (signalsBackend) return await executePostgresqlOperation(input, query);
            if (useTransaction) {
                await query({ text: write ? 'BEGIN' : 'BEGIN READ ONLY', values: [] });
                transaction = true;
            }
            if (write && writeRoleSql) await query({ text: writeRoleSql, values: [] });
            const queryOperation: typeof query = indexAdvice ? statement => {
                operationSignal?.throwIfAborted();
                return query(statement);
            } : query;
            const result = await executePostgresqlOperation(input, queryOperation, executionOptions);
            operationSignal?.throwIfAborted();
            if (!transaction) return result;
            if (!result.ok || (input.operation === 'statement.explain' && input.accessMode === 'write')) {
                await query({ text: 'ROLLBACK', values: [] });
            } else {
                committing = true;
                await query({ text: 'COMMIT', values: [] });
            }
            transaction = false;
            return result;
        } catch (error) {
            if (transaction && !closed && !indexAdvice) {
                try { await query({ text: 'ROLLBACK', values: [] }); }
                catch { await close().catch(() => {}); }
            }
            if (!indexAdvice && (committing || signalsBackend) && (closed || operationSignal?.aborted || postgresqlFailureCause(error).source === 'transport')) return { ok: false, status: 'outcome_unknown', code: 'database_outcome_unknown', cause: postgresqlFailureCause(error) };
            if (operationSignal?.aborted || closed) return { ok: false, status: 'cancelled', code: 'database_cancelled' };
            if (error instanceof PostgresqlOperationError) return error.failure;
            if (error instanceof PostgresqlInputError) return { ok: false, status: 'failed', code: error.code, reason: error.reason };
            const failureCause = postgresqlFailureCause(error);
            if (input.operation === 'stats.enable' && failureCause.code === '42501') {
                return { ok: false, status: 'unavailable', code: 'database_statistics_extension_privilege_required',
                    reason: 'Use a database login that can install pg_stat_statements, or ask your database administrator to enable it.' };
            }
            if (input.operation === 'stats.read' && failureCause.code === '42501' && executionOptions.stats) {
                return statsOperationResultV1('postgresql', input.request,
                    { status: 'unavailable', reason: 'visibility_restricted' }, [], executionOptions.stats);
            }
            // Installed pg_stat_statements reports 55000 when its shared library
            // was not loaded. Preserve this connection
            // for ordinary reads and leaving user-authored SQL failures intact.
            if (input.operation === 'stats.read' && (input.request.group === 'statements' || indexAdvice)
                && failureCause.code === '55000' && executionOptions.stats) {
                return statsOperationResultV1('postgresql', input.request,
                    { status: 'unavailable', reason: 'preload_restart_required' }, [], executionOptions.stats);
            }
            return { ok: false, status: 'failed', code: failureCause.source === 'engine' ? 'database_engine_error' : 'database_transport_error', cause: failureCause };
        } finally {
            operationSignal?.removeEventListener('abort', onAbort);
            // HypoPG state is backend-local and can survive transaction rollback.
            if (indexAdvice && (transaction || operationSignal?.aborted)) {
                await close().catch(() => {});
            } else {
                if (cancellation) await cancellation;
                if (operationSignal?.aborted) await close().catch(() => {});
            }
        }
    };
    // The same queue owns ordinary transactions and read-role setup on this native session.
    const schedule = <T>(run: () => Promise<T>): Promise<T> => {
        const result = tail.then(run);
        tail = result.catch(() => {});
        return result;
    };
    const readRoleOperation = <T>(operationSignal: AbortSignal | undefined,
        run: (nativeQuery: typeof query) => Promise<T>): Promise<T> => schedule(async () => {
        if (operationSignal?.aborted) throw new DatabaseReadRoleError(readRoleFailure('database_cancelled', 'cancelled'));
        if (closed || terminalError) throw new DatabaseReadRoleError(readRoleFailure('database_connection_unavailable'));
        const nativeQuery: typeof query = statement => {
            operationSignal?.throwIfAborted();
            return query(statement);
        };
        operationSignal?.addEventListener('abort', onAbort, { once: true });
        try { return await run(nativeQuery); }
        catch (error) {
            if (error instanceof DatabaseReadRoleError) throw error;
            if (operationSignal?.aborted) throw new DatabaseReadRoleError(readRoleFailure('database_cancelled', 'cancelled'));
            throw new DatabaseReadRoleError(readRoleFailure('database_read_role_setup_failed', 'failed', postgresqlFailureCause(error)));
        } finally {
            operationSignal?.removeEventListener('abort', onAbort);
            if (cancellation) await cancellation.catch(() => {});
            if (operationSignal?.aborted) await close().catch(() => {});
        }
    });
    const prepare = async (role: string, nativeQuery: typeof query) => {
        const result = await nativeQuery(postgresqlReadRoleSchemas);
        const schemas = result.rows.map(row => {
            const name = row[0];
            if (typeof name !== 'string') throw new Error('PostgreSQL omitted schema metadata');
            return name;
        });
        return { schemas, plan: planDatabaseReadRoleSetup({ engine: 'postgresql', database: setup.database, role, schemas }) };
    };
    const verify = async (role: string, schemas: readonly string[] | null, nativeQuery: typeof query): Promise<DatabaseReadRoleVerificationResult> => {
        const result = await nativeQuery(postgresqlReadRoleProof(role, schemas));
        return result.rows[0]?.[0] === 't' ? { ok: true } : readRoleFailure('database_read_role_not_read_only');
    };
    return {
        normalizeStatementShape: sql => normalizePostgresqlStatement(sql).shape,
        execute: (input, operationSignal) => schedule(() => options.runOperation
            ? options.runOperation(() => execute(input, operationSignal), operationSignal)
            : execute(input, operationSignal)),
        prepareReadRole: (role, operationSignal) => readRoleOperation(operationSignal, async nativeQuery => (await prepare(role, nativeQuery)).plan),
        async setupReadRole(reviewed, operationSignal) {
            try {
                return await readRoleOperation(operationSignal, async nativeQuery => {
                    const { plan, schemas } = await prepare(reviewed.role, nativeQuery);
                    if (!matchesDatabaseReadRolePlan(reviewed, plan)) return readRoleFailure('database_read_role_plan_changed');
                    const credential = await postgresqlReadRolePassword();
                    const control = (text: string) => nativeQuery({ text, values: [] });
                    await control('BEGIN');
                    let committing = false;
                    try {
                        const [create, ...grants] = plan.statements;
                        await control(credential.statement(create!));
                        for (const statement of grants) await control(statement);
                        const proof = await verify(plan.role, schemas, nativeQuery);
                        if (!proof.ok) throw new DatabaseReadRoleError(proof);
                        operationSignal?.throwIfAborted();
                        committing = true;
                        await control('COMMIT');
                        return { ok: true, password: credential.password };
                    } catch (error) {
                        const cause = postgresqlFailureCause(error);
                        if (!closed) {
                            try { await query({ text: 'ROLLBACK', values: [] }); }
                            catch { await close().catch(() => {}); }
                        }
                        if (committing && (closed || operationSignal?.aborted || cause.source === 'transport')) {
                            return readRoleFailure('database_outcome_unknown', 'outcome_unknown', cause);
                        }
                        throw error;
                    }
                });
            } catch (error) {
                return error instanceof DatabaseReadRoleError ? error.failure : readRoleFailure('database_read_role_setup_failed');
            }
        },
        async verifyReadRole(operationSignal) {
            try { return await readRoleOperation(operationSignal, nativeQuery => verify(setup.currentUser, null, nativeQuery)); }
            catch (error) {
                return error instanceof DatabaseReadRoleError ? error.failure : readRoleFailure('database_read_role_setup_failed');
            }
        },
        close,
    };
}
