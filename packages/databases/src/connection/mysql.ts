import { createConnection, type ConnectionOptions } from 'mysql2';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import type { DatabaseOperationInputV1, DatabaseOperationResultV1 } from '@happier-dev/plugin-sdk/database';
import { statsOperationResultV1 } from '../stats.js';
import { DatabaseStatementError } from '../statement.js';
import { fitDatabaseOperationResult } from '../resultEnvelope.js';
import { databaseConnectionUrlWithoutOptions, parseDatabaseConnectionUrl, withDatabaseConnectionUrlOptions, type DatabaseConnectionOperationRunner, type VerifiedDatabaseTls } from '../connection.js';
import {
    executeMysqlOperation, mysqlFailureCause, MysqlOperationError, type MysqlCompiledStatement, type MysqlExecutionOptions,
    type MysqlNativeField, type MysqlNativeResult, type MysqlNativeValue,
} from '../mysql/index.js';
import { mysqlGeneratedReadPassword, mysqlManagedReadGrants, mysqlReadRoleSettings, mysqlReadRoleSettingsQuery, mysqlVerifyReadGrants } from '../mysql/readRoleSetup.js';
import {
    DatabaseReadRoleError, matchesDatabaseReadRolePlan, mysqlReadRoleAccount, planDatabaseReadRoleSetup, readRoleFailure,
    type DatabaseReadRoleConnection,
} from '../readRoleSetup.js';
export { mysqlFailureCause } from '../mysql/index.js';

export { mysqlCapabilities } from '../capabilities.js';

export interface MysqlConnection {
    execute(input: DatabaseOperationInputV1, signal?: AbortSignal): Promise<DatabaseOperationResultV1>;
    close(): Promise<void>;
}

/** mysql2 3.24.6 merges URI options over explicit false values. Remove those keys at the URL owner first. */
export function mysqlConnectionOptions(connectionString: string, tls?: VerifiedDatabaseTls): ConnectionOptions {
    const uri = tls ? databaseConnectionUrlWithoutOptions(connectionString) : withDatabaseConnectionUrlOptions(connectionString, {
        multipleStatements: null, decimalNumbers: null, nestTables: null, namedPlaceholders: null, debug: null,
    });
    return { uri, ...(tls ? { ssl: { rejectUnauthorized: true, verifyIdentity: true, ...(tls.ca === undefined ? {} : { ca: tls.ca }) } } : {}),
        multipleStatements: false, namedPlaceholders: false, nestTables: false, debug: false,
        supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false, dateStrings: true,
        jsonStrings: true, rowsAsArray: true, flags: ['FOUND_ROWS', '-MULTI_STATEMENTS'],
        // mysql2 normally parses GEOMETRY into JS numbers, losing its native binary representation.
        typeCast: (field, next) => field.type === 'GEOMETRY' ? field.buffer() : next() };
}

/** Runtime validation at the driver boundary; every internal operation receives an ordered native frame. */
export function mysqlNativeResult(result: unknown, fields: ReadonlyArray<{ name: string; columnType?: number; characterSet?: number }>): MysqlNativeResult {
    const columns: MysqlNativeField[] = fields.map(field => {
        if (typeof field.columnType !== 'number' || typeof field.characterSet !== 'number') throw new Error('MySQL omitted native field metadata');
        return { name: field.name, columnType: field.columnType, characterSet: field.characterSet };
    });
    if (Array.isArray(result)) {
        const rows: MysqlNativeValue[][] = result.map((row: unknown) => {
            if (!Array.isArray(row) || row.length !== columns.length) throw new Error('MySQL returned an unordered or misaligned native row');
            return row.map((value: unknown) => {
                if (value === null || typeof value === 'string' || typeof value === 'number' || Buffer.isBuffer(value)) return value;
                throw new Error('MySQL returned an unsupported native cell');
            });
        });
        return { fields: columns, rows };
    }
    if (typeof result === 'object' && result !== null && 'affectedRows' in result
        && ((typeof result.affectedRows === 'number' && Number.isSafeInteger(result.affectedRows) && result.affectedRows >= 0)
            || (typeof result.affectedRows === 'string' && /^\d+$/u.test(result.affectedRows)))) {
        return { fields: [], rows: [], affectedRows: result.affectedRows };
    }
    throw new Error('MySQL returned an unsupported native result');
}

/** One connection belongs to one workbench demand, or to the caller's standalone request. */
export async function openMysqlConnection(connectionString: string, signal?: AbortSignal, options: Readonly<{
    tls?: VerifiedDatabaseTls;
    runOperation?: DatabaseConnectionOperationRunner;
    openStream?: () => Promise<Readonly<{ stream: Duplex; close(): Promise<void> }>>;
}> = {}): Promise<MysqlConnection & DatabaseReadRoleConnection> {
    signal?.throwIfAborted();
    if (options.tls && options.openStream && isIP(parseDatabaseConnectionUrl(connectionString).hostname.replace(/^\[|\]$/gu, ''))) {
        // mysql2 3.24.6 uses SNI for an explicit identity on borrowed sockets. Its IP fallback needs a native TCP socket.
        throw new DatabaseReadRoleError(readRoleFailure('database_read_role_tls_hostname_required'));
    }
    const connectionOptions = mysqlConnectionOptions(connectionString, options.tls);
    const openNative = async () => {
        const transport = await options.openStream?.();
        try { return { core: createConnection({ ...connectionOptions, ...(transport ? { stream: transport.stream } : {}) }), transport }; }
        catch (error) { await transport?.close(); throw error; }
    };
    const { core, transport } = await openNative();
    const client = core.promise();
    let closed = false;
    let terminalError: unknown;
    let tail: Promise<unknown> = Promise.resolve();
    let activeRequest: Promise<unknown> | undefined;
    let closing: Promise<void> | undefined;
    const lifetime = new AbortController();
    const close = (): Promise<void> => {
        if (closing) return closing;
        closed = true;
        const pending = activeRequest;
        lifetime.abort();
        closing = (async () => {
            try {
                if (pending) {
                    if (terminalError) throw terminalError;
                    // mysql2 destroy() only ends the socket; MySQL keeps an active statement running.
                    // Keep that owned connection alive until KILL is delivered, so its ID cannot be reused.
                    let onEnd: () => void = () => {};
                    let ended = false;
                    const terminated = new Promise<void>(resolve => { onEnd = () => { ended = true; resolve(); }; core.once('end', onEnd); });
                    let borrowed: Awaited<ReturnType<typeof openNative>> | undefined;
                    try {
                        borrowed = await openNative();
                        const killer = borrowed.core;
                        killer.on('error', () => {});
                        await new Promise<void>((resolve, reject) => killer.connect(error => error ? reject(error) : resolve()));
                        if (!ended) {
                            if (terminalError) throw terminalError;
                            await killer.promise().query(`KILL CONNECTION ${core.threadId}`);
                        }
                        await pending.catch(() => {});
                        await terminated;
                    } finally {
                        core.removeListener('end', onEnd);
                        borrowed?.core.destroy();
                        await borrowed?.transport?.close();
                    }
                }
            } finally { core.destroy(); await transport?.close(); }
        })();
        return closing;
    };
    core.on('error', error => { terminalError = error; });
    const onConnectAbort = () => { void close().catch(() => {}); };
    signal?.addEventListener('abort', onConnectAbort, { once: true });
    const openingSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const race = async <T>(pending: Promise<T>, cancellation: AbortSignal): Promise<T> => {
        let onAbort: () => void = () => {};
        const aborted = new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(cancellation.reason);
            if (cancellation.aborted) onAbort();
            else cancellation.addEventListener('abort', onAbort, { once: true });
        });
        try { return await Promise.race([pending, aborted]); }
        finally { cancellation.removeEventListener('abort', onAbort); }
    };
    const request = async <T>(pending: Promise<T>, cancellation: AbortSignal): Promise<T> => {
        activeRequest = pending;
        try { return await race(pending, cancellation); }
        finally { if (activeRequest === pending) activeRequest = undefined; }
    };
    let lexical: MysqlExecutionOptions;
    let stats: Readonly<{ database: string; currentUser: string; databaseIdentity: string }> | undefined;
    try {
        await race(new Promise<void>((resolve, reject) => core.connect(error => error ? reject(error) : resolve())), openingSignal);
        const [native, fields] = await race(client.execute('SELECT VERSION(),@@SESSION.sql_mode,DATABASE(),CURRENT_USER(),@@hostname,@@port'), openingSignal);
        const frame = mysqlNativeResult(native, fields);
        const version = frame.rows[0]?.[0]; const mode = frame.rows[0]?.[1];
        if (typeof version !== 'string' || typeof mode !== 'string') throw new Error('MySQL omitted session metadata');
        if (/mariadb/iu.test(version)) throw new MysqlOperationError({ ok: false, status: 'unavailable', code: 'database_engine_unavailable', reason: 'MariaDB is not supported by the MySQL workbench dialect' });
        const modes = new Set(mode.split(','));
        lexical = { noBackslashEscapes: modes.has('NO_BACKSLASH_ESCAPES'), ansiQuotes: modes.has('ANSI_QUOTES') };
        const database = frame.rows[0]?.[2]; const currentUser = frame.rows[0]?.[3];
        const serverHostname = frame.rows[0]?.[4]; const serverPort = frame.rows[0]?.[5];
        if (typeof database === 'string' && typeof currentUser === 'string' && typeof serverHostname === 'string'
            && (typeof serverPort === 'string' || typeof serverPort === 'number')) {
            stats = { database, currentUser, databaseIdentity: JSON.stringify({ database, serverHostname, serverPort: String(serverPort) }) };
        }
        signal?.throwIfAborted();
    } catch (error) { await close(); throw error; }
    finally { signal?.removeEventListener('abort', onConnectAbort); }

    const execute = async (input: DatabaseOperationInputV1, operationSignal?: AbortSignal): Promise<DatabaseOperationResultV1> => {
        if (operationSignal?.aborted) return { ok: false, status: 'cancelled', code: 'database_cancelled' };
        if (closed || terminalError) return { ok: false, status: 'failed', code: 'database_connection_unavailable', reason: 'Reopen the database connection', ...(terminalError ? { cause: mysqlFailureCause(terminalError) } : {}) };
        const cancellation = operationSignal ? AbortSignal.any([operationSignal, lifetime.signal]) : lifetime.signal;
        const onAbort = () => { void close().catch(() => {}); };
        operationSignal?.addEventListener('abort', onAbort, { once: true });
        let transaction = false; let committing = false;
        const control = (sql: string) => request(client.query(sql), cancellation);
        const query = async (statement: MysqlCompiledStatement): Promise<MysqlNativeResult> => {
            const [native, fields] = await request(client.execute(statement.text, statement.values), cancellation);
            return mysqlNativeResult(native, fields ?? []);
        };
        const executionOptions: MysqlExecutionOptions = input.operation === 'stats.read' && stats ? { ...lexical, stats: {
            database: stats.database, intervalBasis: { databaseIdentity: stats.databaseIdentity,
                bindingKey: JSON.stringify({ target: input.target, databaseIdentity: stats.databaseIdentity, currentUser: stats.currentUser }),
                selectionKey: JSON.stringify(input.request) },
        } } : lexical;
        try {
            const write = input.operation === 'edits.apply' || (input.operation === 'statement.run' && input.mode === 'write')
                || (input.operation === 'statement.explain' && input.accessMode === 'write');
            await control(`SET SESSION transaction_read_only=${write ? '0' : '1'}`);
            await control(write ? 'START TRANSACTION' : 'START TRANSACTION READ ONLY');
            transaction = true;
            const result = fitDatabaseOperationResult(input, await executeMysqlOperation(input, query, executionOptions));
            cancellation.throwIfAborted();
            if (result.ok && !(input.operation === 'statement.explain' && input.accessMode === 'write')) {
                committing = true; await control('COMMIT');
            }
            else await control('ROLLBACK');
            transaction = false;
            return result;
        } catch (error) {
            if (cancellation.aborted) {
                try { await close(); }
                catch (cleanupError) {
                    const cause = mysqlFailureCause(cleanupError);
                    if (committing) return { ok: false, status: 'outcome_unknown', code: 'database_outcome_unknown', cause };
                    return { ok: false, status: 'failed', code: cause.source === 'engine' ? 'database_engine_error' : 'database_transport_error', cause };
                }
                return committing ? { ok: false, status: 'outcome_unknown', code: 'database_outcome_unknown', cause: mysqlFailureCause(error) }
                    : { ok: false, status: 'cancelled', code: 'database_cancelled' };
            }
            if (transaction && !closed) {
                try { await control('ROLLBACK'); }
                catch { await close(); }
            }
            if (committing && (closed || mysqlFailureCause(error).source === 'transport')) return { ok: false, status: 'outcome_unknown', code: 'database_outcome_unknown', cause: mysqlFailureCause(error) };
            if (error instanceof MysqlOperationError) return error.failure;
            if (error instanceof DatabaseStatementError) return { ok: false, status: 'failed', code: error.code, reason: error.reason };
            const cause = mysqlFailureCause(error);
            if (input.operation === 'stats.read' && executionOptions.stats
                && (cause.code === 'ER_TABLEACCESS_DENIED_ERROR' || cause.code === 'ER_COLUMNACCESS_DENIED_ERROR')) {
                return statsOperationResultV1('mysql', input.request,
                    { status: 'unavailable', reason: 'visibility_restricted' }, [], executionOptions.stats);
            }
            return { ok: false, status: 'failed', code: cause.source === 'engine' ? 'database_engine_error' : 'database_transport_error', cause };
        } finally { operationSignal?.removeEventListener('abort', onAbort); }
    };
    // mysql2 queues statements. Serialize complete transactions and role setup on the owned session.
    const schedule = <T>(run: () => Promise<T>): Promise<T> => {
        const pending = tail.then(run);
        tail = pending.catch(() => {});
        return pending;
    };
    const readRoleOperation = <T>(operationSignal: AbortSignal | undefined,
        run: (nativeQuery: (sql: string) => Promise<MysqlNativeResult>) => Promise<T>): Promise<T> => schedule(async () => {
        if (operationSignal?.aborted) throw new DatabaseReadRoleError(readRoleFailure('database_cancelled', 'cancelled'));
        if (closed || terminalError) throw new DatabaseReadRoleError(readRoleFailure('database_connection_unavailable'));
        const cancellation = operationSignal ? AbortSignal.any([operationSignal, lifetime.signal]) : lifetime.signal;
        const onAbort = () => { void close().catch(() => {}); };
        const nativeQuery = async (sql: string): Promise<MysqlNativeResult> => {
            cancellation.throwIfAborted();
            const [rows, fields] = await request(client.query(sql), cancellation);
            return mysqlNativeResult(rows, fields ?? []);
        };
        operationSignal?.addEventListener('abort', onAbort, { once: true });
        try { return await run(nativeQuery); }
        catch (error) {
            if (error instanceof DatabaseReadRoleError) throw error;
            if (cancellation.aborted) throw new DatabaseReadRoleError(readRoleFailure('database_cancelled', 'cancelled'));
            throw new DatabaseReadRoleError(readRoleFailure('database_read_role_setup_failed', 'failed', mysqlFailureCause(error)));
        } finally {
            operationSignal?.removeEventListener('abort', onAbort);
            if (cancellation.aborted) await close().catch(() => {});
        }
    });
    const selectedDatabase = (): string => {
        if (!stats) throw new DatabaseReadRoleError(readRoleFailure('database_read_role_database_unavailable'));
        return stats.database;
    };
    const prepare = async (role: string, nativeQuery: (sql: string) => Promise<MysqlNativeResult>) => {
        const database = selectedDatabase();
        const settings = mysqlReadRoleSettings(await nativeQuery(mysqlReadRoleSettingsQuery));
        if (settings.mandatoryRoles.length > 0) throw new DatabaseReadRoleError(readRoleFailure('database_read_role_mandatory_roles'));
        return { plan: planDatabaseReadRoleSetup({ engine: 'mysql', database, role, partialRevokes: settings.partialRevokes }),
            partialRevokes: settings.partialRevokes };
    };
    return {
        execute: (input, operationSignal) => schedule(() => options.runOperation
            ? options.runOperation(() => execute(input, operationSignal), operationSignal)
            : execute(input, operationSignal)),
        prepareReadRole: (role, operationSignal) => readRoleOperation(operationSignal, async nativeQuery => (await prepare(role, nativeQuery)).plan),
        async setupReadRole(reviewed, operationSignal) {
            try {
                return await readRoleOperation(operationSignal, async nativeQuery => {
                    const { plan, partialRevokes } = await prepare(reviewed.role, nativeQuery);
                    if (!matchesDatabaseReadRolePlan(reviewed, plan)) return readRoleFailure('database_read_role_plan_changed');
                    operationSignal?.throwIfAborted();
                    const [create, grant, unlock] = plan.statements;
                    let locked = false;
                    let unlocking = false;
                    try {
                        const generated = await nativeQuery(create!);
                        locked = true;
                        const password = mysqlGeneratedReadPassword(generated, plan.role);
                        if (!password) return readRoleFailure('database_read_role_setup_incomplete');
                        await nativeQuery(grant!);
                        const proof = await nativeQuery(`SHOW GRANTS FOR ${mysqlReadRoleAccount(plan.role)}`);
                        if (!mysqlManagedReadGrants(proof, plan.role, plan.database, partialRevokes)) {
                            return readRoleFailure('database_read_role_setup_incomplete');
                        }
                        unlocking = true;
                        await nativeQuery(unlock!);
                        return { ok: true, password };
                    } catch (error) {
                        const cause = mysqlFailureCause(error);
                        if ((!locked || unlocking) && (closed || cause.source === 'transport')) {
                            return readRoleFailure('database_outcome_unknown', 'outcome_unknown', cause);
                        }
                        if (locked) return readRoleFailure('database_read_role_setup_incomplete', 'failed', cause);
                        throw error;
                    }
                });
            } catch (error) {
                return error instanceof DatabaseReadRoleError ? error.failure : readRoleFailure('database_read_role_setup_failed');
            }
        },
        async verifyReadRole(operationSignal) {
            try {
                return await readRoleOperation(operationSignal, async nativeQuery => {
                    const database = selectedDatabase();
                    const { partialRevokes } = mysqlReadRoleSettings(await nativeQuery(mysqlReadRoleSettingsQuery));
                    const proof = await nativeQuery('SHOW GRANTS');
                    return mysqlVerifyReadGrants(proof, database, partialRevokes, lexical)
                        ? { ok: true } : readRoleFailure('database_read_role_not_read_only');
                });
            } catch (error) {
                return error instanceof DatabaseReadRoleError ? error.failure : readRoleFailure('database_read_role_setup_failed');
            }
        },
        close,
    };
}
