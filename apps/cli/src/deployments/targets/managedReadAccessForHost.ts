import { DatabaseReadRoleError, databaseConnectionUrlWithoutOptions, generateDatabaseReadRoleName, parseDatabaseConnectionUrl,
    withDatabaseConnectionLogin, type DatabaseReadRolePlan, type DatabaseReadRoleSetupResult,
    type DatabaseReadRoleVerificationResult, type VerifiedDatabaseTls } from '@happier-dev/databases';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk/errors';
import type {
    DatabaseOperationInputV1, DatabaseOperationResultV1, DatabaseReadAccessCreateInputV1, DatabaseReadAccessSetupResultV1,
} from '@happier-dev/plugin-sdk/database';

type Engine = 'postgresql' | 'mysql';
type Endpoint = Readonly<{ connectionString: string }> & VerifiedDatabaseTls;
type Secret = Readonly<{ ref: string; resourceRevision: number }>;
type Role = 'readOnlyPassword' | 'write';
type Configured = Extract<DatabaseReadAccessSetupResultV1, { status: 'configured' }>;
type Connection = Readonly<{
    engine: Engine;
    execute(input: DatabaseOperationInputV1, signal?: AbortSignal): Promise<DatabaseOperationResultV1>;
    close(): Promise<void>;
    verifyReadRole(signal?: AbortSignal): Promise<DatabaseReadRoleVerificationResult>;
    prepareReadRole(role: string, signal?: AbortSignal): Promise<DatabaseReadRolePlan>;
    setupReadRole(plan: DatabaseReadRolePlan, signal?: AbortSignal): Promise<DatabaseReadRoleSetupResult>;
}>;

type Ports = Readonly<{
    engine: Engine;
    database: string;
    signal: AbortSignal;
    readEndpoint(): Promise<Endpoint>;
    readBinding(role: Role): Promise<string | undefined>;
    readSavedSecret(secret: Secret): Promise<string>;
    saveSecret(value: string): Promise<Secret>;
    setBinding(secret: Secret): Promise<void>;
    open(engine: Engine, privateUrl: string, tls: VerifiedDatabaseTls, signal: AbortSignal): Promise<Connection>;
}>;

const refuse = (code: string): never => { throw new PluginError({ code }); };
const configured: Configured = Object.freeze({ ok: true, status: 'configured' });

function portFor(target: ReturnType<typeof parseDatabaseConnectionUrl>): number {
    return target.port ?? (target.engine === 'postgresql' ? 5432 : 3306);
}

function parse(value: string, code: string): ReturnType<typeof parseDatabaseConnectionUrl> {
    try { return parseDatabaseConnectionUrl(value); }
    catch { return refuse(code); }
}

/** The managed attachment selects one endpoint and the existing role binding owns all credential custody. */
export function createManagedReadAccessForHost(ports: Ports) {
    const readEndpoint = async () => {
        const endpoint = await ports.readEndpoint().catch(() => {
            ports.signal.throwIfAborted();
            return refuse('database_connection_unavailable');
        });
        const address = parse(endpoint.connectionString, 'target_mismatch');
        if (address.engine !== ports.engine || address.database !== ports.database || !address.hostname
            || address.username || address.password) return refuse('target_mismatch');
        return { ...endpoint, address, connectionString: databaseConnectionUrlWithoutOptions(endpoint.connectionString) };
    };
    const open = async (selected: Awaited<ReturnType<typeof readEndpoint>>, login: string, role: Role) => {
        const unavailable = role === 'write' ? 'database_connection_unavailable' : 'read_role_invalid';
        const supplied = parse(login, unavailable);
        const { address, connectionString, ca } = selected;
        if (supplied.engine !== address.engine || supplied.database !== address.database
            || supplied.hostname.toLowerCase() !== address.hostname.toLowerCase() || portFor(supplied) !== portFor(address)) {
            return refuse('target_mismatch');
        }
        if (!supplied.username || !supplied.password) return refuse(unavailable);
        try {
            return await ports.open(ports.engine, withDatabaseConnectionLogin(connectionString, supplied.username, supplied.password),
                ca ? { ca } : {}, ports.signal);
        } catch {
            ports.signal.throwIfAborted();
            return refuse(unavailable);
        }
    };
    const checked = async (selected: Awaited<ReturnType<typeof readEndpoint>>, login: string) => {
        const connection = await open(selected, login, 'readOnlyPassword');
        try {
            const result = await connection.verifyReadRole(ports.signal);
            if (result.ok) return connection;
        } catch {
            // Native database exceptions may contain login material.
        }
        await connection.close().catch(() => {});
        ports.signal.throwIfAborted();
        return refuse('read_role_invalid');
    };

    return {
        async openRead(): Promise<Connection> {
            const login = await ports.readBinding('readOnlyPassword');
            if (!login) return refuse('read_role_setup_required');
            return await checked(await readEndpoint(), login);
        },
        async attach(secret: Secret): Promise<Configured> {
            const selected = await readEndpoint();
            const connection = await checked(selected, await ports.readSavedSecret(secret));
            await connection.close().catch(() => {});
            await ports.setBinding(secret);
            return configured;
        },
        async create(request: Omit<Extract<DatabaseReadAccessCreateInputV1, { mode: 'preview' }>, 'target'>
            | Omit<Extract<DatabaseReadAccessCreateInputV1, { mode: 'apply' }>, 'target'>): Promise<DatabaseReadAccessSetupResultV1> {
            const selected = await readEndpoint();
            const login = await ports.readBinding('write');
            if (!login) return refuse('write_connection_setup_required');
            const writer = await open(selected, login, 'write');
            const role = request.mode === 'preview' ? generateDatabaseReadRoleName() : request.role;
            let password: string;
            try {
                if (request.mode === 'preview') {
                    const plan = await writer.prepareReadRole(role, ports.signal);
                    return { ok: true, status: 'review', role: plan.role, statements: plan.statements };
                }
                const setup = await writer.setupReadRole({ engine: ports.engine, database: ports.database,
                    role, statements: request.statements }, ports.signal);
                if (!setup.ok) return refuse(setup.code);
                password = setup.password;
            } catch (error) {
                ports.signal.throwIfAborted();
                if (isPluginError(error)) throw error;
                if (error instanceof DatabaseReadRoleError) return refuse(error.failure.code);
                return refuse('database_read_role_setup_failed');
            } finally {
                await writer.close().catch(() => {});
            }
            try {
                await ports.setBinding(await ports.saveSecret(withDatabaseConnectionLogin(selected.connectionString, role, password)));
            } catch {
                throw new PluginError({ code: 'database_read_role_binding_failed', details: { role },
                    message: 'The database login was created, but its Saved Secret binding did not complete.', effectAttempted: true });
            }
            return configured;
        },
    };
}
