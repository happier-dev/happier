import type { DatabaseOperationResultV1 } from '@happier-dev/plugin-sdk/database';

/** Wrap a scheduled driver operation at the host's native effect boundary. */
export type DatabaseConnectionOperationRunner = (
    execute: () => Promise<DatabaseOperationResultV1>,
    signal?: AbortSignal,
) => Promise<DatabaseOperationResultV1>;

export type DatabaseConnection = Readonly<{
    engine: 'postgresql' | 'mysql' | 'sqlite';
    hostname: string;
    port?: number;
    database: string;
    username?: string;
    password?: string;
    options: Readonly<Record<string, string>>;
}>;

export class DatabaseConnectionUrlError extends Error {
    readonly code = 'invalid_database_connection_url';
    constructor() { super('The database connection URL is invalid'); this.name = 'DatabaseConnectionUrlError'; }
}

const engines = { 'postgres:': 'postgresql', 'postgresql:': 'postgresql', 'mysql:': 'mysql', 'mariadb:': 'mysql',
    'sqlite:': 'sqlite', 'file:': 'sqlite' } as const;

function connectionUrl(input: string): URL {
    try { return new URL(input); } catch { throw new DatabaseConnectionUrlError(); }
}

/** Scheme selection shares the dialect URL boundary; it never publishes credentials. */
export function databaseConnectionScheme(input: string): string {
    return connectionUrl(input).protocol.slice(0, -1);
}

/** Builtin association only; contributed schemes come from the enabled plugin catalogue. */
export function builtinDatabaseConnectionEngine(input: string): DatabaseConnection['engine'] | undefined {
    const protocol = connectionUrl(input).protocol;
    return Object.hasOwn(engines, protocol) ? engines[protocol as keyof typeof engines] : undefined;
}

function readConnectionUrl(input: string): { url: URL; connection: DatabaseConnection } {
    try {
        const url = connectionUrl(input);
        if (!Object.hasOwn(engines, url.protocol)) throw new DatabaseConnectionUrlError();
        const engine = engines[url.protocol as keyof typeof engines];
        const connection = { engine, hostname: url.hostname, ...(url.port ? { port: Number(url.port) } : {}),
            database: decodeURIComponent(engine === 'sqlite' ? url.pathname : url.pathname.replace(/^\//, '')),
            ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
            ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
            options: Object.fromEntries(url.searchParams),
        };
        return { url, connection };
    } catch { throw new DatabaseConnectionUrlError(); }
}

/** Private connection material; callers publish only the separately masked URL. */
export function parseDatabaseConnectionUrl(input: string): DatabaseConnection {
    return readConnectionUrl(input).connection;
}

/** Private native-adapter material; the platform owns conversion of this file URL to a path. */
export function sqliteDatabaseFileUrl(input: string): string {
    const { url, connection } = readConnectionUrl(input);
    if (connection.engine !== 'sqlite' || !url.pathname.startsWith('/')) throw new DatabaseConnectionUrlError();
    try {
        return new URL(`file:${url.href.slice(url.protocol.length)}`).toString();
    } catch { throw new DatabaseConnectionUrlError(); }
}

export function maskDatabaseConnectionUrl(input: string): string {
    const { url } = readConnectionUrl(input);
    url.username = ''; url.password = ''; url.hash = '';
    const names = [...url.searchParams.keys()];
    url.search = '';
    for (const name of names) url.searchParams.append(name, '[redacted]');
    return url.toString();
}

/** Private driver adapter material; never publish this credential-bearing URL. */
export function withDatabaseConnectionUrlOptions(input: string, overrides: Readonly<Record<string, string | null>>): string {
    const { url } = readConnectionUrl(input);
    for (const [name, value] of Object.entries(overrides)) {
        if (value === null) url.searchParams.delete(name);
        else url.searchParams.set(name, value);
    }
    return url.toString();
}

export type VerifiedDatabaseTls = Readonly<{ ca?: string }>;

/** Explicit TLS verification owns driver options; keep only the address and login in the URI. */
export function databaseConnectionUrlWithoutOptions(input: string): string {
    const { url } = readConnectionUrl(input);
    url.search = '';
    url.hash = '';
    return url.toString();
}

/** Replace the login with private material encoded once for the native driver. */
export function withDatabaseConnectionLogin(input: string, username: string, password: string): string {
    const { url } = readConnectionUrl(input);
    url.username = encodeURIComponent(username);
    url.password = encodeURIComponent(password);
    url.searchParams.delete('user');
    url.searchParams.delete('password');
    return url.toString();
}
