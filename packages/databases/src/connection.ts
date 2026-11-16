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

function readConnectionUrl(input: string): { url: URL; connection: DatabaseConnection } {
    try {
        const url = new URL(input);
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
